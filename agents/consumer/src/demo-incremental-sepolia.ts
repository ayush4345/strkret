/**
 * Proves the per-channel high-water mark on real Sepolia: two settlements on
 * the SAME channel_id, where the second voucher is cumulative (150 units
 * against a mark of 100) and must therefore pay only the 50-unit delta.
 *
 * This is the property that makes incremental vouchers safe — a provider can
 * hold a running signed claim off-chain and settle periodically without the
 * consumer being charged twice for units already paid. The Cairo tests cover
 * it in isolation; this covers it against the real pool, real prover and the
 * deployed contract, where the escrow is a genuine shielded note rather than
 * a mock balance.
 *
 * Each round needs its own escrow deposit, because the anonymizer routes out
 * everything it receives in the same call — the escrow is consumed per
 * settlement, only the high-water mark persists between them.
 */
import { Open } from "@starkware-libs/starknet-privacy-sdk";
import { createPoolContract, createPrivacyClient } from "@strkret/privacy-client";
import { claimFromVoucher, encodeInvokeCalldata, signVoucher } from "@strkret/agent-core";
import { env } from "./env.js";

const ANONYMIZER_ADDRESS = "0x0416e8f8426ad158b0802d62035f81f9a3efb89f11b69be7f48ca790b1ec4d7e";

type Client = Awaited<ReturnType<typeof createPrivacyClient>>;

async function waitBlocks(client: Client, blocks: number): Promise<void> {
  const target = (await client.provider.getBlockNumber()) + blocks;
  console.log(`  waiting for block >= ${target}...`);
  while ((await client.provider.getBlockNumber()) < target) {
    await new Promise((r) => setTimeout(r, 15_000));
  }
}

const ESCROW_AMOUNT = 1000n;
const RATE = 5n;
const RATE_BLIND = 42n;
// A channel this account has not settled on before — the mark starts at 0,
// so round 1's delta is its full total. Bump this to rerun from scratch.
const CHANNEL_ID = 11n;
/**
 * What to approve per fee-charged call. Read from the pool rather than
 * hardcoded — Sepolia charges 2 STRK and mainnet 6, so a constant is only
 * right on one network, and being short reverts after the gas is spent.
 */
async function feeBuffer(client: Client): Promise<bigint> {
  const fee = BigInt(await createPoolContract(env.poolAddress, client.provider).get_fee_amount());
  return fee + fee / 2n;
}

/**
 * One full settlement round: fresh escrow in, one anonymizer invoke out.
 * `totalUnits` is cumulative for the channel, so the contract pays
 * `(totalUnits - already_settled) * rate` — the caller says what it expects
 * and we surface both numbers rather than asserting, since the authoritative
 * check is the provider's note balance afterwards.
 */
async function settleRound(
  consumer: Client,
  provider: Client,
  totalUnits: bigint,
  expectedDelta: bigint,
): Promise<string> {
  // Sign through the shared helper so the message stays identical to what
  // the contract verifies — recomputing the hash here is how those drift.
  const voucher = signVoucher(CHANNEL_ID, totalUnits, env.consumer.privateKey);

  const approveTx = await consumer.account.execute(
    {
      contractAddress: env.tokenAddress,
      entrypoint: "approve",
      calldata: [env.poolAddress, (ESCROW_AMOUNT + 2n * (await feeBuffer(consumer))).toString(), "0"],
    },
    { tip: 0n },
  );
  await consumer.provider.waitForTransaction(approveTx.transaction_hash);
  console.log(`  approved: ${approveTx.transaction_hash}`);
  await waitBlocks(consumer, 10);

  const depositBlockId = await consumer.provingBlockId();
  const depositBuild = await consumer.transfers
    .build({ autoRegister: true, autoSetup: true })
    .with(env.tokenAddress, (t) => t.deposit({ amount: ESCROW_AMOUNT }))
    .surplusTo(consumer.account.address)
    .execute({ provingBlockId: depositBlockId });
  const depositHash = await consumer.submit(depositBuild.callAndProof);
  console.log(`  deposited ${ESCROW_AMOUNT}: ${depositHash}`);
  await waitBlocks(consumer, 10); // note maturity

  const settleBlockId = await consumer.provingBlockId();
  const settleBuild = await consumer.transfers
    .build({ autoSetup: true, autoSelectNotes: "naive", autoDiscover: { notes: "refresh" } })
    .with(env.tokenAddress, (t) =>
      t
        .withdraw({ recipient: ANONYMIZER_ADDRESS, amount: ESCROW_AMOUNT })
        .transfer({ recipient: provider.account.address, amount: Open })
        .transfer({ recipient: consumer.account.address, amount: Open }),
    )
    .invoke((args) => {
      const [providerNote, refundNote] = args.openNotes;
      if (!providerNote || !refundNote) {
        throw new Error(`expected 2 open notes, got ${args.openNotes.length}`);
      }
      return {
        contractAddress: ANONYMIZER_ADDRESS,
        calldata: encodeInvokeCalldata(
          env.tokenAddress,
          [claimFromVoucher(voucher, RATE, RATE_BLIND, providerNote.noteId)],
          refundNote.noteId,
        ),
      };
    })
    .execute({ provingBlockId: settleBlockId });
  const settleHash = await consumer.submit(settleBuild.callAndProof);
  console.log(`  settled (cumulative ${totalUnits}, expected delta ${expectedDelta}): ${settleHash}`);
  return settleHash;
}

/** Sum of the provider's discoverable note balances for the escrow token. */
async function providerBalance(provider: Client): Promise<bigint> {
  const { notes } = await provider.transfers.discoverNotes();
  return (notes.get(BigInt(env.tokenAddress)) ?? []).reduce((sum, n) => sum + n.amount, 0n);
}

async function main() {
  const consumer = await createPrivacyClient({
    rpcUrl: env.rpcUrl,
    accountAddress: env.consumer.address,
    accountPrivateKey: env.consumer.privateKey,
    viewingKey: env.consumer.viewingKey,
    poolAddress: env.poolAddress,
    provingServiceUrl: env.provingServiceUrl,
    indexerUrl: env.indexerUrl,
  });
  const provider = await createPrivacyClient({
    rpcUrl: env.rpcUrl,
    accountAddress: env.provider.address,
    accountPrivateKey: env.provider.privateKey,
    viewingKey: env.provider.viewingKey,
    poolAddress: env.poolAddress,
    provingServiceUrl: env.provingServiceUrl,
    indexerUrl: env.indexerUrl,
  });

  const before = await providerBalance(provider);
  console.log(`provider balance before: ${before}`);

  console.log(`\nround 1 — channel ${CHANNEL_ID}, cumulative 100 units (mark 0 -> delta 100)`);
  await settleRound(consumer, provider, 100n, 100n * RATE);
  await waitBlocks(consumer, 10);
  const afterFirst = await providerBalance(provider);
  console.log(`provider balance after round 1: ${afterFirst} (+${afterFirst - before})`);

  console.log(`\nround 2 — same channel, cumulative 150 units (mark 100 -> delta 50)`);
  await settleRound(consumer, provider, 150n, 50n * RATE);
  await waitBlocks(consumer, 10);
  const afterSecond = await providerBalance(provider);
  console.log(`provider balance after round 2: ${afterSecond} (+${afterSecond - afterFirst})`);

  const firstDelta = afterFirst - before;
  const secondDelta = afterSecond - afterFirst;
  console.log(`\nround 1 credited ${firstDelta}, expected ${100n * RATE}`);
  console.log(`round 2 credited ${secondDelta}, expected ${50n * RATE}`);
  if (firstDelta !== 100n * RATE || secondDelta !== 50n * RATE) {
    throw new Error("settlement amounts did not match the expected deltas");
  }
  console.log("\nOK — the second settlement paid only the delta, not the cumulative total.");
}

main().catch((err) => {
  console.error("\nfailed:");
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
