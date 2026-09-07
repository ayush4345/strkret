/**
 * Server-only relayer: bridges the visitor-wallet console to the anonymizer
 * contract. Ready can relay its own native STRK20 actions (deposit,
 * withdraw, transfer) but not a private tx invoking a third-party contract
 * — confirmed directly by the STRK20 team ("ready does not support proofs
 * generated outside of it... have a relayer backend"). This is that
 * relayer: it holds its own registered, already-shielded account and calls
 * `privacy_invoke` on the visitor's behalf, using the real voucher their
 * ephemeral session key signed during metering. The visitor's own wallet
 * action (shield, then the earlier plain-transfer settle) is untouched —
 * this is an additional, real anonymizer settlement for the same signed
 * claim, not a replacement plumbing path.
 *
 * Sepolia only for now: it spends from a pre-shielded reserve and pays the
 * settlement's flat pool fee itself, on every call. That's free on Sepolia
 * testnet STRK; doing the same on mainnet would mean paying every visitor's
 * settlement fee out of pocket, which is a real cost decision, not a code
 * change — see the README before enabling it there.
 */
import { config as loadEnv } from "dotenv";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { Open } from "@starkware-libs/starknet-privacy-sdk";
import { createPrivacyClient } from "@strkret/privacy-client";
import { claimFromVoucher, encodeInvokeCalldata } from "@strkret/agent-core/anonymizer";
import { verifyVoucher, voucherFromWire, type VoucherWire } from "@strkret/agent-core/voucher";
import { UNITS_PER_BLOCK, RATE_BLIND, RATE_COMMITMENT, CHANNEL_ID } from "./protocol";

loadEnv({ path: resolve(dirname(fileURLToPath(import.meta.url)), "../../.env") });

const SEPOLIA_RPC_URL = "http://34.170.198.113:9545/rpc/v0_10";
const SEPOLIA_POOL_ADDRESS = "0x0254a6b2997ef52e9f830ce1f543f6b29768295e8d17e2267d672c552cfe0d91";
const SEPOLIA_ANONYMIZER_ADDRESS = "0x04ca3501bfbc7c6efb292d26ca39f04d3914e61608ecee9aef84fab33312372b";
const SEPOLIA_TOKEN_ADDRESS = "0x04718f5a0fc34cc1af16a1cdee98ffb20c31f5cd61d6ab07201858f4287c938d";

function required(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`relayer: missing env var ${name}`);
  return v;
}

export interface RelaySettleResult {
  transactionHash: string;
}

/**
 * Verify the voucher again server-side (never trust what a client claims
 * about its own signature) and settle it for real through the anonymizer,
 * paid and escrowed by this relayer's own account.
 */
export async function relaySettle(voucherWire: VoucherWire, refundAddress: string): Promise<RelaySettleResult> {
  const voucher = voucherFromWire(voucherWire);
  if (!verifyVoucher(voucher)) throw new Error("voucher signature did not verify");
  if (voucher.channelId !== CHANNEL_ID) throw new Error(`unknown channel ${voucher.channelId}`);
  if (BigInt(voucher.rateCommitment) !== BigInt(RATE_COMMITMENT)) {
    throw new Error("voucher is signed against a different rate");
  }
  if (voucher.totalUnits <= 0n) throw new Error("nothing owed");

  const relayer = await createPrivacyClient({
    rpcUrl: SEPOLIA_RPC_URL,
    poolAddress: SEPOLIA_POOL_ADDRESS,
    accountAddress: required("PROVIDER_ACCOUNT_ADDRESS"),
    accountPrivateKey: required("PROVIDER_ACCOUNT_PRIVATE_KEY"),
    viewingKey: BigInt(required("PROVIDER_VIEWING_KEY")),
    provingServiceUrl: required("PROVING_SERVICE_URL"),
    indexerUrl: process.env.INDEXER_URL || undefined,
  });

  // A small buffer over what's owed, so the refund note is guaranteed
  // non-zero — matching the proven pattern in demo-metered-run.ts, which
  // avoids an edge case in the zero-refund path this relayer has not
  // separately tested.
  const escrowAmount = voucher.totalUnits + 1n;

  const block = await relayer.provingBlockId();
  const build = await relayer.transfers
    .build({ autoSetup: true, autoSelectNotes: "naive", autoDiscover: { notes: "refresh" } })
    .with(SEPOLIA_TOKEN_ADDRESS, (t: any) =>
      t
        .withdraw({ recipient: SEPOLIA_ANONYMIZER_ADDRESS, amount: escrowAmount })
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
        contractAddress: SEPOLIA_ANONYMIZER_ADDRESS,
        calldata: encodeInvokeCalldata(
          SEPOLIA_TOKEN_ADDRESS,
          [claimFromVoucher(voucher, UNITS_PER_BLOCK, RATE_BLIND, providerNote.noteId)],
          refundNote.noteId,
        ),
      };
    })
    .execute({ provingBlockId: block });

  const transactionHash = await relayer.submit(build.callAndProof);
  return { transactionHash };
}
