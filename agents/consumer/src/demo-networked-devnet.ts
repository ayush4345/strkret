/**
 * Same flow as demo-devnet.ts, except the provider is a genuinely separate
 * OS process (agent-provider's `serve` script, spawned here so this stays
 * a single command) talking to the consumer over real HTTP — not an
 * in-process EchoService call. The consumer opens a channel through the
 * provider's 402 handshake, then carries a running signed voucher on every
 * call, so the provider holds an enforceable claim for everything it serves
 * without touching the chain.
 *
 * Also exercises threshold-triggered settlement: with three calls at rate
 * 10 and a threshold of 20, this settles mid-session and again at close —
 * two settlements rather than one, which is what batching looks like when
 * a session outgrows a single settlement's worth of value.
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

// The key the consumer signs usage vouchers with. Same test vector the
// Cairo suite and demo-invoke-devnet.ts use (private_key = 0x1) so the
// signatures here are checkable against those. In a real deployment this is
// the consumer's own key, and the provider pins the pubkey it agreed the
// channel with — otherwise anyone can sign a valid voucher with their own
// key and be served for free.
const CONSUMER_VOUCHER_KEY = "0x1";

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
  // Devnet first: the provider needs the STRK address it will advertise, and
  // that only exists once the devnet has deployed it.
  const devnetEarly = new Devnet();
  const testEnv = await createDevnetTestEnv(devnetEarly);
  const strkAddress = testEnv.env.strk;

  console.log("spawning provider as its own process...");
  // The provider is started before the devnet exists, so its STRK address is
  // injected once known — see below. A devnet deploys its own STRK, so the
  // default (the canonical mainnet/Sepolia address) would be wrong here, and
  // the consumer's asset check would correctly reject it.
  const provider: ChildProcess = spawn("npx", ["tsx", "src/server.ts"], {
    cwd: providerDir,
    env: { ...process.env, PORT: String(PROVIDER_PORT), TOKEN_ADDRESS: strkAddress },
    stdio: ["ignore", "pipe", "pipe"],
  });
  provider.stdout?.on("data", (d) => process.stdout.write(`[provider] ${d}`));
  provider.stderr?.on("data", (d) => process.stderr.write(`[provider] ${d}`));

  const devnet = devnetEarly;
  try {
    await waitUntilUp(PROVIDER_URL);
    console.log(`provider process up at ${PROVIDER_URL} (pid ${provider.pid})`);

    const consumerClient = wrapPrivacyClient(testEnv.env.alice, testEnv.env.node, testEnv.transfers.alice);
    const providerClient = wrapPrivacyClient(testEnv.env.bob, testEnv.env.node, testEnv.transfers.bob);

    // Consumer opens a channel by provoking the provider's 402 and reading
    // the terms out of it — it never sees or trusts anything about pricing
    // except that response.
    // The third argument is the check: the consumer refuses to open a channel
    // whose advertised settlement asset is not the token it actually pays in.
    const service = await RemoteEchoService.open(PROVIDER_URL, CONSUMER_VOUCHER_KEY, strkAddress);
    console.log(
      `consumer opened channel ${service.terms.channelId} via 402: base rate ${service.terms.rate}` +
        `${service.terms.pricing ? ` (${service.terms.pricing.unitsPerBlock}/${service.terms.pricing.charsPerBlock} chars)` : ""}, ` +
        `minSettlementUnits=${service.minSettlementUnits}`,
    );

    // Real questions, so a run against a live model shows actual answers
    // rather than three words being reversed.
    const requests: EchoRequest[] = [
      { prompt: "In one sentence, what is a nullifier in a shielded pool?" },
      { prompt: "Name one reason flat per-transaction fees break micropayments." },
      { prompt: "What does a payment channel let two parties avoid?" },
    ];

    const result = await runSession(consumerClient, providerClient, service, requests, {
      tokenAddress: testEnv.env.strk,
      poolAddress: testEnv.env.privacy.address,
      depositAmount: 1_000n,
      maturityPollMs: 500,
      // 3 calls x rate 10 = 30 owed, so this settles once mid-session and
      // once at close — enough to show batching actually branching.
      settlementThreshold: 20n,
      onWaitTick: async () => {
        await fetch(devnet.url, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "devnet_createBlock", params: [] }),
        });
      },
    });

    console.log(
      `\nnetworked devnet run OK — ${result.calls} calls served over real HTTP, ` +
        `${result.owed} settled across ${result.settlements} settlement(s), ` +
        `final signed claim ${service.authorizedUnits} units. tx hashes:`,
    );
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
