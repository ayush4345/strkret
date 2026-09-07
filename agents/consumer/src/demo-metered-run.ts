/**
 * The submission run: meter a real session, then settle it once through the
 * anonymizer. Works on either network — it reads which from `.env` and
 * adapts, because the two differ in ways that matter (see below).
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
 * ## It meters a real session first
 *
 * Twelve calls are served and signed for before anything settles. Settling
 * after one or two would produce the transaction hashes just as well and
 * demonstrate the opposite of the argument — the whole claim is that a flat
 * per-settlement fee is amortised across many off-chain calls, and a run that
 * settles immediately pays the same fee for one call.
 *
 * The provider is priced at 1 unit per block for this run, and that is not
 * cosmetic: a voucher's `total_units` is a COUNT the contract multiplies by
 * `rate`, while the metering layer accumulates `price()`. Unless a unit costs
 * exactly `rate`, settling a metered voucher multiplies twice. At 1 they are
 * the same number.
 *
 * ## Run it deliberately
 *
 * Starkscan's prover is pilot-phase at 10 proofs a day and each step needs
 * one, so a failed step retried a few times can exhaust the day's budget.
 * Check `.env` points at mainnet before starting, and read the output rather
 * than re-running on a whim.
 */
import { spawn, type ChildProcess } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { hash } from "starknet";
import { Open } from "@starkware-libs/starknet-privacy-sdk";
import { createPoolContract, createPrivacyClient } from "@strkret/privacy-client";
import { MeteredSession, claimFromVoucher, encodeInvokeCalldata, signVoucher } from "@strkret/agent-core";
import { RemoteEchoService } from "./remote-echo-service.js";
import { env } from "./env.js";

const MAINNET_POOL = "0x040337b1af3c663e86e333bab5a4b28da8d4652a15a69beee2b677776ffe812a";
const MAINNET_ANONYMIZER = "0x050d3089d17b8552460a9e4b36f5ed95d991493f5f3efaf66d79769cd1840428";
const SEPOLIA_ANONYMIZER = "0x04ca3501bfbc7c6efb292d26ca39f04d3914e61608ecee9aef84fab33312372b";

/** Same contract code on both networks; only the instance differs. */
const IS_MAINNET = BigInt(env.poolAddress) === BigInt(MAINNET_POOL);
const ANONYMIZER_ADDRESS =
  process.env.ANONYMIZER_ADDRESS ?? (IS_MAINNET ? MAINNET_ANONYMIZER : SEPOLIA_ANONYMIZER);
const PROVIDER_PORT = 4031;
const PROVIDER_URL = `http://localhost:${PROVIDER_PORT}`;
const providerDir = resolve(dirname(fileURLToPath(import.meta.url)), "../../provider");

/**
 * Explicit bounds, so starknet.js skips fee estimation.
 *
 * Estimation is a separate RPC round trip, and the node that can actually
 * submit transactions on mainnet rejects the estimate as EMPTY_PROOF_FACTS —
 * it does not carry the STRK20 proof extension through that path, even
 * though submission itself does. The only node that estimates these
 * correctly refuses to submit at all.
 *
 * Mainnet only. Sepolia's hosted node carries the proof extension through
 * its estimate path, so estimating there is both correct and safer than a
 * guessed ceiling.
 *
 * Sized from a real observed estimate (~128M l2 gas at ~42.5 gfri) with
 * headroom, and deliberately not more: the account has to cover its own
 * bound, so an over-generous reservation fails validation as surely as a
 * too-small one fails execution. This reserves roughly 8 STRK.
 *
 * Note the 6 STRK protocol fee is not gas — the pool pulls it as an ERC20
 * transfer under the allowance approved earlier, so it sits outside these
 * bounds entirely.
 */
const BOUNDS_MAINNET = {
  // A zero max_price is rejected even when max_amount is zero: the ceiling is
  // compared against the live gas price regardless of how little is used.
  l1_gas: { max_amount: 100n, max_price_per_unit: 300_000_000_000_000n },
  l2_gas: { max_amount: 130_000_000n, max_price_per_unit: 50_000_000_000n },
  l1_data_gas: { max_amount: 20_000n, max_price_per_unit: 5_000_000_000_000n },
};
const BOUNDS = IS_MAINNET ? BOUNDS_MAINNET : undefined;

/** Questions to actually buy. Enough that one settlement covers real work. */
const PROMPTS = [
  "What is a nullifier in a shielded pool?",
  "Why do flat per-transaction fees break micropayments?",
  "What does a payment channel let two parties avoid?",
  "What is a viewing key used for?",
  "Explain a high-water mark in one sentence.",
  "Why batch settlements instead of paying per call?",
  "What is note maturity on Starknet?",
  "What does a rate commitment bind?",
  "Why sign a cumulative total rather than a per-call amount?",
  "What is an open note?",
  "Why is metering kept off-chain here?",
  "What does the anonymizer contract enforce?",
];

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
  if (IS_MAINNET && !env.starkscanProverApiKey) {
    throw new Error("STARKSCAN_PROVER_KEY is required on mainnet (the prover is a REST relay)");
  }
  console.log(`network: ${IS_MAINNET ? "MAINNET — real funds" : "Sepolia"}`);
  console.log(`anonymizer: ${ANONYMIZER_ADDRESS}`);

  const consumer = await client("consumer");
  const provider = await client("provider");
  console.log(`consumer ${consumer.account.address}`);
  console.log(`provider ${provider.account.address}`);

  const fee = BigInt(await createPoolContract(env.poolAddress, consumer.provider).get_fee_amount());
  const feeBuffer = fee + fee / 2n;
  console.log(`pool charges ${fee} per apply_actions; approving ${feeBuffer} per fee-charged call`);

  const escrowAmount = 1000n;
  // 1 unit per block, so the metered amount and the unit count coincide —
  // see the header. rateBlind and channelId must match what the provider
  // publishes, since the voucher is signed over its commitment.
  const rate = 1n;
  const rateBlind = 42n;
  // The mark persists on-chain per (consumer, channel), so a rerun needs a
  // channel this consumer has not settled on before.
  const channelId = BigInt(process.env.CHANNEL_ID ?? 7);

  // --- 1. Provider publishes its viewing key. Nobody can do this for it,
  // and without it there is no channel to credit. ---
  // The provider runs as its own process, priced to match the rate the
  // contract will verify against.
  const providerProc: ChildProcess = spawn("npx", ["tsx", "src/server.ts"], {
    cwd: providerDir,
    env: {
      ...process.env,
      PORT: String(PROVIDER_PORT),
      TOKEN_ADDRESS: env.tokenAddress,
      UNITS_PER_BLOCK: rate.toString(),
      RATE_BLIND: rateBlind.toString(),
      CHANNEL_ID: channelId.toString(),
      STARKNET_NETWORK: "starknet-mainnet",
      PROVIDER_ADDRESS: env.provider.address,
      ANONYMIZER_ADDRESS,
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  providerProc.stdout?.on("data", (d) => process.stdout.write(`[provider] ${d}`));
  providerProc.stderr?.on("data", (d) => process.stderr.write(`[provider] ${d}`));
  process.on("exit", () => providerProc.kill());
  for (let i = 0; i < 40; i++) {
    try {
      if ((await fetch(`${PROVIDER_URL}/terms`)).ok) break;
    } catch {
      /* not up yet */
    }
    await new Promise((r) => setTimeout(r, 300));
  }

  console.log("\n[1/4] provider register");
  if (process.env.SKIP_PROVIDER_REGISTER) {
    // Registration is permanent per account. Re-running it reverts, and on
    // mainnet that revert still costs gas and one of the day's 10 proofs.
    console.log("  skipped (SKIP_PROVIDER_REGISTER set — already registered)");
  } else {
  await approve(provider, feeBuffer, "provider");
  // Re-registering a viewing key reverts with NON_ZERO_VALUE; on a rerun the
  // provider is already registered and that is fine.
  try {
    const regBlock = await provider.provingBlockId();
    const regBuild = await provider.transfers.build().register().execute({ provingBlockId: regBlock });
    const regHash = await provider.submit(regBuild.callAndProof, BOUNDS);
    txHashes.push({ step: "provider register", hash: regHash });
    console.log(`  registered: ${regHash}`);
  } catch (err) {
    console.log(`  register skipped (already registered): ${(err as Error).message.slice(0, 120)}`);
  }
  }

  // --- 2. Consumer shields the escrow, bundling its own registration. ---
  console.log("\n[2/4] consumer deposit");
  await approve(consumer, escrowAmount + 2n * feeBuffer, "consumer");
  const depBlock = await consumer.provingBlockId();
  const depBuild = await consumer.transfers
    .build({ autoRegister: true, autoSetup: true })
    .with(env.tokenAddress, (t) => t.deposit({ amount: escrowAmount }))
    .surplusTo(consumer.account.address)
    .execute({ provingBlockId: depBlock });
  const depHash = await consumer.submit(depBuild.callAndProof, BOUNDS);
  txHashes.push({ step: "consumer deposit", hash: depHash });
  console.log(`  deposited ${escrowAmount}: ${depHash}`);
  await waitBlocks(consumer, 10);

  // --- 3. Meter a real session off-chain. No chain contact per call: this
  // is the part that is free, and the part the single settlement pays for. ---
  console.log(`\n[3/4] metering ${PROMPTS.length} calls off-chain`);
  const service = await RemoteEchoService.open(PROVIDER_URL, env.consumer.privateKey, env.tokenAddress);
  const session = new MeteredSession(service);
  for (const [i, prompt] of PROMPTS.entries()) {
    const { result, cost } = await session.call({ prompt });
    const answer = (result as { completion: string }).completion.replace(/\s+/g, " ");
    console.log(`  ${String(i + 1).padStart(2)}. (${cost}u) ${answer.slice(0, 88)}…`);
  }
  const totalUnits = session.owed;
  const settlement = totalUnits * rate;
  console.log(`  ${session.calls} calls served, ${totalUnits} units owed — chain untouched throughout`);

  // --- 4. One settlement for all of it. ---
  console.log("\n[4/4] settle via privacy_invoke");
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
  const setHash = await consumer.submit(setBuild.callAndProof, BOUNDS);
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
  const doc = JSON.parse(readFileSync(out, "utf8")) as Record<string, unknown>;
  doc.transactions = txHashes.map((t) => ({ step: t.step, hash: t.hash, network: "mainnet" }));
  writeFileSync(out, `${JSON.stringify(doc, null, 2)}\n`);
  console.log(`\nwrote ${txHashes.length} transaction hashes to strk20.json`);
  providerProc.kill();

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
