/**
 * The anonymizer-contract settlement path, proven end-to-end against a
 * local devnet: deploys `contracts/metering-anonymizer` fresh, then runs
 * register -> deposit -> withdraw-to-helper -> invoke (on-chain signature +
 * rate-commitment verification, settlement computed in Cairo) -> two
 * OpenNoteDeposits (provider settlement, consumer refund).
 *
 * This is the alternative to demo-devnet.ts's plain transfer(): that path
 * hides the settlement amount but trusts the consumer to send the right
 * one; this path makes the settlement amount public but proves it's
 * correct. See the root README's "Anonymizer contract" section.
 */
import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { Devnet, createDevnetTestEnv } from "@starkware-libs/starknet-privacy-sdk/testing";
import { Open } from "@starkware-libs/starknet-privacy-sdk";
import type { CallAndProof } from "@starkware-libs/starknet-privacy-sdk";
import { ec, hash } from "starknet";
import type { Account, RpcProvider } from "starknet";

const CONTRACT_DIR = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "../../../contracts/metering-anonymizer",
);

async function forceBlocks(devnetUrl: string, count: number): Promise<void> {
  for (let i = 0; i < count; i++) {
    await fetch(devnetUrl, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "devnet_createBlock", params: [] }),
    });
  }
}

async function declareClass(account: Account, node: RpcProvider, classPath: string, compiledPath: string): Promise<string> {
  const contractClass = JSON.parse(readFileSync(classPath, "utf8"));
  const compiledClass = JSON.parse(readFileSync(compiledPath, "utf8"));
  const classHash = hash.computeContractClassHash(contractClass);
  try {
    await node.getClass(classHash);
    return classHash;
  } catch {
    // not declared yet
  }
  const { transaction_hash } = await account.declare({ contract: contractClass, casm: compiledClass });
  await node.waitForTransaction(transaction_hash);
  return classHash;
}

async function deployContract(account: Account, node: RpcProvider, classHash: string): Promise<string> {
  const { transaction_hash, contract_address } = await account.deployContract({ classHash, constructorCalldata: [] });
  await node.waitForTransaction(transaction_hash);
  return contract_address;
}

async function submit(account: Account, node: RpcProvider, callAndProof: CallAndProof): Promise<string> {
  const proofDetails = callAndProof.proof.proofFacts?.length
    ? { proofFacts: callAndProof.proof.proofFacts, proof: callAndProof.proof.data }
    : {};
  const tx = await account.execute(callAndProof.call, { tip: 0n, ...proofDetails });
  await node.waitForTransaction(tx.transaction_hash);
  return tx.transaction_hash;
}

// `Role::AppGovernor` / `Role::AppRoleAdmin` role ids and
// `OpenNoteScreeningPolicy::Exempt`'s variant index — see
// starknet-privacy's e2e/src/screening-policy.ts. An Invoke target that
// funds open notes and carries no policy becomes the tx's screening
// subject, so a real (non-devnet) deployment needs the pool operator to
// grant this exemption — we can't do it ourselves outside devnet, where we
// happen to hold admin.
const POLICY_EXEMPT = 1n;
const ROLE_APP_GOVERNOR = "0xd2ead78c620e94b02d0a996e99298c59ddccfa1d8a0149080ac3a20de06068";
const ROLE_APP_ROLE_ADMIN = "0x3e615638e0b79444a70f8c695bf8f2a47033bf1cf95691ec3130f64939cee99";

async function exemptOpenNoteDepositor(admin: Account, node: RpcProvider, poolAddress: string, depositor: string): Promise<void> {
  const { transaction_hash } = await admin.execute([
    { contractAddress: poolAddress, entrypoint: "grant_role", calldata: [ROLE_APP_ROLE_ADMIN, admin.address] },
    { contractAddress: poolAddress, entrypoint: "grant_role", calldata: [ROLE_APP_GOVERNOR, admin.address] },
    { contractAddress: poolAddress, entrypoint: "set_open_note_screening_policy", calldata: [depositor, POLICY_EXEMPT] },
  ]);
  await node.waitForTransaction(transaction_hash);
}

async function main() {
  const devnet = new Devnet();
  try {
    const testEnv = await createDevnetTestEnv(devnet);
    const { alice: consumer, bob: provider, admin, node, strk, privacy } = testEnv.env;

    console.log("declaring + deploying MeteringAnonymizer on devnet...");
    const classHash = await declareClass(
      admin,
      node,
      join(CONTRACT_DIR, "target/dev/metering_anonymizer_MeteringAnonymizer.contract_class.json"),
      join(CONTRACT_DIR, "target/dev/metering_anonymizer_MeteringAnonymizer.compiled_contract_class.json"),
    );
    const anonymizerAddress = await deployContract(admin, node, classHash);
    console.log(`  deployed: ${anonymizerAddress}`);
    await exemptOpenNoteDepositor(admin, node, privacy.address, anonymizerAddress);
    console.log(`consumer=${consumer.address} provider=${provider.address}`);

    // Same test vector as the Cairo test suite: private_key = 0x1, so the
    // signature this script produces and the one the Cairo test hardcodes
    // are directly comparable.
    const consumerPrivateKey = "0x1";
    const consumerPubkey = ec.starkCurve.getStarkKey(consumerPrivateKey);
    const channelId = 1n;
    const totalUnits = 100n;
    const rate = 5n;
    const rateBlind = 42n;
    const rateCommitment = hash.computePoseidonHashOnElements([rate, rateBlind]);
    const messageHash = hash.computePoseidonHashOnElements([channelId, totalUnits]);
    const sig = ec.starkCurve.sign(messageHash, consumerPrivateKey);
    const escrowAmount = 1000n;
    const settlement = rate * totalUnits;

    // Provider must register its own viewing key before it can receive
    // anything — nobody can do this on its behalf.
    const registerBlockId = (await node.getBlockNumber()) - 10;
    const { callAndProof: registerCall } = await testEnv.transfers.bob.build().register().execute({ provingBlockId: registerBlockId });
    await submit(provider, node, registerCall);
    await forceBlocks(devnet.url, 10);
    console.log("provider registered");

    // Plain ERC20 approve before any pool action — covers the deposit plus
    // a fee buffer (see packages/agent-core/src/session.ts for why a fee
    // buffer matters on a real deployment; devnet's fee_amount is 0, so
    // this is just safety margin here).
    const approveTx = await consumer.execute(
      { contractAddress: strk, entrypoint: "approve", calldata: [privacy.address, (escrowAmount + 10n ** 19n).toString(), "0"] },
      { tip: 0n },
    );
    await node.waitForTransaction(approveTx.transaction_hash);
    await forceBlocks(devnet.url, 10);
    console.log("approved pool");

    const depositBlockId = (await node.getBlockNumber()) - 10;
    const { callAndProof: depositCall } = await testEnv.transfers.alice
      .build({ autoRegister: true, autoSetup: true })
      .with(strk, (t) => t.deposit({ amount: escrowAmount }))
      .surplusTo(consumer.address)
      .execute({ provingBlockId: depositBlockId });
    await submit(consumer, node, depositCall);
    console.log("deposited escrow");
    await forceBlocks(devnet.url, 10); // note maturity

    // Withdraw escrow to the anonymizer, declare two Open-amount output
    // notes (provider settlement, consumer refund) on the SAME token as
    // the withdrawal, then invoke. The SDK hands back one InvokeOpenNote
    // per declared Open transfer, in declaration order.
    const settleBlockId = (await node.getBlockNumber()) - 10;
    const { callAndProof: settleCall } = await testEnv.transfers.alice
      .build({ autoSetup: true, autoSelectNotes: "all", autoDiscover: { notes: "refresh" } })
      .with(strk, (t) =>
        t
          .withdraw({ recipient: anonymizerAddress, amount: escrowAmount })
          .transfer({ recipient: provider.address, amount: Open })
          .transfer({ recipient: consumer.address, amount: Open }),
      )
      .invoke((args) => {
        const [providerNote, refundNote] = args.openNotes;
        if (!providerNote || !refundNote) {
          throw new Error(`expected 2 open notes, got ${args.openNotes.length}`);
        }
        return {
          contractAddress: anonymizerAddress,
          calldata: [
            strk,
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
    const settleHash = await submit(consumer, node, settleCall);
    console.log(`settled via anonymizer invoke: ${settleHash}`);
    await forceBlocks(devnet.url, 10);

    const { notes: providerNotes } = await testEnv.transfers.bob.discoverNotes();
    const providerStrk = (providerNotes.get(BigInt(strk)) ?? []).reduce((sum, n) => sum + n.amount, 0n);
    const { notes: consumerNotes } = await testEnv.transfers.alice.discoverNotes();
    const consumerStrk = (consumerNotes.get(BigInt(strk)) ?? []).reduce((sum, n) => sum + n.amount, 0n);

    console.log(`\nprovider STRK notes: ${providerStrk} (expected settlement ${settlement})`);
    console.log(`consumer STRK notes: ${consumerStrk} (refund, on-chain-computed)`);

    if (providerStrk === settlement) {
      console.log("\nPASS — provider received exactly the on-chain-enforced settlement amount.");
    } else {
      console.log("\nFAIL — provider balance does not match the expected settlement.");
      process.exitCode = 1;
    }
  } finally {
    await devnet.cleanup();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
