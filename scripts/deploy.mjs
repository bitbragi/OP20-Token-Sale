#!/usr/bin/env node
/**
 * deploy.mjs — Deploy the TokenSale contract to OP_NET.
 *
 * Prerequisites:
 *   1. Copy .env.example to .env and fill in your values.
 *   2. Install contract deps: cd contract && npm install
 *   3. Build the WASM: cd contract && npm run build
 *   4. Ensure the deployer address has testnet BTC (UTXOs).
 *
 * The script deploys TokenSale.wasm with calldata encoding:
 *   owner, tokenAddress, tokensPerSat, maxSatsPerAddress,
 *   roundMaxSats, roundNumber, treasuryBtcAddress
 *
 * Usage:
 *   node scripts/deploy.mjs
 */

import { readFileSync, writeFileSync, existsSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';
import { JSONRpcProvider } from 'opnet';
import { networks } from '@btc-vision/bitcoin';
import { TransactionFactory, Wallet, BinaryWriter, Address } from '@btc-vision/transaction';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT      = resolve(__dirname, '..');
const ENV_PATH  = resolve(ROOT, '.env');
const WASM_PATH = resolve(ROOT, 'contract/build/TokenSale.wasm');

function loadEnv() {
    if (!existsSync(ENV_PATH)) throw new Error('.env not found — copy .env.example and fill it in.');
    const vars = {};
    for (const line of readFileSync(ENV_PATH, 'utf-8').split('\n')) {
        const trimmed = line.trim();
        if (!trimmed || trimmed.startsWith('#')) continue;
        const eq = trimmed.indexOf('=');
        if (eq > 0) vars[trimmed.slice(0, eq)] = trimmed.slice(eq + 1);
    }
    return vars;
}

function saveEnvKey(key, value) {
    let content = readFileSync(ENV_PATH, 'utf-8');
    const regex = new RegExp(`^${key}=.*$`, 'm');
    content = regex.test(content)
        ? content.replace(regex, `${key}=${value}`)
        : content + `\n${key}=${value}\n`;
    writeFileSync(ENV_PATH, content);
}

async function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

async function waitForConfirmation(provider, txId, label, maxWait = 120_000) {
    console.log(`  Waiting for ${label} (${txId})...`);
    const start = Date.now();
    while (Date.now() - start < maxWait) {
        try {
            const receipt = await provider.getTransactionReceipt(txId);
            if (receipt) { console.log(`  ✓ ${label} confirmed`); return receipt; }
        } catch { /* not yet */ }
        await sleep(5_000);
    }
    console.warn(`  ⚠ ${label} not confirmed within ${maxWait / 1000}s — check manually`);
    return null;
}

async function main() {
    const env = loadEnv();

    const deployerKey  = env.DEPLOYER_PRIVATE_KEY;
    const mldsaKey     = env.DEPLOYER_MLDSA_KEY;
    const tokenAddress = env.TOKEN_CONTRACT_ADDRESS;
    const rpcUrl       = env.OPNET_RPC_URL || 'https://testnet.opnet.org';

    if (!deployerKey || !mldsaKey) {
        console.error('DEPLOYER_PRIVATE_KEY and DEPLOYER_MLDSA_KEY are required in .env');
        process.exit(1);
    }
    if (!tokenAddress) {
        console.error('TOKEN_CONTRACT_ADDRESS is required in .env (the OP20 token to sell)');
        process.exit(1);
    }
    if (!existsSync(WASM_PATH)) {
        console.error(`WASM not found at ${WASM_PATH}. Run: cd contract && npm install && npm run build`);
        process.exit(1);
    }

    // Sale parameters — edit these or move them to .env as needed.
    const DECIMALS           = 18n;
    const TOKENS_PER_SAT     = 200n * 10n ** DECIMALS;   // 200 tokens per satoshi (18-decimal scaled)
    const MAX_SATS_PER_ADDR  = 100_000n;                  // 0.001 BTC per address
    const ROUND_MAX_SATS     = 1_000_000n;                // 0.01 BTC total round cap
    const ROUND_NUMBER       = 0n;

    console.log(`Connecting to OP_NET at ${rpcUrl}...`);
    const provider = new JSONRpcProvider({ url: rpcUrl, network: networks.opnetTestnet });
    const wallet   = Wallet.fromPrivateKeys(deployerKey, mldsaKey, networks.opnetTestnet);
    const factory  = new TransactionFactory();

    console.log(`Deployer P2TR: ${wallet.p2tr}`);
    console.log(`Deployer balance: ${await provider.getBalance(wallet.p2tr)} sats`);

    const utxos = await provider.utxoManager.getUTXOs({ address: wallet.p2tr });
    if (utxos.length === 0) {
        console.error('No UTXOs. Send testnet BTC to your deployer address first.');
        process.exit(1);
    }

    const calldata = new BinaryWriter();
    calldata.writeAddress(wallet.address);                  // owner (OPNet address)
    calldata.writeAddress(Address.fromString(tokenAddress)); // token being sold
    calldata.writeU256(TOKENS_PER_SAT);                     // rate (decimal-scaled)
    calldata.writeU256(MAX_SATS_PER_ADDR);                  // per-address cap (sats)
    calldata.writeU256(ROUND_MAX_SATS);                     // round total cap (sats)
    calldata.writeU256(ROUND_NUMBER);                       // round identifier
    calldata.writeStringWithLength(wallet.p2tr);            // treasury bech32 P2TR address

    const bytecode = new Uint8Array(readFileSync(WASM_PATH));
    console.log(`\nDeploying TokenSale (${bytecode.length} bytes)...`);

    const challenge = await provider.getChallenge();
    const deployment = await factory.signDeployment({
        signer: wallet.keypair,
        mldsaSigner: wallet.mldsaKeypair,
        network: networks.opnetTestnet,
        from: wallet.p2tr,
        utxos,
        bytecode,
        calldata: calldata.getBuffer(),
        challenge,
        feeRate: 5,
        priorityFee: 0n,
        gasSatFee: 10_000n,
        linkMLDSAPublicKeyToAddress: true,
        revealMLDSAPublicKey: true,
    });

    const fund   = await provider.sendRawTransaction(deployment.transaction[0], false);
    if (!fund?.success) throw new Error(`Funding tx failed: ${fund?.error || 'unknown'}`);
    console.log(`  Funding tx:  ${fund.result}`);

    const reveal = await provider.sendRawTransaction(deployment.transaction[1], false);
    if (!reveal?.success) throw new Error(`Reveal tx failed: ${reveal?.error || 'unknown'}`);
    console.log(`  Reveal tx:   ${reveal.result}`);
    console.log(`  Contract:    ${deployment.contractPubKey}  (hex)`);
    console.log(`  Contract:    ${deployment.contractAddress} (P2OP)`);

    saveEnvKey('TOKEN_SALE_CONTRACT_ADDRESS', deployment.contractPubKey);
    console.log(`\n✓ TOKEN_SALE_CONTRACT_ADDRESS saved to .env`);

    await waitForConfirmation(provider, reveal.result, 'TokenSale deploy');
    await provider.close();

    console.log('\n══════════════════════════════════════════');
    console.log('  Next: fund the sale contract with tokens');
    console.log(`  node scripts/fund-sale.mjs`);
    console.log('══════════════════════════════════════════');
}

main().catch(err => {
    console.error('Deploy failed:', err.message || err);
    process.exit(1);
});
