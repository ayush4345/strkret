import { hash, type BigNumberish } from "starknet";
import { starkKeyOf, type Voucher } from "./voucher.js";

/**
 * One provider's claim against an escrow, mirroring `ProviderClaim` in
 * `contracts/metering-anonymizer/src/lib.cairo`.
 */
export interface ProviderClaim {
  /** Private witness — never published, only bound into the commitment. */
  rate: bigint;
  rateBlind: bigint;
  /** poseidon(rate, rateBlind), published at channel open. */
  rateCommitment: string;
  channelId: bigint;
  /** Cumulative for the channel; the contract pays only the unsettled part. */
  totalUnits: bigint;
  consumerStarkKey: string;
  sigR: string;
  sigS: string;
  /** Open note the pool credits this provider's settlement to. */
  providerNoteId: BigNumberish;
}

/** Build a claim from a signed voucher and the rate it was agreed at. */
/**
 * Build a claim from a signed voucher and the rate witnesses that open its
 * commitment. The commitment comes from the voucher rather than being
 * recomputed here: the voucher's signature covers it, so using any other
 * value produces a claim the contract rejects — which is the point. If the
 * supplied `rate`/`rateBlind` don't open the committed value, this fails
 * on-chain as BAD_RATE_COMMITMENT rather than silently settling at a rate
 * nobody agreed to.
 */
export function claimFromVoucher(
  voucher: Voucher,
  rate: bigint,
  rateBlind: bigint,
  providerNoteId: BigNumberish,
): ProviderClaim {
  return {
    rate,
    rateBlind,
    rateCommitment: voucher.rateCommitment,
    channelId: voucher.channelId,
    totalUnits: voucher.totalUnits,
    consumerStarkKey: starkKeyOf(voucher.pubkey),
    sigR: voucher.sigR,
    sigS: voucher.sigS,
    providerNoteId,
  };
}

/**
 * Serialize `privacy_invoke(token, claims, refund_note_id)` calldata.
 *
 * Cairo's Serde flattens a `Span<T>` as a length followed by each element's
 * fields in declaration order, so the field order below is load-bearing: it
 * has to match the struct exactly, and getting it wrong doesn't fail at the
 * boundary — it reverts on-chain, usually as BAD_SIGNATURE, because the
 * contract reads the misaligned felts as a different voucher entirely.
 *
 * Batching is why this takes an array. The pool charges a flat protocol fee
 * per settlement, so paying M providers one at a time costs M times the fee
 * for the same work; in one batch it is paid once.
 */
export function encodeInvokeCalldata(
  tokenAddress: string,
  claims: ProviderClaim[],
  refundNoteId: BigNumberish,
): string[] {
  if (claims.length === 0) throw new Error("privacy_invoke needs at least one claim");
  return [
    tokenAddress,
    claims.length.toString(),
    ...claims.flatMap((c) => [
      c.rate.toString(),
      c.rateBlind.toString(),
      c.rateCommitment,
      c.channelId.toString(),
      c.totalUnits.toString(),
      c.consumerStarkKey,
      c.sigR,
      c.sigS,
      c.providerNoteId.toString(),
    ]),
    refundNoteId.toString(),
  ];
}
