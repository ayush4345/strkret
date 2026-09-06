/**
 * The consumer as a long-lived HTTP service, so a browser can drive a real
 * metered session instead of reading a script's output.
 *
 * Runs against a local devnet on purpose. Devnet is the real privacy-pool
 * contract with real proofs, but mines instantly — on Sepolia every
 * settlement waits ~10 blocks for note maturity, which would stall a live
 * demo for twenty minutes in the middle of a sentence. Nothing here is
 * simulated; only the chain is local.
 *
 * Boot takes ~30s (devnet, contracts, register, deposit), so it happens once
 * at startup and `GET /state` reports progress rather than blocking.
 *
 * Run: pnpm --filter @strkret/agent-consumer run serve
 */
import { createServer, type ServerResponse } from "node:http";
import { spawn, type ChildProcess } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { Devnet, createDevnetTestEnv } from "@starkware-libs/starknet-privacy-sdk/testing";
import { wrapPrivacyClient, type PrivacyClient } from "@strkret/privacy-client";
import { MeteredSession, settleOnce } from "@strkret/agent-core";
import { RemoteEchoService } from "./remote-echo-service.js";

const PORT = Number(process.env.SESSION_PORT ?? 4022);
const PROVIDER_PORT = Number(process.env.PROVIDER_PORT ?? 4021);
const PROVIDER_URL = `http://localhost:${PROVIDER_PORT}`;
const providerDir = resolve(dirname(fileURLToPath(import.meta.url)), "../../provider");

/** Same test vector the Cairo suite uses, so signatures are comparable. */
const CONSUMER_VOUCHER_KEY = "0x1";
const DEPOSIT = 100_000n;
/**
 * Settle once this much is owed. Deliberately small — at 10 units a call, a
 * larger threshold means a presenter has to ask thirty questions before
 * anything settles, and the batching is the thing worth showing.
 *
 * The provider is started with a matching `MIN_SETTLEMENT_UNITS` below, so
 * the terms it advertises and the point we actually settle at agree. On
 * mainnet that number comes from the 6 STRK fee; here it is scaled to a
 * demo.
 */
const THRESHOLD = 30n;

type Phase = "booting" | "ready" | "settling" | "failed";

interface CallRecord {
  prompt: string;
  completion: string;
  cost: string;
  claimAfter: string;
  at: number;
}
interface SettlementRecord {
  amount: string;
  txHash: string;
  at: number;
}

const state = {
  phase: "booting" as Phase,
  detail: "starting devnet",
  error: "",
  terms: null as Record<string, unknown> | null,
  serviceName: "",
  deposit: DEPOSIT.toString(),
  threshold: THRESHOLD.toString(),
  owed: "0",
  settled: "0",
  calls: [] as CallRecord[],
  settlements: [] as SettlementRecord[],
  txHashes: [] as string[],
};

let devnet: Devnet | undefined;
let providerProc: ChildProcess | undefined;
let consumer: PrivacyClient | undefined;
let provider: PrivacyClient | undefined;
let service: RemoteEchoService | undefined;
let session: MeteredSession<{ prompt: string }, { completion: string; cost: bigint }> | undefined;
let strk = "";
/** Serialises calls: two settlements at once would spend the same note twice. */
let busy: Promise<unknown> = Promise.resolve();

const json = (res: ServerResponse, status: number, body: unknown): void => {
  res.writeHead(status, { "content-type": "application/json", "access-control-allow-origin": "*" });
  res.end(JSON.stringify(body));
};

async function forceBlock(url: string): Promise<void> {
  // Bounded: an unresponsive devnet must not hang the settlement forever,
  // which is exactly what an un-timed fetch inside a poll loop does.
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), 5_000);
  try {
    await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "devnet_createBlock", params: [] }),
      signal: ctl.signal,
    });
  } catch (err) {
    console.error("forceBlock failed:", (err as Error).message);
  } finally {
    clearTimeout(timer);
  }
}

async function waitForProvider(url: string, timeoutMs = 20_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    try {
      if ((await fetch(`${url}/terms`)).ok) return;
    } catch {
      /* not up yet */
    }
    if (Date.now() > deadline) throw new Error(`provider did not start at ${url}`);
    await new Promise((r) => setTimeout(r, 300));
  }
}

async function boot(): Promise<void> {
  state.detail = "starting devnet";
  devnet = new Devnet();
  const testEnv = await createDevnetTestEnv(devnet);
  strk = testEnv.env.strk;
  consumer = wrapPrivacyClient(testEnv.env.alice, testEnv.env.node, testEnv.transfers.alice);
  provider = wrapPrivacyClient(testEnv.env.bob, testEnv.env.node, testEnv.transfers.bob);

  state.detail = "starting provider process";
  providerProc = spawn("npx", ["tsx", "src/server.ts"], {
    cwd: providerDir,
    env: {
      ...process.env,
      PORT: String(PROVIDER_PORT),
      TOKEN_ADDRESS: strk,
      MIN_SETTLEMENT_UNITS: THRESHOLD.toString(),
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  providerProc.stdout?.on("data", (d) => process.stdout.write(`[provider] ${d}`));
  providerProc.stderr?.on("data", (d) => process.stderr.write(`[provider] ${d}`));
  await waitForProvider(PROVIDER_URL);

  state.detail = "opening channel (402 handshake)";
  service = await RemoteEchoService.open(PROVIDER_URL, CONSUMER_VOUCHER_KEY, strk);
  state.terms = service.terms as unknown as Record<string, unknown>;
  state.serviceName = service.name;
  session = new MeteredSession(service);

  // The provider must publish its own viewing key before anything can be
  // transferred to it — nobody can do this on its behalf. Skipping it does
  // not fail here; it fails much later, at the first settlement, as
  // "Missing channel context for recipient", which points at the consumer
  // rather than at the step that was actually missed.
  state.detail = "registering provider viewing key";
  const providerApprove = await provider.account.execute(
    {
      contractAddress: strk,
      entrypoint: "approve",
      calldata: [testEnv.env.privacy.address, (10n ** 19n).toString(), "0"],
    },
    { tip: 0n },
  );
  await provider.provider.waitForTransaction(providerApprove.transaction_hash);
  for (let i = 0; i < 10; i++) await forceBlock(devnet.url);

  const providerRegisterBlock = await provider.provingBlockId();
  const registerBuild = await provider.transfers
    .build()
    .register()
    .execute({ provingBlockId: providerRegisterBlock });
  const registerHash = await provider.submit(registerBuild.callAndProof);
  state.txHashes.push(registerHash);
  for (let i = 0; i < 10; i++) await forceBlock(devnet.url);

  state.detail = "approving and depositing escrow";
  const approveTx = await consumer.account.execute(
    {
      contractAddress: strk,
      entrypoint: "approve",
      calldata: [testEnv.env.privacy.address, (DEPOSIT + 10n ** 19n).toString(), "0"],
    },
    { tip: 0n },
  );
  await consumer.provider.waitForTransaction(approveTx.transaction_hash);
  for (let i = 0; i < 10; i++) await forceBlock(devnet.url);

  const depositBlockId = await consumer.provingBlockId();
  const depositBuild = await consumer.transfers
    .build({ autoRegister: true, autoSetup: true })
    .with(strk, (t) => t.deposit({ amount: DEPOSIT }))
    .surplusTo(consumer.account.address)
    .execute({ provingBlockId: depositBlockId });
  const depositHash = await consumer.submit(depositBuild.callAndProof);
  state.txHashes.push(depositHash);
  for (let i = 0; i < 10; i++) await forceBlock(devnet.url);

  state.phase = "ready";
  state.detail = "";
}

/** Settle everything outstanding. Serialised through `busy`. */
async function settle(): Promise<void> {
  if (!consumer || !provider || !session || !devnet) throw new Error("session not ready");
  const outstanding = session.owed - BigInt(state.settled);
  if (outstanding <= 0n) return;
  state.phase = "settling";
  console.log(`[settle] starting for ${outstanding} units, devnet at ${devnet.url}`);
  const hash = await settleOnce(consumer, provider, outstanding, {
    tokenAddress: strk,
    maturityPollMs: 300,
    onWaitTick: async () => forceBlock(devnet!.url),
    log: (m) => console.log(m),
  });
  console.log(`[settle] done: ${hash}`);
  state.settled = (BigInt(state.settled) + outstanding).toString();
  state.settlements.push({ amount: outstanding.toString(), txHash: hash, at: Date.now() });
  state.txHashes.push(hash);
  state.phase = "ready";
}

const server = createServer((req, res) => {
  if (req.method === "OPTIONS") {
    res.writeHead(204, {
      "access-control-allow-origin": "*",
      "access-control-allow-headers": "content-type",
      "access-control-allow-methods": "GET,POST,OPTIONS",
    });
    res.end();
    return;
  }

  if (req.method === "GET" && req.url === "/state") {
    json(res, 200, { ...state, owed: (session?.owed ?? 0n).toString() });
    return;
  }

  if (req.method === "POST" && (req.url === "/call" || req.url === "/settle")) {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      // Queue behind whatever is in flight. Two settlements racing would try
      // to spend the same note twice, and the second would fail confusingly.
      busy = busy
        .then(async () => {
          if (state.phase === "booting") throw new Error("still booting — check /state");
          if (state.phase === "failed") throw new Error(state.error || "session failed");

          if (req.url === "/settle") {
            await settle();
            json(res, 200, { ok: true, settlements: state.settlements });
            return;
          }

          const { prompt } = JSON.parse(body || "{}") as { prompt?: string };
          if (!prompt?.trim()) throw new Error("prompt is required");
          const { result, cost } = await session!.call({ prompt });
          state.calls.push({
            prompt,
            completion: (result as { completion: string }).completion,
            cost: cost.toString(),
            claimAfter: service!.authorizedUnits.toString(),
            at: Date.now(),
          });

          // Threshold settlement, same rule runSession applies: settle once
          // enough value has accrued that the protocol fee is worth paying.
          const unsettled = session!.owed - BigInt(state.settled);
          const crossed = unsettled >= THRESHOLD;
          if (crossed) await settle();

          json(res, 200, {
            ok: true,
            call: state.calls[state.calls.length - 1],
            settledNow: crossed,
            owed: session!.owed.toString(),
            settled: state.settled,
          });
        })
        .catch((err: Error) => {
          if (!res.headersSent) json(res, 400, { ok: false, error: err.message });
        });
    });
    return;
  }

  res.writeHead(404, { "access-control-allow-origin": "*" });
  res.end();
});

server.listen(PORT, () => {
  console.log(`session server on :${PORT} — booting devnet, watch GET /state`);
  boot().catch((err: Error) => {
    state.phase = "failed";
    state.error = err.message;
    console.error("boot failed:", err);
  });
});

for (const sig of ["SIGINT", "SIGTERM"] as const) {
  process.on(sig, () => {
    providerProc?.kill();
    void devnet?.cleanup().finally(() => process.exit(0));
  });
}
