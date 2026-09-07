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

/** 1 unit per prompt, matching `demo-metered-run.ts` — see its header for why
 * that specific value is load-bearing (units and settled price must match). */
export const UNITS_PER_BLOCK = 1n;
export const RATE_BLIND = 42n;
export const CHANNEL_ID = 100n;
export const MIN_SETTLEMENT_UNITS = 1n;

export const RATE_COMMITMENT = hash.computePoseidonHashOnElements([UNITS_PER_BLOCK, RATE_BLIND]);

/** The escrow the demo shields — trivially small, matching the mainnet run.
 * The real cost a visitor pays is the flat protocol fee, not this amount:
 * that gap is the whole point of the project. */
export const ESCROW_AMOUNT = 1000n;

// Wallet API amounts and addresses are FELTs: hex without leading-zero padding.
export const shieldAction = (): STRK20_ACTION => ({
  type: "deposit", token: num.toHex(STRK_ADDRESS), amount: num.toHex(ESCROW_AMOUNT),
});

export const settlementAction = (amount: bigint): STRK20_ACTION => ({
  type: "transfer", token: num.toHex(STRK_ADDRESS), amount: num.toHex(amount), recipient: num.toHex(PROVIDER_ADDRESS),
});

/** The `accepts` terms both /api/terms and /api/call publish, mirroring
 * `paymentRequired()` in `agents/provider/src/server.ts`. */
export function buildTerms(pricing: { unitsPerBlock: string; charsPerBlock: number }, rate: bigint): {
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
    rate: rate.toString(),
    pricing,
    rateCommitment: RATE_COMMITMENT,
    channelId: CHANNEL_ID.toString(),
    settlementContract: MAINNET_ANONYMIZER_ADDRESS,
    minSettlementUnits: MIN_SETTLEMENT_UNITS.toString(),
    maxTimeoutSeconds: 3600,
  };
}
