const fs = require('fs');
const path = require('path');
const Web3 = require('web3');
const dotenv = require('dotenv');
const Mixer = artifacts.require('Mixer.sol');
const {Enigma, utils, eeConstants} = require('enigma-js/node');

dotenv.config({path: path.resolve(process.cwd(), '..', '.env')});

const migrationsFolder = process.cwd();   // save it because it changes later on...

var EnigmaContract;
if (typeof process.env.SGX_MODE === 'undefined' || (process.env.SGX_MODE != 'SW' && process.env.SGX_MODE != 'HW')) {
    console.log(`Error reading ".env" file, aborting....`);
    process.exit();
} else if (process.env.SGX_MODE == 'SW') {
    EnigmaContract = require('../build/enigma_contracts/EnigmaSimulation.json');
} else {
    EnigmaContract = require('../build/enigma_contracts/Enigma.json');
}
const EnigmaTokenContract = require('../build/enigma_contracts/EnigmaToken.json');
const provider = new Web3.providers.HttpProvider('http://localhost:9545');
const web3 = new Web3(provider);
let enigma = null;

function sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

async function deploySecretContract(config, mixerEthAddress) {
    console.log(`Deploying Secret Contract "${config.filename}"...`);
    let scTask;
    let preCode;

    try {
        preCode = fs.readFileSync(path.resolve(migrationsFolder, '../build/secret_contracts', config.filename));
        preCode = preCode.toString('hex');
    } catch (e) {
        throw new Error(`Unable to read the secret contract build file: ${e}`);
    }

    const {args} = config;
    args.push([mixerEthAddress, 'address']);
    try {
        scTask = await new Promise((resolve, reject) => {
            enigma.deploySecretContract(config.fn, args, config.gasLimit, config.gasPrice, config.from, preCode)
                .on(eeConstants.DEPLOY_SECRET_CONTRACT_RESULT, (receipt) => resolve(receipt))
                .on(eeConstants.ERROR, (error) => reject(error));
        });
    } catch (e) {
        throw new Error(`Unable to create deploy sc task: ${e}`);
    }

    // Wait for the confirmed deploy contract task
    do {
        console.log('Waiting for deploy task');
        await sleep(1000);
        scTask = await enigma.getTaskRecordStatus(scTask);
        console.log('Waiting. Current Task Status is ' + scTask.ethStatus + '\r');
    } while (scTask.ethStatus === 1);

    if (scTask.ethStatus === 3) {
        console.error('Task failed:', scTask);
        process.exit();
    }

    console.log('Completed. Final Task Status is ' + scTask.ethStatus + '\n');
    // Verify deployed contract
    const result = await enigma.admin.isDeployed(scTask.scAddr);
    if (result) {

        fs.writeFile(path.join('./test/', config.filename.replace(/\.wasm$/, '.txt')), scTask.scAddr, 'utf8', function (err) {
            if (err) {
                return console.log(err);
            }
        });

        return scTask.scAddr;
    } else {
        console.error('Something went wrong deploying Secret Contract "${contract}", aborting');
        process.exit();
    }
}

module.exports = async function (deployer, network, accounts) {

    enigma = new Enigma(
        web3,
        EnigmaContract.networks['4447'].address,
        EnigmaTokenContract.networks['4447'].address,
        'http://localhost:3346',
        {
            gas: 4712388,
            gasPrice: 100000000000,
            from: accounts[0],
        },
    );
    enigma.admin();

    // Deploy your Smart and Secret contracts below this point:
    try {
        await deployer.deploy(Mixer);
    } catch (e) {
        console.error('Unable to deploy smart contract', e);
    }
    console.log(`Smart Contract "Mixer.Sol" has been deployed at ETH address: ${Mixer.address}`);

    const config = {
        filename: 'mixer.wasm',
        fn: 'construct()',
        args: [],
        gasLimit: 200000,
        gasPrice: utils.toGrains(1),
        from: accounts[0]
    };
    try {
        const address = await deploySecretContract(config, Mixer.address);
        console.log(`Secret Contract "${config.filename}" deployed at Enigma address: ${address}`);
    } catch (e) {
        console.error('Unable to deploy secret contract', e);
    }
};
