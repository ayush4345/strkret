/**
 * Server-only relayer: bridges the visitor-wallet console to the anonymizer
 * contract. Ready can relay its own native STRK20 actions (deposit,
 * withdraw, transfer) but not a private tx invoking a third-party contract
 * — confirmed directly by the STRK20 team ("ready does not support proofs
 * generated outside of it... have a relayer backend"). This is that
 * relayer: it calls `privacy_invoke` on the visitor's behalf, using the
 * real voucher their ephemeral session key signed during metering.
 *
 * On Sepolia the relayer spends from its own pre-shielded reserve — free on
 * testnet STRK. On mainnet that would mean paying every visitor's
 * settlement fee out of pocket, so instead the visitor's own settle
 * transfer (see page.tsx) sends enough to cover both the owed amount and
 * this relayer's own fee+gas; the relayer only draws down what that
 * transfer just funded, once it has matured. Same function either way —
 * only the source of the escrow differs, and that's the visitor's wallet
 * action, not this file.
 *
 * Requires the relayer account to have already approved the pool for its
 * protocol fee — the pool pulls it via `transferFrom`, and approving inside
 * this hot path would add a ~10-block wait to every visitor's settle.
 * Approve it once, generously, out of band:
 *   account.execute({ contractAddress: TOKEN, entrypoint: "approve",
 *     calldata: [POOL, amount, "0"] })
 * then let the approve's block + 10 pass before the next settle.
 */
import { config as loadEnv } from "dotenv";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { Open } from "@starkware-libs/starknet-privacy-sdk";
import { createPrivacyClient } from "@strkret/privacy-client";
import { claimFromVoucher, encodeInvokeCalldata } from "@strkret/agent-core/anonymizer";
import { verifyVoucher, voucherFromWire, type VoucherWire } from "@strkret/agent-core/voucher";
import {
  IS_MAINNET, RPC_URL, POOL_ADDRESS, MAINNET_ANONYMIZER_ADDRESS, STRK_ADDRESS,
  RATE, RATE_BLIND, RATE_COMMITMENT, CHANNEL_ID,
} from "./protocol";

loadEnv({ path: resolve(dirname(fileURLToPath(import.meta.url)), "../../.env") });

function required(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`relayer: missing env var ${name}`);
  return v;
}

// Mainnet has no JSON-RPC prover; Starkscan runs a REST relay in front of
// one instead. Its key isn't a standalone env var — it's embedded in
// MAINNET_RPC_URL (…/rpc/v0_10/SN_MAIN/<key>), the same place
// demo-metered-run.ts and test-mainnet-register.ts pull it from.
const MAINNET_PROVER_URL = "https://api.starkscan.co/v1/SN_MAIN";
function starkscanProverKey(): string {
  const url = required("MAINNET_RPC_URL");
  const key = url.split("/").pop();
  if (!key?.startsWith("mzk_live_key_")) throw new Error("relayer: could not extract the Starkscan key from MAINNET_RPC_URL");
  return key;
}

// starknet.js's own estimateFee has a client-side bug on the mainnet path
// (unrelated to the node), so mainnet submissions pass explicit bounds and
// skip estimation entirely — sized from a real observed mainnet run, see
// demo-metered-run.ts's BOUNDS_MAINNET for the full rationale.
const BOUNDS_MAINNET = {
  l1_gas: { max_amount: 100n, max_price_per_unit: 300_000_000_000_000n },
  l2_gas: { max_amount: 130_000_000n, max_price_per_unit: 50_000_000_000n },
  l1_data_gas: { max_amount: 20_000n, max_price_per_unit: 5_000_000_000_000n },
};

export interface RelaySettleResult {
  transactionHash: string;
}

/**
 * Verify the voucher again server-side (never trust what a client claims
 * about its own signature) and settle it for real through the anonymizer.
 */
export async function relaySettle(voucherWire: VoucherWire, refundAddress: string): Promise<RelaySettleResult> {
  const voucher = voucherFromWire(voucherWire);
  if (!verifyVoucher(voucher)) throw new Error("voucher signature did not verify");
  if (voucher.channelId !== CHANNEL_ID) throw new Error(`unknown channel ${voucher.channelId}`);
  if (BigInt(voucher.rateCommitment) !== BigInt(RATE_COMMITMENT)) {
    throw new Error("voucher is signed against a different rate");
  }
  if (voucher.totalUnits <= 0n) throw new Error("nothing owed");

  const accountAddress = required(IS_MAINNET ? "MAINNET_PROVIDER_ACCOUNT_ADDRESS" : "PROVIDER_ACCOUNT_ADDRESS");
  const accountPrivateKey = required(IS_MAINNET ? "MAINNET_PROVIDER_ACCOUNT_PRIVATE_KEY" : "PROVIDER_ACCOUNT_PRIVATE_KEY");
  const viewingKey = BigInt(required(IS_MAINNET ? "MAINNET_PROVIDER_VIEWING_KEY" : "PROVIDER_VIEWING_KEY"));

  const relayer = await createPrivacyClient({
    rpcUrl: RPC_URL,
    poolAddress: POOL_ADDRESS,
    accountAddress,
    accountPrivateKey,
    viewingKey,
    provingServiceUrl: IS_MAINNET ? MAINNET_PROVER_URL : required("PROVING_SERVICE_URL"),
    indexerUrl: IS_MAINNET ? undefined : (process.env.INDEXER_URL || undefined),
    starkscanProverApiKey: IS_MAINNET ? starkscanProverKey() : undefined,
  });

  // The contract pays `total_units * RATE`, not `total_units` — escrow has
  // to cover the real STRK value, not the raw unit count. One extra unit's
  // worth of RATE as buffer guarantees the refund note is non-zero, matching
  // the proven pattern in demo-metered-run.ts.
  const escrowAmount = voucher.totalUnits * RATE + RATE;

  const block = await relayer.provingBlockId();
  let build;
  try {
    build = await relayer.transfers
      .build({ autoSetup: true, autoSelectNotes: "naive", autoDiscover: { notes: "refresh" } })
      .with(STRK_ADDRESS, (t: any) =>
        t
          .withdraw({ recipient: MAINNET_ANONYMIZER_ADDRESS, amount: escrowAmount })
          .transfer({ recipient: relayer.account.address, amount: Open })
          .transfer({ recipient: refundAddress, amount: Open }),
      )
      .surplusTo(relayer.account.address)
      .invoke((args: any) => {
        const [providerNote, refundNote] = args.openNotes;
        if (!providerNote || !refundNote) {
          throw new Error(`expected 2 open notes, got ${args.openNotes.length}`);
        }
        return {
          contractAddress: MAINNET_ANONYMIZER_ADDRESS,
          calldata: encodeInvokeCalldata(
            STRK_ADDRESS,
            [claimFromVoucher(voucher, RATE, RATE_BLIND, providerNote.noteId)],
            refundNote.noteId,
          ),
        };
      })
      .execute({ provingBlockId: block });
  } catch (err) {
    // Starkscan's mainnet prover has a hard daily budget (10 proofs/key)
    // that resets on its own schedule, not ours — surface that plainly
    // rather than the raw 429 body, which reads like a crash on screen.
    const msg = err instanceof Error ? err.message : String(err);
    if (msg.includes("prover_daily_budget_exhausted")) {
      throw new Error(
        "The relayer's mainnet prover has hit its daily proof limit (10/day) and will reset later today — " +
          "this is a real, live constraint, not a bug. Try again after the reset, or on Sepolia in the meantime.",
      );
    }
    throw err;
  }

  const transactionHash = await relayer.submit(build.callAndProof, IS_MAINNET ? BOUNDS_MAINNET : undefined);
  return { transactionHash };
}
