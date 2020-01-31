require('dotenv').config();
const {CoinjoinClient} = require('@salad/client');
const {startServer} = require('@salad/operator');
const {expect} = require('chai');
const {utils} = require('enigma-js/node');
const {mineUntilDeal, mineBlock} = require('@salad/operator/src/ganacheUtils');
const debug = require('debug')('test');
const Web3 = require('web3');
const {Store, configureWeb3Account} = require("@salad/operator");
const {QUORUM_UPDATE} = require("@salad/client").actions;

const {DEALS_COLLECTION, DEPOSITS_COLLECTION, CACHE_COLLECTION} = require('@salad/operator/src/store');

const DEPOSIT_AMOUNT = '0.01';
describe('Salad', () => {
    let server;
    let salad;
    let opts;
    let web3Utils;
    let accounts;
    let saladContractAddr;
    let store;
    let enigmaContract;
    const threshold = parseInt(process.env.PARTICIPATION_THRESHOLD);
    const anonSetSize = threshold;
    const ethHost = process.env.ETH_HOST || 'localhost';
    const ethPort = process.env.ETH_PORT || '9545';
    const provider = new Web3.providers.HttpProvider('http://'+ethHost+':'+ethPort);
    const web3 = new Web3(provider);
    before(async () => {
        store = new Store();
        await store.initAsync();
        const scAddr = await store.fetchSecretContractAddr();
        saladContractAddr = await store.fetchSmartContractAddr();
        await store.closeAsync();

        const enigmaUrl = `http://${process.env.ENIGMA_HOST}:${process.env.ENIGMA_PORT}`;
        await configureWeb3Account(web3);
        server = await startServer(web3, enigmaUrl, saladContractAddr, scAddr, threshold);

        // Truncating the database
        await server.store.truncate(DEPOSITS_COLLECTION);
        await server.store.truncate(DEALS_COLLECTION);
        await server.store.truncate(CACHE_COLLECTION);

        enigmaContract = server.dealManager.scClient.enigma.enigmaContract;
        const operatorUrl = `ws://localhost:${process.env.WS_PORT}`;
        salad = new CoinjoinClient(operatorUrl, web3);
        // Always shutdown the WS server when tests end
        process.on('SIGINT', async () => {
            debug('Caught interrupt signal, shutting down WS server');
            await salad.shutdownAsync();
            await server.shutdownAsync();
            process.exit();
        });
        // Convenience shortcuts
        web3Utils = web3.utils;
        accounts = salad.accounts;
        // Default options of client-side transactions
        opts = {
            gas: 4712388,
        };
        debug('Environment initialized');
    });

    let pubKey;
    it('should fetch and cache the encryption pub key', async () => {
        // TODO: Consider loading the enc key in init process
        await server.loadEncryptionPubKeyAsync();
        await utils.sleep(300);
        await salad.initAsync();
        expect(salad.pubKeyData).to.not.be.null;
        expect(salad.keyPair).to.not.be.null;
        pubKey = salad.keyPair.publicKey;
    }).timeout(60000); // Giving more time because fetching the pubKey

    let recipients = [];
    let recipientInitialBalances = [];
    it('should assign recipient accounts and balances', async () => {
        // Starting the recipients in the middle of the account stack
        // TODO: Test with larger account stacks
        for (let i = 6; i < 6 + anonSetSize; i++) {
            const recipient = salad.accounts[i];
            recipients[i] = recipient;
            recipientInitialBalances[i] = await web3.eth.getBalance(recipient);
        }
    });

    let amount;
    it('should have a valid block countdown', async () => {
        await server.refreshBlocksUntilDeal();
        await utils.sleep(300);
        debug('The block countdown', salad.blockCountdown);
        expect(salad.blockCountdown).to.be.above(0);
        amount = web3Utils.toWei(DEPOSIT_AMOUNT);
    });

    it('should have an initial quorum of 0', async () => {
        expect(salad.quorum).to.equal(0);
    });

    async function makeDeposit(depositIndex) {
        let sender;
        let encRecipient;
        let signature;
        debug(`Make deposit ${depositIndex} on Ethereum`);
        sender = salad.accounts[depositIndex];
        const receipt = await salad.makeDepositAsync(sender, amount, opts);
        expect(receipt.status).to.equal(true);

        debug(`Encrypt deposit ${depositIndex}`);
        const recipientIndex = depositIndex + 5;
        const recipient = salad.accounts[recipientIndex];
        encRecipient = await salad.encryptRecipientAsync(recipient);
        const encRecipientBytes = web3.utils.hexToBytes(`0x${encRecipient}`);
        debug('The enc recipient bytes', encRecipientBytes, 'length', encRecipientBytes.length);
        // TODO:  Verifying the decrypted recipient locally
        // const pubKey = salad.getPlaintextPubKey();
        // const {privateKey} = salad.keyPair;
        // const derivedKey = utils.getDerivedKey(pubKey, privateKey);
        // const plaintextRecipient = utils.decryptMessage(derivedKey, encRecipient);
        // expect(web3.utils.toChecksumAddress(`0x${plaintextRecipient}`)).to.equal(recipient);

        debug(`Sign deposit ${depositIndex} payload`);
        signature = await salad.signDepositMetadataAsync(sender, amount, encRecipient, pubKey);
        debug('The signature', signature);
        const sigBytes = web3Utils.hexToBytes(signature);
        debug('The signature length', sigBytes.length, sigBytes);
        expect(sigBytes.length).to.equal(65);

        debug(`Submit signed deposit ${depositIndex} payload`);
        debug('Testing deposit submit with signature', signature);
        const result = await salad.submitDepositMetadataAsync(sender, amount, encRecipient, pubKey, signature);
        expect(result).to.equal(true);
    }

    async function makeDeposits(nbDeposits) {
        return new Promise((resolve) => {
            for (let i = 0; i < nbDeposits; i++) {
                const depositIndex = i + 1;
                it(`should submit deposit ${depositIndex}`, async () => {
                    await makeDeposit(depositIndex);
                }).timeout(6000);

                it(`should fail to withdraw ${depositIndex} before expiry`, async () => {
                    try {
                        await salad.withdraw(salad.accounts[depositIndex], opts);
                    } catch (e) {
                        expect(e.message).to.include('Deposit not yet available for withdrawal');
                        return;
                    }
                    expect.fail('Withdrawal should not succeed until deposit expiry');
                });
            }

            it('should verify that the submitted deposits are fillable', async () => {
                // Quorum should be N after deposits
                // expect(salad.quorum).to.equal(nbDeposits);
                const {deposits} = await salad.fetchFillableDepositsAsync();
                expect(deposits.length).to.equal(nbDeposits);
                resolve(true);
            }).timeout(6000);
        });
    }

    async function orchestrateDeal(anonSetSize) {
        const quorumReached = makeDeposits(anonSetSize);
        let lastDepositBlockNumber;
        let dealPromise;
        let executedDealPromise;
        it('should mine blocks until the deal interval', async () => {
            await quorumReached;
            lastDepositBlockNumber = await web3.eth.getBlockNumber();
            await mineUntilDeal(web3, server);
            // Catching the deal created event
            dealPromise = new Promise((resolve) => {
                salad.onDealCreated((deal) => resolve(deal));
            });
            executedDealPromise = new Promise((resolve) => {
                salad.onDealExecuted((deal) => resolve(deal));
            });
            await server.handleDealExecutionAsync();
        }).timeout(120000); // Give enough time to execute the deal on Enigma

        it('should verify that a deal was created since the threshold is reached', async () => {
            const deal = await dealPromise;
            debug('Created deal', deal);
            const blockNumber = await web3.eth.getBlockNumber();
            debug('The block number after deal creation', blockNumber);
            // Quorum should be reset to 0 after deal creation
            expect(salad.quorum).to.equal(0);
        });

        it('should verify the deal execution', async () => {
            const {deal} = await executedDealPromise;
            // await utils.sleep(300);
            debug('Executed deal', deal);
            const distributeReceipts = await salad.contract.getPastEvents('Distribute', {
                filter: {},
                fromBlock: lastDepositBlockNumber,
                toBlock: 'latest'
            });
            debug('Distributed event receipts', distributeReceipts);
            expect(distributeReceipts.length).to.equal(1);
            for (const r of distributeReceipts[0].returnValues._recipients) {
                expect(recipients).to.include(r);
            }
            // TODO: `receipts.length === 0` in the CI, passes locally
            // const receipts = await enigmaContract.getPastEvents('ReceiptVerified', {
            //     filter: {},
            //     fromBlock: lastDepositBlockNumber,
            //     toBlock: 'latest'
            // });
            // debug('Distributed event receipts', receipts);
            // expect(receipts.length).to.equal(1);
            // const {gasUsed, optionalEthereumContractAddress} = receipts[0].returnValues;
            // expect(optionalEthereumContractAddress).to.equal(saladContractAddr);
            // debug('The ENG gas used with', anonSetSize, 'participants:', gasUsed);
            // 3 participants gas used: 71787720
            // 3 participants gas used: 71661357
            // 4 participants gas used: 94435916
            // Per participant: ~23000000
            // Base : 3000000
            // const baseGasUnits = 3000000;
            // const gasUnitsPerParticipant = 24000000;
            // const estimatedGasUnits = baseGasUnits + (anonSetSize * gasUnitsPerParticipant);
            // expect(estimatedGasUnits).to.be.greaterThan(parseInt(gasUsed));

            const receiptFailed = await enigmaContract.getPastEvents('ReceiptFailed', {
                filter: {},
                fromBlock: lastDepositBlockNumber,
                toBlock: 'latest'
            });
            debug('Failed receipts', receiptFailed);
            expect(receiptFailed.length).to.equal(0);

            const receiptsFailedEth = await enigmaContract.getPastEvents('ReceiptFailedETH', {
                filter: {},
                fromBlock: lastDepositBlockNumber,
                toBlock: 'latest'
            });
            debug('Failed ETH receipts', receiptsFailedEth);
            expect(receiptsFailedEth.length).to.equal(0);

            const deals = await salad.findDealsAsync(2);
            expect(deals.findIndex(d => d.dealId === deal.dealId)).to.not.equal(-1);
            // Quorum should be reset to 0 after deal creation
            expect(salad.quorum).to.equal(0);
            const blockNumber = await web3.eth.getBlockNumber();
            const lastExecutionBlockNumber = await server.dealManager.contract.methods.lastExecutionBlockNumber().call();
            expect(blockNumber).to.equal(parseInt(lastExecutionBlockNumber));
        });

        for (let i = 0; i < anonSetSize; i++) {
            const depositIndex = i + 1;
            it(`should verify that deposit ${depositIndex} balance is 0 (has been distributed)`, async () => {
                const sender = salad.accounts[depositIndex];
                debug('Verifying balance for sender', sender);
                const balance = await server.dealManager.contract.methods.balances(sender).call();
                debug('The balance', balance);
                expect(balance[0]).to.equal('0');
            });
            const recipientIndex = depositIndex + 5;
            it(`should verify recipient ${recipientIndex} balance`, async () => {
                await mineBlock(web3);
                const recipient = salad.accounts[recipientIndex];
                debug('Verifying balance for recipient', recipient);
                const balance = await web3.eth.getBalance(recipient, 'latest');
                const initialBalance = recipientInitialBalances[recipientIndex];
                const payment = web3.utils.toBN(balance).sub(web3.utils.toBN(initialBalance)).toString();
                expect(payment).to.equal(amount);
                recipientInitialBalances[recipientIndex] = balance;
            });
        }
    }

    const firstDealExecuted = orchestrateDeal(anonSetSize);
    it('should finalize the first deal execution', async () => {
        await firstDealExecuted;
    });

    const anonSetSizeUnderThreshold = threshold - 1;
    const partialQuorumDepositsSubmitted = makeDeposits(anonSetSizeUnderThreshold);
    it('should mine blocks until deal without reaching the quorum', async () => {
        await partialQuorumDepositsSubmitted;
        await mineUntilDeal(web3, server);
        // Catching the quorum not reached event
        const quorumNotReachedPromise = new Promise((resolve) => {
            salad.onQuorumNotReached(() => resolve(true));
        });
        await server.handleDealExecutionAsync();
        expect(await quorumNotReachedPromise).to.equal(true);
    }).timeout(120000); // Give enough time to execute the deal on Enigma

    for (let i = 0; i < anonSetSizeUnderThreshold; i++) {
        const depositIndex = i + 1;
        it(`should withdraw ${depositIndex} after expiry`, async () => {
            const receipt = await salad.withdraw(salad.accounts[depositIndex], opts);
            expect(receipt.status).to.equal(true);
        });
    }

    it('should verify that deposits withdrawn are no longer in store', async () => {
        const action = await server.getQuorumAsync();
        server.ee.emit(QUORUM_UPDATE, action.payload.quorum);
        await utils.sleep(300);
        expect(salad.quorum).to.equal(0);
        debug('');
    });

    const secondDealExecuted = orchestrateDeal(anonSetSize);
    it('should finalize the second deal execution', async () => {
        await secondDealExecuted;
    });

    it('should mine blocks until deal without reaching the quorum (empty deposits)', async () => {
        await mineUntilDeal(web3, server);
        // Catching the quorum not reached event
        const quorumNotReachedPromise = new Promise((resolve) => {
            salad.onQuorumNotReached(() => resolve(true));
        });
        // Calling here to verify that the deposits are empty
        const deposits = await server.dealManager.balanceFillableDepositsAsync();
        expect(deposits.length).to.equal(0);
        await server.handleDealExecutionAsync();
        expect(await quorumNotReachedPromise).to.equal(true);
    }).timeout(120000); // Give enough time to execute the deal on Enigma
});
