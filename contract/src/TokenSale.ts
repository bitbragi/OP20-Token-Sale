import { u256 } from '@btc-vision/as-bignum/assembly';
import {
    Address,
    Blockchain,
    BytesWriter,
    Calldata,
    NetEvent,
    Revert,
    SafeMath,
    StoredU256,
    StoredAddress,
    StoredBoolean,
    TransferHelper,
} from '@btc-vision/btc-runtime/runtime';
import { StoredString } from '@btc-vision/btc-runtime/runtime/storage/StoredString';
import { AddressMemoryMap } from '@btc-vision/btc-runtime/runtime/memory/AddressMemoryMap';
import { ReentrancyGuard } from '@btc-vision/btc-runtime/runtime/contracts/ReentrancyGuard';
import { ADDRESS_BYTE_LENGTH, U256_BYTE_LENGTH } from '@btc-vision/btc-runtime/runtime/utils';
import { EMPTY_POINTER } from '@btc-vision/btc-runtime/runtime/math/bytes';

// Emitted on every successful purchase.
class PurchaseEvent extends NetEvent {
    constructor(buyer: Address, satsAmount: u256, tokensAmount: u256) {
        const data: BytesWriter = new BytesWriter(ADDRESS_BYTE_LENGTH + U256_BYTE_LENGTH * 2);
        data.writeAddress(buyer);
        data.writeU256(satsAmount);
        data.writeU256(tokensAmount);
        super('Purchase', data);
    }
}

// Storage slot pointers — order matters, do not reorder after deployment.
const ownerPointer: u16                = Blockchain.nextPointer;
const tokenAddressPointer: u16         = Blockchain.nextPointer;
const tokensPerSatPointer: u16         = Blockchain.nextPointer;
const maxSatsPerAddressPointer: u16    = Blockchain.nextPointer;
const roundMaxSatsPointer: u16         = Blockchain.nextPointer;
const totalSatsRaisedPointer: u16      = Blockchain.nextPointer;
const roundNumberPointer: u16          = Blockchain.nextPointer;
const pausedPointer: u16               = Blockchain.nextPointer;
const contributionsPointer: u16        = Blockchain.nextPointer;
const treasuryBtcAddressPointer: u16   = Blockchain.nextPointer;

/**
 * TokenSale — Native BTC token sale contract for OP_NET.
 *
 * Key design:
 *   - Non-custodial: BTC goes directly to the treasury Bitcoin address.
 *     The contract never holds BTC — it only verifies that the user included
 *     a correctly-valued output to the treasury in their transaction.
 *   - The treasury address is stored as a bech32 string (StoredString) and
 *     matched against output.to, which the OP_NET runtime resolves from the
 *     raw Bitcoin transaction. This is the correct way to match P2TR outputs
 *     in OP_NET contracts — NOT comparing against an OPNet Address (ML-DSA hash).
 *   - Follows the Checks-Effects-Interactions pattern to prevent reentrancy.
 *     ReentrancyGuard provides an additional mutex layer.
 *
 * Deployment calldata (in order):
 *   1. owner              — Address  (OPNet address of the sale owner)
 *   2. tokenAddress       — Address  (OPNet address of the OP20 token being sold)
 *   3. tokensPerSat       — u256     (token base units per satoshi, scaled by token decimals)
 *   4. maxSatsPerAddress  — u256     (per-address purchase cap in satoshis)
 *   5. roundMaxSats       — u256     (total round cap in satoshis)
 *   6. roundNumber        — u256     (round identifier, informational)
 *   7. treasuryBtcAddress — string   (bech32 P2TR address that receives the BTC)
 */
@final
export class TokenSale extends ReentrancyGuard {
    private readonly owner: StoredAddress;
    private readonly tokenAddress: StoredAddress;
    private readonly tokensPerSat: StoredU256;
    private readonly maxSatsPerAddress: StoredU256;
    private readonly roundMaxSats: StoredU256;
    private readonly totalSatsRaised: StoredU256;
    private readonly roundNumber: StoredU256;
    private readonly paused: StoredBoolean;
    private readonly contributions: AddressMemoryMap;
    private readonly treasuryBtcAddress: StoredString;

    public constructor() {
        super();

        this.owner              = new StoredAddress(ownerPointer);
        this.tokenAddress       = new StoredAddress(tokenAddressPointer);
        this.tokensPerSat       = new StoredU256(tokensPerSatPointer, EMPTY_POINTER);
        this.maxSatsPerAddress  = new StoredU256(maxSatsPerAddressPointer, EMPTY_POINTER);
        this.roundMaxSats       = new StoredU256(roundMaxSatsPointer, EMPTY_POINTER);
        this.totalSatsRaised    = new StoredU256(totalSatsRaisedPointer, EMPTY_POINTER);
        this.roundNumber        = new StoredU256(roundNumberPointer, EMPTY_POINTER);
        this.paused             = new StoredBoolean(pausedPointer, false);
        this.contributions      = new AddressMemoryMap(contributionsPointer);
        this.treasuryBtcAddress = new StoredString(treasuryBtcAddressPointer);
    }

    public override onDeployment(calldata: Calldata): void {
        const ownerAddr    = calldata.readAddress();
        const tokenAddr    = calldata.readAddress();
        const tps          = calldata.readU256();
        const maxPerAddr   = calldata.readU256();
        const roundMax     = calldata.readU256();
        const round        = calldata.readU256();
        const treasuryBtc  = calldata.readStringWithLength();

        this.owner.value             = ownerAddr;
        this.tokenAddress.value      = tokenAddr;
        this.tokensPerSat.value      = tps;
        this.maxSatsPerAddress.value = maxPerAddr;
        this.roundMaxSats.value      = roundMax;
        this.roundNumber.value       = round;
        this.treasuryBtcAddress.value = treasuryBtc;
        this.totalSatsRaised.set(u256.Zero);
        this.paused.value            = false;
    }

    /**
     * purchase() — Buy tokens by including a BTC output to the treasury address.
     *
     * The caller must construct their transaction such that one of the outputs
     * sends the desired satoshi amount to the treasury bech32 address.
     * The contract reads Blockchain.tx.outputs, sums all outputs matching the
     * treasury address, and transfers the proportional token amount to the sender.
     */
    @payable
    @method()
    @returns({ name: 'tokensAllocated', type: ABIDataTypes.UINT256 })
    public purchase(_calldata: Calldata): BytesWriter {
        if (this.paused.value) {
            throw new Revert('Sale is paused');
        }

        const buyer: Address = Blockchain.tx.sender;

        // --- Check: verify BTC was sent to treasury ---
        const satsReceived = this.sumOutputsToTreasury();
        if (satsReceived == u256.Zero) {
            throw new Revert('No BTC sent to treasury');
        }

        // --- Check: round cap ---
        const newTotal = SafeMath.add(this.totalSatsRaised.value, satsReceived);
        if (newTotal > this.roundMaxSats.value) {
            throw new Revert('Round cap exceeded');
        }

        // --- Check: per-address cap ---
        const prevContribution: u256 = this.contributions.get(buyer);
        const newContribution = SafeMath.add(prevContribution, satsReceived);
        if (newContribution > this.maxSatsPerAddress.value) {
            throw new Revert('Per-address cap exceeded');
        }

        const tokensToSend = SafeMath.mul(satsReceived, this.tokensPerSat.value);

        // --- Effects: update state before external call ---
        this.totalSatsRaised.set(newTotal);
        this.contributions.set(buyer, newContribution);

        // --- Interactions: external token transfer last ---
        TransferHelper.transfer(this.tokenAddress.value, buyer, tokensToSend);

        this.emitEvent(new PurchaseEvent(buyer, satsReceived, tokensToSend));

        const response = new BytesWriter(U256_BYTE_LENGTH);
        response.writeU256(tokensToSend);
        return response;
    }

    @method()
    public pause(_calldata: Calldata): BytesWriter {
        this._onlyOwner();
        this.paused.value = true;
        return new BytesWriter(0);
    }

    @method()
    public unpause(_calldata: Calldata): BytesWriter {
        this._onlyOwner();
        this.paused.value = false;
        return new BytesWriter(0);
    }

    /**
     * withdrawTokens() — Owner can recover unsold tokens after the round ends.
     */
    @method()
    @returns({ name: 'success', type: ABIDataTypes.BOOL })
    public withdrawTokens(calldata: Calldata): BytesWriter {
        this._onlyOwner();
        const amount = calldata.readU256();
        if (amount == u256.Zero) {
            throw new Revert('Amount must be greater than zero');
        }
        TransferHelper.transfer(this.tokenAddress.value, this.owner.value, amount);
        const response = new BytesWriter(1);
        response.writeBoolean(true);
        return response;
    }

    @view
    @method()
    @returns(
        { name: 'totalSatsRaised',  type: ABIDataTypes.UINT256 },
        { name: 'roundMaxSats',     type: ABIDataTypes.UINT256 },
        { name: 'tokensPerSat',     type: ABIDataTypes.UINT256 },
        { name: 'roundNumber',      type: ABIDataTypes.UINT256 },
        { name: 'paused',           type: ABIDataTypes.BOOL    },
    )
    public getState(_calldata: Calldata): BytesWriter {
        const response = new BytesWriter(U256_BYTE_LENGTH * 4 + 1);
        response.writeU256(this.totalSatsRaised.value);
        response.writeU256(this.roundMaxSats.value);
        response.writeU256(this.tokensPerSat.value);
        response.writeU256(this.roundNumber.value);
        response.writeBoolean(this.paused.value);
        return response;
    }

    @view
    @method({ name: 'address', type: ABIDataTypes.ADDRESS })
    @returns({ name: 'contributed', type: ABIDataTypes.UINT256 })
    public getContribution(calldata: Calldata): BytesWriter {
        const addr = calldata.readAddress();
        const contributed = this.contributions.get(addr);
        const response = new BytesWriter(U256_BYTE_LENGTH);
        response.writeU256(contributed);
        return response;
    }

    /**
     * Sums all transaction outputs whose `to` field matches the stored treasury bech32 address.
     *
     * output.to is a string populated by the OP_NET runtime from the Bitcoin transaction.
     * For P2TR outputs this is the bech32m address (e.g. "opt1p...").
     * This is the correct matching strategy — comparing against the OPNet Address type
     * (which is an ML-DSA public key hash) would never match a Bitcoin bech32 address.
     */
    private sumOutputsToTreasury(): u256 {
        const treasury = this.treasuryBtcAddress.value;
        const outputs  = Blockchain.tx.outputs;
        let total: u64 = 0;
        for (let i: i32 = 0; i < outputs.length; i++) {
            const output = outputs[i];
            if (output.to !== null && output.to! == treasury) {
                total += output.value;
            }
        }
        return u256.fromU64(total);
    }

    private _onlyOwner(): void {
        if (Blockchain.tx.sender !== this.owner.value) {
            throw new Revert('Only owner');
        }
    }
}
