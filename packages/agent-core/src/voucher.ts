import { ec, hash } from "starknet";

/**
 * A consumer-signed claim that it authorizes paying for `totalUnits` on
 * `channelId`. `totalUnits` is CUMULATIVE for the channel, not per-call:
 * each voucher supersedes the last, so the provider only ever needs to keep
 * the highest one, and settling it pays the units past whatever that channel
 * already settled on-chain.
 *
 * That shape is what makes serving-before-settling safe. The provider holds
 * an enforceable claim for everything it has served after every single call,
 * without a chain interaction — which matters because settlement is not
 * cheap: the pool charges a flat protocol fee per `apply_actions` (6 STRK on
 * mainnet, read from `get_fee_amount()`), so paying per call on-chain cannot
 * work at any sane per-call price.
 */
export interface Voucher {
  channelId: bigint;
  totalUnits: bigint;
  /**
   * Full uncompressed public key (`0x04 || x || y`). This is what
   * starknet.js's `verify` needs — passing the stark key here silently
   * returns false rather than throwing, which is a genuinely nasty way to
   * lose an afternoon.
   */
  pubkey: string;
  sigR: string;
  sigS: string;
}

/**
 * The message the signature covers. MUST stay identical to the Cairo side's
 * `poseidon_hash_span([channel_id, total_units])` in
 * `contracts/metering-anonymizer/src/lib.cairo` — a mismatch here doesn't
 * fail loudly at the boundary, it fails on-chain at settlement as
 * BAD_SIGNATURE, after the work has already been served.
 */
export function voucherMessageHash(channelId: bigint, totalUnits: bigint): string {
  return hash.computePoseidonHashOnElements([channelId, totalUnits]);
}

/**
 * The x-coordinate of an uncompressed key, which is the form Cairo's
 * `check_ecdsa_signature` takes — so this is what goes into
 * `privacy_invoke`'s calldata and what the contract keys its high-water mark
 * on. Derived rather than carried on the voucher: one source of truth means
 * there is no mismatched pair to detect.
 */
export function starkKeyOf(pubkey: string): string {
  return "0x" + pubkey.replace(/^0x04/, "").slice(0, 64).replace(/^0+/, "");
}

export function signVoucher(channelId: bigint, totalUnits: bigint, privateKey: string): Voucher {
  const sig = ec.starkCurve.sign(voucherMessageHash(channelId, totalUnits), privateKey);
  return {
    channelId,
    totalUnits,
    pubkey: "0x" + Buffer.from(ec.starkCurve.getPublicKey(privateKey)).toString("hex"),
    sigR: "0x" + sig.r.toString(16),
    sigS: "0x" + sig.s.toString(16),
  };
}

/**
 * Verify a voucher's signature against the pubkey it carries.
 *
 * Note what this does and does not establish: it proves the holder of that
 * pubkey's private key authorized this (channelId, totalUnits). It says
 * nothing about whether that pubkey is the consumer the provider expects —
 * the caller has to pin the pubkey it agreed a channel with, or an attacker
 * can sign a perfectly valid voucher with their own key and get served for
 * free.
 */
export function verifyVoucher(voucher: Voucher): boolean {
  try {
    return ec.starkCurve.verify(
      new ec.starkCurve.Signature(BigInt(voucher.sigR), BigInt(voucher.sigS)),
      voucherMessageHash(voucher.channelId, voucher.totalUnits),
      voucher.pubkey,
    );
  } catch {
    // Malformed r/s/pubkey reach us straight off the wire; a bad voucher is
    // a rejection, not a crash.
    return false;
  }
}

/** Wire form — bigints don't survive JSON, so they travel as strings. */
export type VoucherWire = Omit<Voucher, "channelId" | "totalUnits"> & {
  channelId: string;
  totalUnits: string;
};

export function voucherToWire(v: Voucher): VoucherWire {
  return { ...v, channelId: String(v.channelId), totalUnits: String(v.totalUnits) };
}

export function voucherFromWire(w: VoucherWire): Voucher {
  return { ...w, channelId: BigInt(w.channelId), totalUnits: BigInt(w.totalUnits) };
}

/**
 * Payment terms a provider advertises in its 402 response. x402-shaped —
 * machine-readable terms, no human in the loop — but deliberately not x402:
 * there's no per-request `X-PAYMENT` payload, because per-request on-chain
 * payment is exactly what the protocol fee rules out. A 402 here means "you
 * have no funded channel with me", not "pay for this request".
 */
export interface PaymentRequirements {
  scheme: "strk20-channel";
  network: string;
  asset: string;
  payTo: string;
  resource: string;
  description: string;
  rate: string;
  rateCommitment: string;
  channelId: string;
  settlementContract: string;
  /**
   * Below this many units, settling costs more in protocol fee than the
   * work is worth. Advertised so the consumer can decide up front rather
   * than discover it when a settlement turns out uneconomic.
   */
  minSettlementUnits: string;
  maxTimeoutSeconds: number;
}

export interface PaymentRequired {
  x402Version: 1;
  accepts: PaymentRequirements[];
}
