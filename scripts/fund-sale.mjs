#!/usr/bin/env node
/**
 * fund-sale.mjs — Transfer OP20 tokens from the deployer wallet to the TokenSale contract.
 *
 * Must be run after deploy.mjs. The sale contract must hold tokens before
 * buyers can call purchase().
 *
 * Usage:
 *   node scripts/fund-sale.mjs [amount]
 *
 *   amount — number of whole tokens (default: 1000000).
 *            The script automatically scales by 10^DECIMALS.
 */

import { readFileSync, existsSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';
import { JSONRpcProvider, getContract, OP_20_ABI } from 'opnet';
import { networks } from '@btc-vision/bitcoin';
import { Wallet, Address } from '@btc-vision/transaction';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ENV_PATH  = resolve(__dirname, '..', '.env');
const DECIMALS  = 18n;

function loadEnv() {
    if (!existsSync(ENV_PATH)) throw new Error('.env not found');
    const vars = {};
    for (const line of readFileSync(ENV_PATH, 'utf-8').split('\n')) {
        const trimmed = line.trim();
        if (!trimmed || trimmed.startsWith('#')) continue;
        const eq = trimmed.indexOf('=');
        if (eq > 0) vars[trimmed.slice(0, eq)] = trimmed.slice(eq + 1);
    }
    return vars;
}

async function main() {
    const env          = loadEnv();
    const deployerKey  = env.DEPLOYER_PRIVATE_KEY;
    const mldsaKey     = env.DEPLOYER_MLDSA_KEY;
    const tokenAddress = env.TOKEN_CONTRACT_ADDRESS;
    const saleAddress  = env.TOKEN_SALE_CONTRACT_ADDRESS;
    const rpcUrl       = env.OPNET_RPC_URL || 'https://testnet.opnet.org';

    if (!deployerKey || !mldsaKey) {
        console.error('DEPLOYER_PRIVATE_KEY and DEPLOYER_MLDSA_KEY required in .env');
        process.exit(1);
    }
    if (!tokenAddress || !saleAddress) {
        console.error('TOKEN_CONTRACT_ADDRESS and TOKEN_SALE_CONTRACT_ADDRESS required in .env');
        process.exit(1);
    }

    const wholeTokens = BigInt(process.argv[2] || '1000000');
    const amount      = wholeTokens * 10n ** DECIMALS;

    console.log(`Connecting to OP_NET at ${rpcUrl}...`);
    const provider = new JSONRpcProvider({ url: rpcUrl, network: networks.opnetTestnet });
    const wallet   = Wallet.fromPrivateKeys(deployerKey, mldsaKey, networks.opnetTestnet);

    const token    = getContract(
        Address.fromString(tokenAddress),
        OP_20_ABI,
        provider,
        networks.opnetTestnet,
        wallet.address,
    );

    const saleAddr = Address.fromString(saleAddress);
    console.log(`Transferring ${wholeTokens.toLocaleString()} tokens to sale contract ${saleAddress}...`);

    const sim = await token.transfer(saleAddr, amount);
    if (sim.revert) {
        console.error('Simulation failed:', sim.revert);
        process.exit(1);
    }

    const utxos = await provider.utxoManager.getUTXOs({ address: wallet.p2tr });
    if (utxos.length === 0) {
        console.error('No UTXOs. Fund deployer first.');
        process.exit(1);
    }

    const receipt = await sim.sendTransaction({
        signer: wallet.keypair,
        mldsaSigner: wallet.mldsaKeypair,
        refundTo: wallet.p2tr,
        maximumAllowedSatToSpend: 50_000n,
        feeRate: 1,
        network: networks.opnetTestnet,
    });

    console.log(`✓ Transfer tx: ${receipt.transactionId}`);
    console.log(`  ${wholeTokens.toLocaleString()} tokens sent to sale contract.`);
    await provider.close();
}

main().catch(err => {
    console.error('Fund failed:', err.message || err);
    process.exit(1);
});
