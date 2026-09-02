/**
 * The anonymizer-contract settlement path (see demo-invoke-devnet.ts),
 * verified end-to-end against real Sepolia infra. Points at the current
 * deployment, which carries the per-channel high-water mark
 * (`settled_units`); the pre-high-water-mark deployment this was first
 * verified against was 0x01d50cb0d1fa94d5912b62b42d64e7ff3d49f517f7b137f3a05daf7641cc9c4f.
 * For the incremental/delta behaviour that mark exists for, see
 * demo-incremental-sepolia.ts.
 *
 * We expected this to need an open-note screening exemption from the pool
 * operator first (see contracts/metering-anonymizer/README.md's earlier
 * version) — it didn't. First real attempt succeeded outright: tx
 * 0x3f3fec75f0e64e079788e08e7a365a1d631cd9863142d248faea597a13221e6,
 * provider note credited with exactly 500 (the on-chain-computed
 * settlement), independently confirmed via discoverNotes(). Whatever
 * default screening policy this pool applies to an unlisted address
 * evidently didn't block it here — worth understanding precisely before
 * relying on it (see the contract README), but not worth blocking on.
 */
import { ec, hash } from "starknet";
import { Open } from "@starkware-libs/starknet-privacy-sdk";
import { createPrivacyClient } from "@strkret/privacy-client";
import { env } from "./env.js";

const ANONYMIZER_ADDRESS = "0x06623cb10adc1ddd5511e6e19ee466943f7d7ce18d1703ca1a3b809a61cbd7a4";

async function waitBlocks(client: Awaited<ReturnType<typeof createPrivacyClient>>, blocks: number): Promise<void> {
  const target = (await client.provider.getBlockNumber()) + blocks;
  while ((await client.provider.getBlockNumber()) < target) {
    await new Promise((r) => setTimeout(r, 15_000));
  }
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

  const escrowAmount = 1000n;
  const rate = 5n;
  const totalUnits = 100n;
  const rateBlind = 42n;
  const channelId = 1n;
  const settlement = rate * totalUnits;

  // Sign with the consumer's real account key — this is the real flow, not
  // the 0x1 test vector demo-invoke-devnet.ts / the Cairo tests use.
  const consumerPubkey = ec.starkCurve.getStarkKey(env.consumer.privateKey);
  const rateCommitment = hash.computePoseidonHashOnElements([rate, rateBlind]);
  const messageHash = hash.computePoseidonHashOnElements([channelId, totalUnits]);
  const sig = ec.starkCurve.sign(messageHash, env.consumer.privateKey);

  // Fresh escrow deposit. Approve for the deposit AND the invoke — each is
  // its own apply_actions call, each charged the pool's ~2 STRK protocol
  // fee independently (see packages/agent-core/src/session.ts's
  // FEE_APPROVAL_BUFFER comment for how this was first discovered).
  const FEE_BUFFER = 3n * 10n ** 18n;
  const approveTx = await consumer.account.execute(
    {
      contractAddress: env.tokenAddress,
      entrypoint: "approve",
      calldata: [env.poolAddress, (escrowAmount + 2n * FEE_BUFFER).toString(), "0"],
    },
    { tip: 0n },
  );
  await consumer.provider.waitForTransaction(approveTx.transaction_hash);
  console.log(`approved: ${approveTx.transaction_hash}`);
  await waitBlocks(consumer, 10);

  const depositBlockId = await consumer.provingBlockId();
  const depositBuild = await consumer.transfers
    .build({ autoRegister: true, autoSetup: true })
    .with(env.tokenAddress, (t) => t.deposit({ amount: escrowAmount }))
    .surplusTo(consumer.account.address)
    .execute({ provingBlockId: depositBlockId });
  const depositHash = await consumer.submit(depositBuild.callAndProof);
  console.log(`deposited: ${depositHash}`);
  await waitBlocks(consumer, 10); // note maturity

  // Withdraw escrow to the anonymizer, declare two Open-amount output notes
  // (provider settlement, consumer refund) on the same token, then invoke.
  // autoSelectNotes: "naive" — not "all" — matters here specifically
  // because this account already holds leftover notes from earlier demo
  // runs this session; "all" would sweep them in and leave an unhandled
  // surplus (the first real attempt at this hit exactly that).
  const settleBlockId = await consumer.provingBlockId();
  const settleBuild = await consumer.transfers
    .build({ autoSetup: true, autoSelectNotes: "naive", autoDiscover: { notes: "refresh" } })
    .with(env.tokenAddress, (t) =>
      t
        .withdraw({ recipient: ANONYMIZER_ADDRESS, amount: escrowAmount })
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
        calldata: [
          env.tokenAddress,
          rate,
          rateBlind,
          rateCommitment,
          channelId,
          totalUnits,
          consumerPubkey,
          "0x" + sig.r.toString(16),
          "0x" + sig.s.toString(16),
          providerNote.noteId,
          refundNote.noteId,
        ],
      };
    })
    .execute({ provingBlockId: settleBlockId });
  const settleHash = await consumer.submit(settleBuild.callAndProof);
  console.log(`\nsettled via anonymizer invoke on Sepolia: ${settleHash}`);
  console.log(`expected settlement: ${settlement} — verify independently via discoverNotes(), don't just trust this script`);
}

main().catch((err) => {
  console.error("\nfailed:");
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
