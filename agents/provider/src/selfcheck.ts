/**
 * Self-check for the payment gate in server.ts. Not a test framework —
 * spawns the real server and asserts the cases that decide whether work
 * gets served for free.
 *
 * Run: pnpm --filter @strkret/agent-provider run selfcheck
 */
import { spawn } from "node:child_process";
import assert from "node:assert/strict";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { hash } from "starknet";
import { priceOf, signVoucher, starkKeyOf, voucherToWire, type Voucher } from "@strkret/agent-core";
import { LlmService } from "./llm-service.js";

const PORT = 4099;
const URL = `http://localhost:${PORT}`;
const CHANNEL = 7n;
const CONSUMER_KEY = "0x1";
// Must match what the server publishes, or every voucher is signed against a
// rate it does not settle at.
const RATE_BLIND = 42n;
const ATTACKER_KEY = "0x2";

const call = (voucher?: Voucher, url = URL): Promise<Response> =>
  fetch(`${url}/call`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...(voucher ? { "x-strk20-voucher": JSON.stringify(voucherToWire(voucher)) } : {}),
    },
    body: JSON.stringify({ prompt: "hello" }),
  });

let RC = "";

const dir = resolve(dirname(fileURLToPath(import.meta.url)), "..");

function start(port: number, extraEnv: Record<string, string> = {}) {
  return spawn("npx", ["tsx", "src/server.ts"], {
    cwd: dir,
    env: { ...process.env, PORT: String(port), ...extraEnv },
    stdio: ["ignore", "ignore", "inherit"],
  });
}

async function waitUp(url: string) {
  const deadline = Date.now() + 15_000;
  for (;;) {
    try {
      if ((await fetch(`${url}/terms`)).ok) return;
    } catch {
      /* not up yet */
    }
    if (Date.now() > deadline) throw new Error(`server did not start at ${url}`);
    await new Promise((r) => setTimeout(r, 200));
  }
}

async function main() {
  const server = start(PORT);
  // A second provider with the gate pinned to one consumer key.
  const PINNED_PORT = PORT + 1;
  const pinnedUrl = `http://localhost:${PINNED_PORT}`;
  const pinned = start(PINNED_PORT, {
    ALLOWED_CONSUMER_KEYS: starkKeyOf(signVoucher(CHANNEL, 1n, RC, CONSUMER_KEY).pubkey),
  });

  try {
    await waitUp(URL);
    // Take the commitment from the server's own terms rather than recomputing
    // it — that is exactly the pinning being tested.
    const published = (await (await fetch(`${URL}/terms`)).json()) as { rateCommitment: string };
    RC = published.rateCommitment;
    await waitUp(pinnedUrl);

    // No voucher at all -> 402 carrying terms, not a served call.
    const bare = await call();
    assert.equal(bare.status, 402, "unpaid call must be refused");
    const body = (await bare.json()) as { accepts?: { rate?: string }[] };
    assert.ok(body.accepts?.[0]?.rate, "402 must advertise payment requirements");

    // Tampered units: signature no longer covers the claim.
    const forged = { ...signVoucher(CHANNEL, 10n, RC, CONSUMER_KEY), totalUnits: 9999n };
    assert.equal((await call(forged)).status, 402, "tampered voucher must be refused");

    // Signature from one key presented under another key: must not verify.
    const swapped = { ...signVoucher(CHANNEL, 10n, RC, ATTACKER_KEY), pubkey: signVoucher(CHANNEL, 10n, RC, CONSUMER_KEY).pubkey };
    assert.equal((await call(swapped)).status, 402, "signature under a foreign pubkey must be refused");

    // Wrong channel.
    assert.equal((await call(signVoucher(999n, 10n, RC, CONSUMER_KEY))).status, 402, "unknown channel must be refused");

    // Honest first call: exactly one call's worth of units.
    assert.equal((await call(signVoucher(CHANNEL, 10n, RC, CONSUMER_KEY))).status, 200, "paid call must be served");

    // Replaying that same voucher buys nothing — the claim hasn't grown, and
    // the refusal has to say where to catch up to, or a consumer that lost a
    // response can never resync.
    const stale = await call(signVoucher(CHANNEL, 10n, RC, CONSUMER_KEY));
    assert.equal(stale.status, 402, "replayed voucher must be refused");
    const staleBody = (await stale.json()) as { requiredUnits?: string };
    assert.equal(staleBody.requiredUnits, "20", "402 must name the units required to recover");

    // Growing the claim buys the next call.
    assert.equal((await call(signVoucher(CHANNEL, 20n, RC, CONSUMER_KEY))).status, 200, "grown claim must be served");

    // A different consumer starts from their own zero, unaffected by the above.
    assert.equal((await call(signVoucher(CHANNEL, 10n, RC, ATTACKER_KEY))).status, 200, "channels must be per-consumer");

    // With the gate pinned, a valid signature from a key that is not a party
    // to the channel buys nothing — otherwise anyone signs their own voucher
    // and is served for free.
    assert.equal(
      (await call(signVoucher(CHANNEL, 10n, RC, ATTACKER_KEY), pinnedUrl)).status,
      402,
      "pinned gate must refuse a non-party signer",
    );
    assert.equal(
      (await call(signVoucher(CHANNEL, 10n, RC, CONSUMER_KEY), pinnedUrl)).status,
      200,
      "pinned gate must serve the pinned consumer",
    );

    // Variable pricing only works if both sides derive the same number from
    // the advertised terms. Checked directly, because a mismatch shows up as a
    // refused call rather than as anything obviously price-related.
    const terms = (await (await fetch(`${URL}/terms`)).json()) as {
      rate: string;
      pricing?: { unitsPerBlock: string; charsPerBlock: number };
    };
    const svc = new LlmService(10n, 100);
    for (const prompt of ["", "x", "y".repeat(100), "z".repeat(101), "w".repeat(999)]) {
      assert.equal(
        svc.price({ prompt }),
        priceOf({ rate: svc.pricing.unitsPerBlock, pricing: svc.pricing }, prompt),
        `provider and consumer must price a ${prompt.length}-char prompt identically`,
      );
    }
    assert.ok(BigInt(terms.rate) > 0n, "402 must advertise a base rate");

    // A voucher signed over a different commitment is genuinely signed — just
    // for a rate this provider never agreed to be paid at. It must be refused
    // here, not discovered at settlement.
    const otherRate = hash.computePoseidonHashOnElements([1n, RATE_BLIND]);
    assert.equal(
      (await call(signVoucher(CHANNEL, 10n, otherRate, CONSUMER_KEY))).status,
      402,
      "voucher signed against another rate must be refused",
    );

    console.log("selfcheck OK — gate refuses unpaid, forged, stale, wrong-channel and non-party vouchers, and names the recovery point, and prices agree across both sides");
  } finally {
    server.kill();
    pinned.kill();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
