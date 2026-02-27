"use client";

/**
 * TokenSaleWidget — React component for interacting with the TokenSale OP_NET contract.
 *
 * Dependencies:
 *   npm install opnet @btc-vision/walletconnect @btc-vision/transaction @btc-vision/bitcoin
 *
 * Props:
 *   - presaleAddress   : hex contract address (0x...)
 *   - treasuryAddress  : bech32 P2TR address of the treasury (opt1p... on testnet)
 *   - tokenSymbol      : display symbol, e.g. "TOKEN"
 *   - tokensPerSat     : human-readable rate for display only, e.g. 200
 *   - roundCapSats     : total round cap in satoshis for progress bar
 *
 * How the purchase flow works:
 *   1. setTransactionDetails() tells the simulator about the BTC output the user will send.
 *      The output uses `to: treasuryAddress` with the `hasTo` flag so the contract's
 *      sumOutputsToTreasury() can match it by bech32 string during simulation.
 *   2. purchase() is simulated — the contract verifies the output exists and calculates tokens.
 *   3. sendTransaction() broadcasts with an extraOutput to the treasury bech32 address,
 *      which the wallet includes as a real Bitcoin output in the transaction.
 *
 * The wallet (OP_WALLET / UniSat) handles all signing. Never pass explicit signers
 * on the frontend — the wallet injects them automatically.
 */

import { useState, useCallback, useEffect, useRef } from "react";
import { useWalletConnect } from "@btc-vision/walletconnect";
import {
  getContract,
  TransactionOutputFlags,
  BitcoinAbiTypes,
  ABIDataTypes,
} from "opnet";
import type { BitcoinInterfaceAbi } from "opnet";
import { Address } from "@btc-vision/transaction";

const TOKEN_SALE_ABI: BitcoinInterfaceAbi = [
  {
    name: "purchase",
    type: BitcoinAbiTypes.Function,
    constant: false,
    payable: true,
    inputs: [],
    outputs: [{ name: "tokensAllocated", type: ABIDataTypes.UINT256 }],
  },
  {
    name: "getState",
    type: BitcoinAbiTypes.Function,
    constant: true,
    inputs: [],
    outputs: [
      { name: "totalSatsRaised",  type: ABIDataTypes.UINT256 },
      { name: "roundMaxSats",     type: ABIDataTypes.UINT256 },
      { name: "tokensPerSat",     type: ABIDataTypes.UINT256 },
      { name: "roundNumber",      type: ABIDataTypes.UINT256 },
      { name: "paused",           type: ABIDataTypes.BOOL    },
    ],
  },
  {
    name: "getContribution",
    type: BitcoinAbiTypes.Function,
    constant: true,
    inputs: [{ name: "address", type: ABIDataTypes.ADDRESS }],
    outputs: [{ name: "contributed", type: ABIDataTypes.UINT256 }],
  },
  {
    name: "Purchase",
    type: BitcoinAbiTypes.Event,
    values: [
      { name: "buyer",        type: ABIDataTypes.ADDRESS },
      { name: "satsAmount",   type: ABIDataTypes.UINT256 },
      { name: "tokensAmount", type: ABIDataTypes.UINT256 },
    ],
  },
];

interface TokenSaleWidgetProps {
  presaleAddress: string;
  treasuryAddress: string;
  tokenSymbol?: string;
  tokensPerSat?: number;
  roundCapSats?: number;
}

interface PurchaseResult {
  success: boolean;
  message: string;
  tokensAllocated?: number;
  txId?: string;
}

export function TokenSaleWidget({
  presaleAddress,
  treasuryAddress,
  tokenSymbol = "TOKEN",
  tokensPerSat = 0,
  roundCapSats = 1_000_000,
}: TokenSaleWidgetProps) {
  const { walletAddress, provider, network, address: opnetAddress } = useWalletConnect();

  const [satsInput, setSatsInput]     = useState("");
  const [purchasing, setPurchasing]   = useState(false);
  const [result, setResult]           = useState<PurchaseResult | null>(null);
  const [raisedSats, setRaisedSats]   = useState(0);

  const contractRef   = useRef<ReturnType<typeof getContract> | null>(null);
  const [ready, setReady] = useState(false);

  // Initialise contract instance whenever wallet or address changes.
  useEffect(() => {
    if (provider && network && presaleAddress && opnetAddress) {
      try {
        contractRef.current = getContract(
          Address.fromString(presaleAddress),
          TOKEN_SALE_ABI,
          provider,
          network,
          opnetAddress,   // sender — required so Blockchain.tx.sender is set during simulation
        );
        setReady(!!treasuryAddress);
      } catch (e) {
        console.error("[TokenSaleWidget] contract init failed:", e);
        contractRef.current = null;
        setReady(false);
      }
    } else {
      contractRef.current = null;
      setReady(false);
    }
  }, [provider, network, presaleAddress, treasuryAddress, opnetAddress]);

  // Poll on-chain state for progress bar.
  useEffect(() => {
    if (!contractRef.current) return;
    let active = true;
    async function poll() {
      try {
        const state = await (contractRef.current as any).getState();
        if (active && state.properties) {
          setRaisedSats(Number(BigInt(state.properties.totalSatsRaised) / 1n));
        }
      } catch { /* ignore */ }
    }
    poll();
    const id = setInterval(poll, 30_000);
    return () => { active = false; clearInterval(id); };
  }, [ready]);

  const remaining = Math.max(0, roundCapSats - raisedSats);
  const progress  = roundCapSats > 0
    ? Math.min(100, Math.round((raisedSats / roundCapSats) * 100))
    : 0;

  const handlePurchase = useCallback(async () => {
    if (!walletAddress || !satsInput || !contractRef.current || !network) return;

    const amount = Math.floor(parseFloat(satsInput));
    if (isNaN(amount) || amount <= 0) {
      setResult({ success: false, message: "Enter a valid satoshi amount." });
      return;
    }
    if (amount > remaining) {
      setResult({ success: false, message: `Only ${remaining.toLocaleString()} sats remaining.` });
      return;
    }
    if (!treasuryAddress) {
      setResult({ success: false, message: "Treasury address not configured." });
      return;
    }

    setPurchasing(true);
    setResult(null);

    try {
      const contract   = contractRef.current;
      const satsAmount = BigInt(amount);

      // Tell the simulator about the BTC output that will go to the treasury.
      // hasTo flag ensures output.to is set so the contract can match by bech32 string.
      contract.setTransactionDetails({
        inputs: [],
        outputs: [
          {
            to:    treasuryAddress,
            value: satsAmount,
            index: 1,
            flags: TransactionOutputFlags.hasTo,
          },
        ],
      });

      const sim = await (contract as any).purchase();
      if (sim.revert) {
        throw new Error(`Contract reverted: ${sim.revert}`);
      }

      // The wallet signs and broadcasts. extraOutputs adds the real BTC output to treasury.
      const receipt = await sim.sendTransaction({
        refundTo: walletAddress,
        maximumAllowedSatToSpend: satsAmount + BigInt(50_000),
        network,
        extraOutputs: [
          {
            address: treasuryAddress,
            value:   Number(satsAmount),
          },
        ],
      });

      const txId           = receipt.transactionId;
      const tokensAllocated = Math.floor(amount * tokensPerSat);

      // Optimistic update.
      setRaisedSats(prev => prev + amount);

      setResult({
        success: true,
        message: `Purchase complete! ${tokensAllocated.toLocaleString()} $${tokenSymbol} tokens incoming.`,
        tokensAllocated,
        txId,
      });
      setSatsInput("");
    } catch (err) {
      setResult({ success: false, message: err instanceof Error ? err.message : "Purchase failed." });
    } finally {
      setPurchasing(false);
    }
  }, [walletAddress, satsInput, remaining, network, treasuryAddress, tokensPerSat, tokenSymbol]);

  return (
    <div style={{ border: "1px solid #ccc", padding: "1.5rem", maxWidth: 480, fontFamily: "sans-serif" }}>
      <h2 style={{ marginTop: 0 }}>${tokenSymbol} Token Sale</h2>

      {/* Progress */}
      <div style={{ marginBottom: "1rem" }}>
        <div style={{ display: "flex", justifyContent: "space-between", fontSize: 13 }}>
          <span>Progress</span>
          <span>{progress}% filled</span>
        </div>
        <div style={{ height: 12, background: "#eee", borderRadius: 6, overflow: "hidden", marginTop: 4 }}>
          <div style={{ height: "100%", width: `${progress}%`, background: "#f59e0b", transition: "width 0.4s" }} />
        </div>
        <p style={{ fontSize: 12, color: "#888", marginTop: 4 }}>
          {remaining.toLocaleString()} sats remaining · {tokensPerSat} {tokenSymbol}/sat
        </p>
      </div>

      {walletAddress ? (
        <div>
          <p style={{ fontSize: 13, color: "#555" }}>
            Connected: {walletAddress.slice(0, 10)}…{walletAddress.slice(-6)}
          </p>

          {!ready && (
            <p style={{ color: "#b45309", fontSize: 13 }}>
              Waiting for contract configuration…
            </p>
          )}

          <label style={{ display: "block", fontWeight: 600, marginBottom: 4 }}>
            Sats to spend
          </label>
          <input
            type="number"
            min="1"
            max={String(remaining)}
            placeholder={String(Math.min(1000, remaining))}
            value={satsInput}
            onChange={e => setSatsInput(e.target.value)}
            disabled={purchasing || !ready || remaining <= 0}
            style={{ width: "100%", padding: "0.5rem", fontSize: 15, boxSizing: "border-box" }}
          />
          {satsInput && !isNaN(parseFloat(satsInput)) && parseFloat(satsInput) > 0 && (
            <p style={{ fontSize: 12, color: "#555", margin: "4px 0 12px" }}>
              ≈ {Math.floor(parseFloat(satsInput) * tokensPerSat).toLocaleString()} ${tokenSymbol}
            </p>
          )}

          <button
            onClick={handlePurchase}
            disabled={!satsInput || parseFloat(satsInput) <= 0 || !ready || purchasing || remaining <= 0}
            style={{
              width: "100%", padding: "0.75rem", fontSize: 16, fontWeight: 700,
              background: purchasing ? "#ccc" : "#f59e0b", border: "none", cursor: "pointer",
              borderRadius: 6, marginTop: 4,
            }}
          >
            {purchasing ? "Processing…" : `Buy $${tokenSymbol}`}
          </button>

          {result && (
            <div style={{
              marginTop: 12, padding: "0.75rem", borderRadius: 6, fontSize: 13,
              background: result.success ? "#f0fdf4" : "#fef2f2",
              border: `1px solid ${result.success ? "#86efac" : "#fca5a5"}`,
              color: result.success ? "#166534" : "#991b1b",
            }}>
              <p style={{ margin: 0 }}>{result.message}</p>
              {result.tokensAllocated && (
                <p style={{ margin: "4px 0 0", fontWeight: 700 }}>
                  {result.tokensAllocated.toLocaleString()} ${tokenSymbol} allocated
                </p>
              )}
              {result.txId && (
                <p style={{ margin: "4px 0 0", fontSize: 11, fontFamily: "monospace", wordBreak: "break-all" }}>
                  tx: {result.txId}
                </p>
              )}
            </div>
          )}
        </div>
      ) : (
        <p style={{ color: "#555" }}>Connect your OP_WALLET or UniSat wallet to participate.</p>
      )}
    </div>
  );
}
