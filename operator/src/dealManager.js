// TODO: Move path to config and reference Github
const SaladContract = require('../../build/smart_contracts/Salad.json');
const {CoinjoinClient} = require('@salad/client');
const debug = require('debug')('operator:deal-manager');

const DEAL_STATUS = {
    NEW: 0,
    EXECUTABLE: 1,
    EXECUTED: 2,
};
// TODO: Definitely move to config and pass to frontend
const DEPOSIT_AMOUNT = '0.01';

/**
 * @typedef {Object} Deal
 * @property {string} dealId - The Deal Identifier
 * @property {string} depositAmount - The deposit amount in wei
 * @property {string[]} participants - A list of participants Ethereum addresses
 * @property {string} nonce - The deal nonce (operator tx count)
 * @property {number} status - A list of participants Ethereum addresses
 * @property {string|null} _tx - The `createDeal` Ethereum transaction hash
 * @property {string|null} taskId - The Enigma Task Id
 */

/**
 * @typedef {Object} Deposit
 * @property {string} sender - The depositor Ethereum address
 * @property {string} amount - The deposit amount in wei
 * @property {string} encRecipient - The encrypted recipient Ethereum address
 * @property {string} pubKey - The user generated pubKey
 * @property {string} signature - The deposit payload signature
 */

/**
 * @typedef {Object} EncryptionPubKey
 * @property {string} encryptedOutput - The encrypted output string
 * @property {string} userPrivateKey - The private key that decrypts the output
 * @property {string} workerPubKey - The the worker public key to decrypt the output
 * @property {string} taskId - The TaskId of the task that fetched the public key
 */
/**
 * Coordinate deal execution
 */
class DealManager {
    constructor(web3, scClient, contractAddr, store, gasValues = {
        createDeal: 4712388,
        fetchPubKey: 4712388,
    }) {
        this.web3 = web3;
        this.scClient = scClient;
        this.store = store;
        this.contract = new this.web3.eth.Contract(SaladContract['abi'], contractAddr, {from: this.web3.eth.defaultAccount});
        this.gasValues = gasValues;
    }

    /**
     * Get deposits amount from deposits or default value
     * @param {Web3} web3
     * @param {Array<Deposit>} deposits
     */
    static getDepositAmount(web3, deposits) {
        let depositAmount = web3.utils.toWei(DEPOSIT_AMOUNT, 'ether');
        for (let deposit of deposits) {
            if (deposit.amount !== depositAmount) {
                throw new Error(`Mismatching deposit amount: ${deposit.amount}`);
            }
        }
        return depositAmount;
    }

    /**
     * Verify that the specified deposit amount is locked on Ethereum
     * @param {string} sender - The depositor's Ethereum address
     * @param {string} amount - The deposit amount in wei
     * @returns {Promise<boolean>}
     */
    async verifyDepositAmountAsync(sender, amount) {
        debug('Verifying balance for deposit', sender, amount);
        const account = this.web3.utils.toChecksumAddress(sender);
        const balance = await this.contract.methods.getParticipantBalance(account).call();
        debug('Comparing balance with amount', balance, amount);
        const senderBalance = this.web3.utils.toBN(balance);
        const depositAmount = this.web3.utils.toBN(amount);
        if (senderBalance.lt(depositAmount)) {
            throw new Error(`Sender ${sender} balance (in wei) less than deposit: ${senderBalance} < ${depositAmount}`)
        }
    }

    /**
     * Verify and store the specified deposit
     * @param {string} sender - The depositor's Ethereum address
     * @param {string} amount - The deposit amount in wei
     * @param {string} pubKey - The user pubKey
     * @param {string} encRecipient - The recipient's encrypted Ethereum address
     * @param {string} signature - The deposit payload signature
     * @returns {Promise<Deposit>}
     */
    async registerDepositAsync(sender, amount, pubKey, encRecipient, signature) {
        debug('Registering deposit', sender, amount, encRecipient);
        await this.verifyDepositAmountAsync(sender, amount);
        const deposit = {sender, amount, pubKey, encRecipient, signature};
        await this.store.insertDepositAsync(deposit);
        return deposit;
    }

    /**
     * Create new Deal on Ethereum
     * @param {string} depositAmount
     * @param {Array<Deposit>} deposits - The Deposits linked to the Deal
     * @param {Object} opts - Ethereum tx options
     * @returns {Promise<Deal>}
     */
    async createDealAsync(depositAmount, deposits) {
        const pendingDeals = await this.store.queryDealsAsync(DEAL_STATUS.EXECUTABLE);
        if (pendingDeals.length > 0) {
            debug('The executable deals', pendingDeals);
            throw new Error('Cannot creating a new deal until current deal is executed');
        }
        debug('Creating deal with deposits', deposits);
        /** @type string[] */
        const participants = deposits.map((deposit) => deposit.sender);
        const sender = this.scClient.getOperatorAccount();
        const nonce = (await this.web3.eth.getTransactionCount(sender)).toString();
        debug('The nonce', nonce);
        const dealIdMessage = CoinjoinClient.generateDealIdMessage(this.web3, depositAmount, participants, sender, nonce);
        const dealId = this.web3.utils.soliditySha3({
            t: 'bytes',
            v: this.web3.utils.bytesToHex(dealIdMessage),
        });
        /** @type Deal */
        const deal = {dealId, depositAmount, participants, nonce, status: DEAL_STATUS.NEW, _tx: null, taskId: null};
        await this.store.insertDealAsync(deal, participants);
        const receipt = await this.contract.methods.newDeal(depositAmount, participants, nonce).send({
            gas: this.gasValues.createDeal,
        });
        const receiptDealId = receipt.events.NewDeal.returnValues._dealId;
        if (receiptDealId !== dealId) {
            throw new Error(`DealId in receipt does not match generated value ${receiptDealId} !== ${dealId}`);
        }
        deal._tx = receipt.transactionHash;
        deal.status = DEAL_STATUS.EXECUTABLE;
        await this.store.updateDealAsync(deal);
        return deal;
    }

    /**
     * Verify on-chain balance of locally stored fillable deposits and discard if too low
     * @returns {Promise<Array<Deposit>>}
     */
    async balanceFillableDepositsAsync(minimumAmount = 0) {
        let deposits = await this.store.queryFillableDepositsAsync(minimumAmount);
        debug('Verifying balance for deposits', deposits);
        let hasChanged = false;
        for (const deposit of deposits) {
            try {
                // Discard the deposit if the balance is withdrawn
                await this.verifyDepositAmountAsync(deposit.sender, deposit.amount);
            } catch (e) {
                debug('Discarding invalid deposit', e.message);
                hasChanged = true;
                await this.store.discardDepositAsync(deposit);
            }
        }
        if (hasChanged) {
            deposits = await this.store.queryFillableDepositsAsync(minimumAmount);
            debug('The deposits after change', deposits);
        }
        return deposits;
    }

    /**
     * Execute pending Deal
     *   1- Send an Enigma tx with the `dealId` and `encRecipients`
     *   2- Enigma decrypts and shuffles the recipient Ethereum addresses
     *   3- Enigma calls the `executeDeal` method of the Ethereum contract
     *   4- Ethereum contract verifies the Enigma signature and distribute the deposits
     * @param {Deal} deal - The executable deal
     * @param {Object} taskRecordOpts
     * @returns {Promise<void>}
     */
    async executeDealAsync(deal, taskRecordOpts) {
        const {depositAmount, nonce} = deal;
        const deposits = await this.store.getDepositAsync(deal.dealId);
        const chainId = await this.web3.eth.net.getId();
        const task = await this.scClient.executeDealAsync(depositAmount, deposits, nonce, chainId, taskRecordOpts);
        deal.taskId = task.taskId;
        deal.status = DEAL_STATUS.EXECUTED;
        await this.store.updateDealAsync(deal);
        deal._tx = task.transactionHash;
        // Updating the local last mix block number to be in sync with the smart contract
        // And avoid triggering deals too early
        const blockNumber = await this.contract.methods.lastExecutionBlockNumber().call();
        await this.store.setLastMixBlockNumber(blockNumber);
    }

    /**
     * Verify the deposits on Enigma similarity to `executeDeal` but without transferring funds
     * @param {string} amount
     * @param {Array<Deposit>} deposits
     * @param {Object} taskRecordOpts
     * @returns {Promise<void>}
     */
    async verifyDepositsAsync(amount, deposits, taskRecordOpts) {
        const chainId = await this.web3.eth.net.getId();
        const task = await this.scClient.verifyDepositsAsync(amount, deposits, chainId, taskRecordOpts);
        debug('The verify deposit task', task);
    }

    /**
     * Resetting the last mix block number regardless of task status
     * All deposits received after current block will be included in the next Deal
     * @returns {Promise<void>}
     */
    async updateLastMixBlockNumberAsync() {
        const blockNumber = await this.web3.eth.getBlockNumber();
        await this.store.setLastMixBlockNumber(blockNumber.toString());
    }

    /**
     * Get the block number of the last mix event (either deal execution or quorum not reached)
     * This is a reference point for the next mix event
     * @returns {Promise<string>}
     */
    async getLastMixBlockNumberAsync() {
        let blockNumber = await this.store.fetchLastMixBlockNumber();
        if (blockNumber === null) {
            blockNumber = await this.contract.methods.lastExecutionBlockNumber().call();
            await this.store.setLastMixBlockNumber(blockNumber);
        }
        return blockNumber;
    }

    /**
     * Get the number of blocks left until mixing
     * @returns {Promise<number>}
     */
    async getBlocksUntilMixAsync() {
        const blockNumber = await this.web3.eth.getBlockNumber();
        debug('The block', blockNumber);
        const lastExecutionBlockNumber = await this.getLastMixBlockNumberAsync();
        const dealIntervalInBlocks = await this.contract.methods.dealIntervalInBlocks().call();
        const countdown = (parseInt(lastExecutionBlockNumber) + parseInt(dealIntervalInBlocks)) - parseInt(blockNumber);
        debug(lastExecutionBlockNumber, '+', dealIntervalInBlocks, '-', blockNumber, '=', countdown);
        return countdown;
    }
}

module.exports = {DealManager, DEAL_STATUS};
