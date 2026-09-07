/**
 * The submission run: the anonymizer settlement path against Starknet
 * mainnet, producing the transaction hashes for `strk20.json`.
 *
 * This exercises the contract deployed at
 * 0x050d3089d17b8552460a9e4b36f5ed95d991493f5f3efaf66d79769cd1840428 —
 * the same code verified on Sepolia. A plain `transfer()` run would be
 * simpler, but it would never touch the contract, and demonstrating it is
 * the point of having deployed it.
 *
 * ## Real chain, negligible value
 *
 * The escrow is 1000 raw token units — 1e-15 STRK, effectively nothing.
 * Every transaction, proof and on-chain check is real; only the amount at
 * risk is not. What costs real money is the protocol fee, which is 6 STRK
 * per `apply_actions` regardless of how little moves, so this run costs
 * about 12 STRK on the consumer and 6 on the provider.
 *
 * ## Run it deliberately
 *
 * Starkscan's prover is pilot-phase at 10 proofs a day and each step needs
 * one, so a failed step retried a few times can exhaust the day's budget.
 * Check `.env` points at mainnet before starting, and read the output rather
 * than re-running on a whim.
 */
import { writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { hash } from "starknet";
import { Open } from "@starkware-libs/starknet-privacy-sdk";
import { createPoolContract, createPrivacyClient } from "@strkret/privacy-client";
import { claimFromVoucher, encodeInvokeCalldata, signVoucher } from "@strkret/agent-core";
import { env } from "./env.js";

const ANONYMIZER_ADDRESS = "0x050d3089d17b8552460a9e4b36f5ed95d991493f5f3efaf66d79769cd1840428";
const MAINNET_POOL = "0x040337b1af3c663e86e333bab5a4b28da8d4652a15a69beee2b677776ffe812a";

type Client = Awaited<ReturnType<typeof createPrivacyClient>>;
const txHashes: { step: string; hash: string }[] = [];

async function waitBlocks(client: Client, blocks: number): Promise<void> {
  const target = (await client.provider.getBlockNumber()) + blocks;
  console.log(`  waiting for block >= ${target} (note maturity)…`);
  while ((await client.provider.getBlockNumber()) < target) {
    await new Promise((r) => setTimeout(r, 15_000));
  }
}

function client(who: "consumer" | "provider"): Promise<Client> {
  const acct = env[who];
  return createPrivacyClient({
    rpcUrl: env.rpcUrl,
    accountAddress: acct.address,
    accountPrivateKey: acct.privateKey,
    viewingKey: acct.viewingKey,
    poolAddress: env.poolAddress,
    provingServiceUrl: env.provingServiceUrl,
    // Absent on mainnet: discovery reads the pool directly and decrypts
    // locally, verified equivalent to a hosted indexer on Sepolia.
    indexerUrl: env.indexerUrl,
    starkscanProverApiKey: env.starkscanProverApiKey,
  });
}

async function approve(c: Client, amount: bigint, label: string): Promise<void> {
  const tx = await c.account.execute(
    {
      contractAddress: env.tokenAddress,
      entrypoint: "approve",
      calldata: [env.poolAddress, amount.toString(), "0"],
    },
    { tip: 0n },
  );
  await c.provider.waitForTransaction(tx.transaction_hash);
  console.log(`  [${label}] approved ${amount}: ${tx.transaction_hash}`);
  // An approve has to be visible in the block a proof is generated against,
  // which is 10 behind the head — otherwise the proof sees no allowance and
  // the failure reads as "insufficient allowance" on a deposit that just
  // approved.
  await waitBlocks(c, 10);
}

async function main() {
  if (BigInt(env.poolAddress) !== BigInt(MAINNET_POOL)) {
    throw new Error(`.env POOL_ADDRESS is not the mainnet pool — refusing to run:\n  ${env.poolAddress}`);
  }
  if (!env.starkscanProverApiKey) {
    throw new Error("STARKSCAN_PROVER_KEY is required on mainnet (the prover is a REST relay)");
  }

  const consumer = await client("consumer");
  const provider = await client("provider");
  console.log(`consumer ${consumer.account.address}`);
  console.log(`provider ${provider.account.address}`);

  const fee = BigInt(await createPoolContract(env.poolAddress, consumer.provider).get_fee_amount());
  const feeBuffer = fee + fee / 2n;
  console.log(`pool charges ${fee} per apply_actions; approving ${feeBuffer} per fee-charged call`);

  const escrowAmount = 1000n;
  const rate = 5n;
  const totalUnits = 100n;
  const rateBlind = 42n;
  const channelId = 1n;
  const settlement = rate * totalUnits;

  // --- 1. Provider publishes its viewing key. Nobody can do this for it,
  // and without it there is no channel to credit. ---
  console.log("\n[1/3] provider register");
  await approve(provider, feeBuffer, "provider");
  const regBlock = await provider.provingBlockId();
  const regBuild = await provider.transfers.build().register().execute({ provingBlockId: regBlock });
  const regHash = await provider.submit(regBuild.callAndProof);
  txHashes.push({ step: "provider register", hash: regHash });
  console.log(`  registered: ${regHash}`);

  // --- 2. Consumer shields the escrow, bundling its own registration. ---
  console.log("\n[2/3] consumer deposit");
  await approve(consumer, escrowAmount + 2n * feeBuffer, "consumer");
  const depBlock = await consumer.provingBlockId();
  const depBuild = await consumer.transfers
    .build({ autoRegister: true, autoSetup: true })
    .with(env.tokenAddress, (t) => t.deposit({ amount: escrowAmount }))
    .surplusTo(consumer.account.address)
    .execute({ provingBlockId: depBlock });
  const depHash = await consumer.submit(depBuild.callAndProof);
  txHashes.push({ step: "consumer deposit", hash: depHash });
  console.log(`  deposited ${escrowAmount}: ${depHash}`);
  await waitBlocks(consumer, 10);

  // --- 3. Settle through the anonymizer: withdraw the escrow to it, declare
  // the two output notes, and let the contract decide the split. ---
  console.log("\n[3/3] settle via privacy_invoke");
  const rateCommitment = hash.computePoseidonHashOnElements([rate, rateBlind]);
  const voucher = signVoucher(channelId, totalUnits, rateCommitment, env.consumer.privateKey);
  const setBlock = await consumer.provingBlockId();
  const setBuild = await consumer.transfers
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
        calldata: encodeInvokeCalldata(
          env.tokenAddress,
          [claimFromVoucher(voucher, rate, rateBlind, providerNote.noteId)],
          refundNote.noteId,
        ),
      };
    })
    .execute({ provingBlockId: setBlock });
  const setHash = await consumer.submit(setBuild.callAndProof);
  txHashes.push({ step: "anonymizer settle", hash: setHash });
  console.log(`  settled: ${setHash}`);

  // Read the provider's balance back from the pool rather than trusting the
  // script: the contract computed the split, so the pool is the only
  // authority on what it actually paid.
  await waitBlocks(consumer, 10);
  const { notes } = await provider.transfers.discoverNotes();
  const credited = (notes.get(BigInt(env.tokenAddress)) ?? []).reduce((s, n) => s + n.amount, 0n);

  console.log("\n─── mainnet run complete ───");
  for (const t of txHashes) console.log(`  ${t.step.padEnd(20)} ${t.hash}`);
  console.log(`\nprovider credited ${credited} (expected settlement ${settlement})`);

  const out = resolve(dirname(fileURLToPath(import.meta.url)), "../../../strk20.json");
  const doc = JSON.parse(
    (await import("node:fs")).readFileSync(out, "utf8"),
  ) as Record<string, unknown>;
  doc.transactions = txHashes.map((t) => ({ step: t.step, hash: t.hash, network: "mainnet" }));
  writeFileSync(out, `${JSON.stringify(doc, null, 2)}\n`);
  console.log(`\nwrote ${txHashes.length} transaction hashes to strk20.json`);

  if (credited !== settlement) {
    throw new Error(`provider credited ${credited}, expected ${settlement}`);
  }
}

main().catch((err) => {
  console.error("\nfailed:");
  console.error(err instanceof Error ? err.message : err);
  if (txHashes.length) {
    console.error("\ntransactions that did land, for the record:");
    for (const t of txHashes) console.error(`  ${t.step}: ${t.hash}`);
  }
  process.exit(1);
});
