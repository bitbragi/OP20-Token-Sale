# OP20 Token Sale — Native BTC on Bitcoin L1 via OP_NET

A minimal, production-tested reference implementation of a **native Bitcoin token sale** using [OP_NET](https://opnet.org).

Buyers send real BTC directly to a treasury address — no wrapping, no bridges, no custodians. The contract verifies the Bitcoin output exists and atomically transfers OP20 tokens to the buyer in the same transaction.

Built for the **OP_NET Hackathon** and extracted from a live testnet deployment where it successfully processed purchases end-to-end.

---

## How it works

```
Buyer's wallet                   Bitcoin L1                    OP_NET runtime
──────────────    ──────────────────────────────────    ────────────────────────────
 Construct tx  →  output[0]: contract calldata       →  execute purchase()
                  output[1]: N sats → treasury addr      ↓
                                                       sumOutputsToTreasury()
                                                       matches output.to == treasury
                                                       bech32 string
                                                          ↓
                                                       TransferHelper.transfer()
                                                       sends tokens to buyer
```

### Key design insight: bech32 address matching

The core challenge in OP_NET presale contracts is **verifying that the user actually sent BTC to the treasury**. The wrong approach — and a common mistake — is comparing `output.to` against an `OPNet Address` (which is an ML-DSA public key hash, not a Bitcoin address). These types are fundamentally incompatible.

The correct approach is to store the treasury's **bech32 P2TR address as a `StoredString`** during deployment and compare `output.to` against it directly. The OP_NET runtime populates `output.to` with the decoded bech32 string from the raw Bitcoin transaction, so the match succeeds.

```typescript
// ✗ WRONG — Address is an ML-DSA hash, never matches a bech32 output.to
const sats = this.sumOutputsTo(this.owner.value);

// ✓ CORRECT — compare the stored bech32 string
if (output.to !== null && output.to! == this.treasuryBtcAddress.value) { ... }
```

---

## Repository structure

```
opnet-token-sale/
├── contract/
│   ├── src/
│   │   ├── TokenSale.ts     # The smart contract (AssemblyScript)
│   │   └── index.ts         # Entry point / Blockchain.contract binding
│   ├── asconfig.json
│   └── package.json
├── scripts/
│   ├── deploy.mjs           # Deploy TokenSale contract to OP_NET
│   └── fund-sale.mjs        # Transfer tokens from deployer to sale contract
├── widget/
│   └── TokenSaleWidget.tsx  # React component for the purchase UI
├── .env.example
└── README.md
```

---

## Prerequisites

- Node.js 20+
- A funded wallet on OP_NET testnet — get testnet BTC from a [Signet faucet](https://signetfaucet.com/)
- An existing OP20 token contract address (the token you want to sell)
- [OP_WALLET](https://chromewebstore.google.com/detail/opwallet/pmbjpcmaaladnfpacpmhmnfmpklgbdjb) browser extension for the frontend widget

---

## Setup

### 1. Configure environment

```bash
cp .env.example .env
# Fill in DEPLOYER_PRIVATE_KEY, DEPLOYER_MLDSA_KEY, TOKEN_CONTRACT_ADDRESS
```

### 2. Build the contract

```bash
cd contract
npm install
npm run build
# → produces contract/build/TokenSale.wasm
```

### 3. Deploy the TokenSale contract

```bash
node scripts/deploy.mjs
# Prints contract addresses and saves TOKEN_SALE_CONTRACT_ADDRESS to .env
```

The deploy script writes these values as calldata to the contract:

| Field | Description |
|---|---|
| `owner` | OPNet address of the deployer (sale owner) |
| `tokenAddress` | OPNet address of the OP20 token being sold |
| `tokensPerSat` | Token base units per satoshi (scale by `10^decimals`) |
| `maxSatsPerAddress` | Per-buyer cap in satoshis |
| `roundMaxSats` | Total round cap in satoshis |
| `roundNumber` | Round identifier (informational) |
| `treasuryBtcAddress` | Deployer's bech32 P2TR address — receives all BTC payments |

### 4. Fund the sale contract with tokens

```bash
node scripts/fund-sale.mjs 1000000   # Transfer 1,000,000 tokens
```

The contract must hold tokens before buyers can call `purchase()`.

### 5. Use the React widget

```tsx
import { TokenSaleWidget } from './widget/TokenSaleWidget';

<TokenSaleWidget
  presaleAddress="0x..."          // TOKEN_SALE_CONTRACT_ADDRESS
  treasuryAddress="opt1p..."      // Your bech32 P2TR address
  tokenSymbol="TOKEN"
  tokensPerSat={200}
  roundCapSats={1_000_000}
/>
```

Install peer dependencies:

```bash
npm install opnet @btc-vision/walletconnect @btc-vision/transaction @btc-vision/bitcoin
```

---

## Contract ABI

### `purchase()` — payable

Verifies BTC was sent to the treasury and transfers tokens to the caller.  
Must include a Bitcoin output to the treasury address in the transaction.

Returns: `tokensAllocated: u256`

### `getState()` — view

Returns current sale state.

```
totalSatsRaised  u256
roundMaxSats     u256
tokensPerSat     u256
roundNumber      u256
paused           bool
```

### `getContribution(address)` — view

Returns the total satoshis contributed by a specific address.

### `withdrawTokens(amount)` — owner only

Withdraw unsold tokens back to the owner after the round ends.

### `pause()` / `unpause()` — owner only

Emergency pause/unpause the sale.

---

## Security properties

- **Reentrancy guard**: inherits from `ReentrancyGuard` — no recursive calls possible
- **CEI pattern**: Checks → Effects → Interactions ordering throughout `purchase()`
- **Owner-only admin**: `pause`, `unpause`, `withdrawTokens` all require `Blockchain.tx.sender == owner`
- **Non-custodial BTC**: the contract never holds BTC — it only verifies the Bitcoin output exists
- **Decimal-aware rate**: `tokensPerSat` must be scaled by token decimals at deploy time

---

## Tested on

- OP_NET testnet (Signet fork) — February 2026
- OP_WALLET browser extension
- Two successful end-to-end purchase transactions confirmed on-chain

---

## License

MIT
