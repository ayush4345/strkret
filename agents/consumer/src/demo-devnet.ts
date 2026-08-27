/**
 * Same flow as demo.ts, against a local Starknet devnet instead of real
 * infra: no RPC/pool/token/prover/indexer env vars needed. The SDK's test
 * harness spawns a devnet, deploys the real privacy pool contract, and
 * hands back funded accounts (alice, bob) wired with real PrivateTransfers
 * clients. Good enough to prove the flow end-to-end before touching Sepolia
 * or mainnet, where those services actually have to be real.
 */
import { Devnet, createDevnetTestEnv } from "@starkware-libs/starknet-privacy-sdk/testing";
import { wrapPrivacyClient } from "@strkret/privacy-client";
import { runSession } from "@strkret/agent-core";
import { EchoService, type EchoRequest } from "@strkret/agent-provider";

async function main() {
  const devnet = new Devnet();

  try {
    const testEnv = await createDevnetTestEnv(devnet);
    const consumerClient = wrapPrivacyClient(testEnv.env.alice, testEnv.env.node, testEnv.transfers.alice);
    const providerClient = wrapPrivacyClient(testEnv.env.bob, testEnv.env.node, testEnv.transfers.bob);

    console.log(`devnet RPC: ${devnet.url}`);
    console.log(`privacy pool: ${testEnv.env.privacy.address}`);
    console.log(`token (STRK): ${testEnv.env.strk}`);

    const service = new EchoService(10n);
    const requests: EchoRequest[] = [{ prompt: "weather" }, { prompt: "translate" }, { prompt: "price" }];

    const result = await runSession(consumerClient, providerClient, service, requests, {
      tokenAddress: testEnv.env.strk,
      poolAddress: testEnv.env.privacy.address,
      depositAmount: 1_000n,
      maturityPollMs: 500, // devnet mines fast — no need to wait 15s per poll
      // devnet's default block-generation mode only mines on a transaction;
      // the block-wait loops submit none, so force an empty block each tick.
      // The documented POST /create_block REST route 404s on this devnet
      // version — devnet_createBlock over JSON-RPC is what actually works.
      onWaitTick: async () => {
        await fetch(devnet.url, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "devnet_createBlock", params: [] }),
        });
      },
    });

    console.log(`\ndevnet run OK — ${result.calls} calls, ${result.owed} settled, tx hashes:`);
    for (const hash of result.txHashes) console.log(`  ${hash}`);
  } finally {
    await devnet.cleanup();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
