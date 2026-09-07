/**
 * Provider-side protocol constants for the public mainnet demo, ported from
 * `agents/provider/src/server.ts`. Both the API route (server) and the
 * client page need `rate`/`rateBlind` to open the commitment when building
 * the settlement calldata, so unlike the standalone provider process, these
 * are exported rather than kept module-private — nothing here is a secret,
 * only the enforcement matters and that lives in the signature check.
 */
import { hash, num, type STRK20_ACTION } from "starknet";

export const STRK_ADDRESS = "0x04718f5a0fc34cc1af16a1cdee98ffb20c31f5cd61d6ab07201858f4287c938d";
export const MAINNET_POOL_ADDRESS = "0x040337b1af3c663e86e333bab5a4b28da8d4652a15a69beee2b677776ffe812a";
export const MAINNET_ANONYMIZER_ADDRESS =
  "0x050d3089d17b8552460a9e4b36f5ed95d991493f5f3efaf66d79769cd1840428";
export const MAINNET_RPC_URL = "https://mainnet.nodes.starknet.org/rpc/v0_10";

/** Our own agent's address, the settlement recipient. */
export const PROVIDER_ADDRESS = "0x005612b5bafd31d1bb96fcba676a095ebf38517e0a8835b3d52c9614fe265bbb";

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
    network: "starknet-mainnet",
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
