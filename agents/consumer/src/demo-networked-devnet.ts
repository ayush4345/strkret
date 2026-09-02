/**
 * Same flow as demo-devnet.ts, except the provider is a genuinely separate
 * OS process (agent-provider's `serve` script, spawned here so this stays
 * a single command) talking to the consumer over real HTTP — not an
 * in-process EchoService call. The on-chain side (devnet, register,
 * deposit, settle) is identical; only how the consumer discovers the rate
 * and serves calls changes, via RemoteEchoService.
 */
import { spawn, type ChildProcess } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { Devnet, createDevnetTestEnv } from "@starkware-libs/starknet-privacy-sdk/testing";
import { wrapPrivacyClient } from "@strkret/privacy-client";
import { runSession } from "@strkret/agent-core";
import type { EchoRequest } from "@strkret/agent-provider";
import { RemoteEchoService } from "./remote-echo-service.js";

const PROVIDER_PORT = 4021;
const PROVIDER_URL = `http://localhost:${PROVIDER_PORT}`;
const providerDir = resolve(dirname(fileURLToPath(import.meta.url)), "../../provider");

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

async function waitUntilUp(url: string, timeoutMs = 15_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`${url}/terms`);
      if (res.ok) return;
    } catch {
      // not up yet
    }
    await sleep(300);
  }
  throw new Error(`provider did not come up at ${url} within ${timeoutMs}ms`);
}

async function main() {
  console.log("spawning provider as its own process...");
  const provider: ChildProcess = spawn("npx", ["tsx", "src/server.ts"], {
    cwd: providerDir,
    env: { ...process.env, PORT: String(PROVIDER_PORT) },
    stdio: ["ignore", "pipe", "pipe"],
  });
  provider.stdout?.on("data", (d) => process.stdout.write(`[provider] ${d}`));
  provider.stderr?.on("data", (d) => process.stderr.write(`[provider] ${d}`));

  const devnet = new Devnet();
  try {
    await waitUntilUp(PROVIDER_URL);
    console.log(`provider process up at ${PROVIDER_URL} (pid ${provider.pid})`);

    const testEnv = await createDevnetTestEnv(devnet);
    const consumerClient = wrapPrivacyClient(testEnv.env.alice, testEnv.env.node, testEnv.transfers.alice);
    const providerClient = wrapPrivacyClient(testEnv.env.bob, testEnv.env.node, testEnv.transfers.bob);

    // Consumer discovers the provider's advertised rate over HTTP — it
    // never sees or trusts anything about pricing except this response.
    const service = await RemoteEchoService.connect(PROVIDER_URL);
    console.log(`consumer discovered rate=${service.price()} from ${PROVIDER_URL}/terms`);

    const requests: EchoRequest[] = [{ prompt: "weather" }, { prompt: "translate" }, { prompt: "price" }];

    const result = await runSession(consumerClient, providerClient, service, requests, {
      tokenAddress: testEnv.env.strk,
      poolAddress: testEnv.env.privacy.address,
      depositAmount: 1_000n,
      maturityPollMs: 500,
      onWaitTick: async () => {
        await fetch(devnet.url, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "devnet_createBlock", params: [] }),
        });
      },
    });

    console.log(`\nnetworked devnet run OK — ${result.calls} calls served over real HTTP, ${result.owed} settled, tx hashes:`);
    for (const hash of result.txHashes) console.log(`  ${hash}`);
  } finally {
    provider.kill();
    await devnet.cleanup();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
