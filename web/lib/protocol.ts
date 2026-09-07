/**
 * Provider-side protocol constants for the public mainnet demo, ported from
 * `agents/provider/src/server.ts`. Both the API route (server) and the
 * client page need `rate`/`rateBlind` to open the commitment when building
 * the settlement calldata, so unlike the standalone provider process, these
 * are exported rather than kept module-private — nothing here is a secret,
 * only the enforcement matters and that lives in the signature check.
 */
import { hash, num, type STRK20_ACTION } from "starknet";

/**
 * Which network this build targets. `NEXT_PUBLIC_*` is inlined at build
 * time, so switching networks means rebuilding (`NEXT_PUBLIC_STRK20_NETWORK=sepolia
 * pnpm --filter @strkret/web run build && … run start`), not a runtime
 * toggle — consistent with how this whole app already works (rebuild on
 * every change), and it keeps a stray env var from silently redirecting a
 * production build at testnet.
 */
export const IS_MAINNET = process.env.NEXT_PUBLIC_STRK20_NETWORK !== "sepolia";

// STRK's address is the same on both networks.
export const STRK_ADDRESS = "0x04718f5a0fc34cc1af16a1cdee98ffb20c31f5cd61d6ab07201858f4287c938d";

const MAINNET_POOL_ADDRESS = "0x040337b1af3c663e86e333bab5a4b28da8d4652a15a69beee2b677776ffe812a";
const SEPOLIA_POOL_ADDRESS = "0x0254a6b2997ef52e9f830ce1f543f6b29768295e8d17e2267d672c552cfe0d91";
export const POOL_ADDRESS = IS_MAINNET ? MAINNET_POOL_ADDRESS : SEPOLIA_POOL_ADDRESS;

const MAINNET_ANONYMIZER = "0x050d3089d17b8552460a9e4b36f5ed95d991493f5f3efaf66d79769cd1840428";
const SEPOLIA_ANONYMIZER = "0x04ca3501bfbc7c6efb292d26ca39f04d3914e61608ecee9aef84fab33312372b";
/** Shown in the terms panel — informational only. This console's own
 * settlement is a plain private transfer, not a call through this contract
 * (see the note in page.tsx's settle step); the anonymizer's on-chain
 * enforcement is proven separately, via the mainnet run in strk20.json. */
export const MAINNET_ANONYMIZER_ADDRESS = IS_MAINNET ? MAINNET_ANONYMIZER : SEPOLIA_ANONYMIZER;

const MAINNET_RPC_URL = "https://mainnet.nodes.starknet.org/rpc/v0_10";
// Hosted Pathfinder node from the STRK20 team's testnet env doc — spec
// 0.10.3-rc.0. HTTP, not HTTPS: fine for local testing over http://localhost,
// but a browser would block it as mixed content behind an HTTPS deployment —
// this network toggle is for local pre-mainnet testing, not for shipping
// Sepolia as a deployed option.
const SEPOLIA_RPC_URL = "http://34.170.198.113:9545/rpc/v0_10";
export const RPC_URL = IS_MAINNET ? MAINNET_RPC_URL : SEPOLIA_RPC_URL;

/** Our own agent's address, the settlement recipient — registered on
 * whichever pool this build targets (both, as of the work done this
 * session). */
const MAINNET_PROVIDER_ADDRESS = "0x005612b5bafd31d1bb96fcba676a095ebf38517e0a8835b3d52c9614fe265bbb";
const SEPOLIA_PROVIDER_ADDRESS = "0x056d7965723f50e81f345081a814dd18c48816c594413a6aa7e08124cdb55b01";
export const PROVIDER_ADDRESS = IS_MAINNET ? MAINNET_PROVIDER_ADDRESS : SEPOLIA_PROVIDER_ADDRESS;

/** Metering unit count — 1 unit per short prompt. This is a COUNT, not an
 * amount: `MeteredSession`/`RemoteService` accumulate it as the voucher's
 * `totalUnits`, and it is deliberately kept separate from `RATE` below.
 * Conflating the two was the original design (unit cost == rate, so the
 * accumulated count and the settled amount were the same number) — cheap to
 * reason about, but it meant every "unit" was worth 1 raw wei. Splitting them
 * is what makes a real per-call price possible without changing what a unit
 * means to the metering layer. */
export const UNITS_PER_BLOCK = 1n;
/** What one unit is worth at settlement — 0.0001 STRK. The contract computes
 * `(total_units - already_settled) × rate`, so N calls settle for exactly
 * N × RATE, independent of UNITS_PER_BLOCK. */
export const RATE = 100_000_000_000_000n; // 0.0001 * 10^18
export const RATE_BLIND = 42n;
export const CHANNEL_ID = 100n;
export const MIN_SETTLEMENT_UNITS = 1n;

export const RATE_COMMITMENT = hash.computePoseidonHashOnElements([RATE, RATE_BLIND]);

/** What the visitor sends the relayer at settle time, on top of the owed
 * amount, to fund the relayer's own settlement — its protocol fee plus gas,
 * both paid from its public balance. Sized generously from observed costs
 * (mainnet: ~6 STRK fee + ~2.5 STRK gas; Sepolia: ~2 + ~2.5), so a settle
 * doesn't fail the relayer's own fee check. Any surplus just sits in the
 * relayer's public balance for the next visitor rather than being wasted —
 * this is the same fee the relayer would otherwise pay out of pocket every
 * time, made visitor-funded instead. It's a flat conservative estimate, not
 * metered to the relayer's actual cost — a real gap, not a rounding
 * artifact: the difference isn't refunded, it just accumulates as the
 * relayer's own reserve. Fixing that for real means batching several
 * visitors into one settlement (the contract already supports it via
 * Span<ProviderClaim>) rather than sizing this buffer more precisely. */
export const RELAYER_FEE_BUFFER = IS_MAINNET ? 10_000_000_000_000_000_000n : 6_000_000_000_000_000_000n;

/** What the demo shields upfront. Equal to the fee buffer above, not a
 * separate small amount — the owed value itself is trivial next to the
 * buffer (a handful of calls at 0.0001 STRK each), so shielding anything
 * less would just leave the later funding withdraw short. There's no
 * withdraw without an existing shielded balance to withdraw from, so this
 * is sized to be exactly what settlement will actually need, not a token
 * gesture that sits unused. */
export const ESCROW_AMOUNT = RELAYER_FEE_BUFFER;

/** Display STRK's 18 decimals without rounding through a floating-point number. */
export function formatStrk(amount: bigint): string {
  const scale = 10n ** 18n;
  const fraction = (amount % scale).toString().padStart(18, "0").replace(/0+$/, "");
  return `${amount / scale}${fraction ? `.${fraction}` : ""}`;
}

// Wallet API amounts and addresses are FELTs: hex without leading-zero padding.
export const shieldAction = (): STRK20_ACTION => ({
  type: "deposit", token: num.toHex(STRK_ADDRESS), amount: num.toHex(ESCROW_AMOUNT),
});

/** `unitCount` is a raw unit count (e.g. `owed` from the metered session);
 * this converts it to the real STRK amount at RATE before building the
 * action, so a plain-transfer settlement charges the same per-call price
 * the relayer path enforces on-chain. */
export const settlementAction = (unitCount: bigint): STRK20_ACTION => ({
  type: "transfer", token: num.toHex(STRK_ADDRESS), amount: num.toHex(unitCount * RATE), recipient: num.toHex(PROVIDER_ADDRESS),
});

/** Unshields `amount` back to `recipient`'s own public balance — the same
 * kind of basic, wallet-native action as shield/settle above (no
 * third-party contract call), so it should relay the same way. */
export const withdrawAction = (amount: bigint, recipient: string): STRK20_ACTION => ({
  type: "withdraw", token: num.toHex(STRK_ADDRESS), amount: num.toHex(amount), recipient: num.toHex(recipient),
});

/** Both endpoints publish the settlement RATE bound by RATE_COMMITMENT.
 * Required `pricing` describes usage counts independently of token amounts. */
export function buildTerms(pricing: { unitsPerBlock: string; charsPerBlock: number }): {
  scheme: "strk20-channel";
  network: string;
  asset: string;
  payTo: string;
  resource: string;
  description: string;
  rate: string;
  pricing: typeof pricing;
  rateCommitment: string;
  channelId: string;
  settlementContract: string;
  minSettlementUnits: string;
  maxTimeoutSeconds: number;
} {
  return {
    scheme: "strk20-channel",
    network: IS_MAINNET ? "starknet-mainnet" : "starknet-sepolia",
    asset: STRK_ADDRESS,
    payTo: PROVIDER_ADDRESS,
    resource: "/api/call",
    description: "llm-inference service, metered per call",
    rate: RATE.toString(),
    pricing,
    rateCommitment: RATE_COMMITMENT,
    channelId: CHANNEL_ID.toString(),
    settlementContract: MAINNET_ANONYMIZER_ADDRESS,
    minSettlementUnits: MIN_SETTLEMENT_UNITS.toString(),
    maxTimeoutSeconds: 3600,
  };
}
