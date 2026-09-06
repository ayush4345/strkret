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
import { signVoucher, voucherToWire, type Voucher } from "@strkret/agent-core";

const PORT = 4099;
const URL = `http://localhost:${PORT}`;
const CHANNEL = 7n;
const CONSUMER_KEY = "0x1";
const ATTACKER_KEY = "0x2";

const call = (voucher?: Voucher): Promise<Response> =>
  fetch(`${URL}/call`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...(voucher ? { "x-strk20-voucher": JSON.stringify(voucherToWire(voucher)) } : {}),
    },
    body: JSON.stringify({ prompt: "hello" }),
  });

async function main() {
  const server = spawn("npx", ["tsx", "src/server.ts"], {
    cwd: resolve(dirname(fileURLToPath(import.meta.url)), ".."),
    env: { ...process.env, PORT: String(PORT) },
    stdio: ["ignore", "ignore", "inherit"],
  });

  try {
    const deadline = Date.now() + 15_000;
    for (;;) {
      try {
        if ((await fetch(`${URL}/terms`)).ok) break;
      } catch {
        /* not up yet */
      }
      if (Date.now() > deadline) throw new Error("server did not start");
      await new Promise((r) => setTimeout(r, 200));
    }

    // No voucher at all -> 402 carrying terms, not a served call.
    const bare = await call();
    assert.equal(bare.status, 402, "unpaid call must be refused");
    const body = (await bare.json()) as { accepts?: { rate?: string }[] };
    assert.ok(body.accepts?.[0]?.rate, "402 must advertise payment requirements");

    // Tampered units: signature no longer covers the claim.
    const forged = { ...signVoucher(CHANNEL, 10n, CONSUMER_KEY), totalUnits: 9999n };
    assert.equal((await call(forged)).status, 402, "tampered voucher must be refused");

    // Signature from one key presented under another key: must not verify.
    const swapped = { ...signVoucher(CHANNEL, 10n, ATTACKER_KEY), pubkey: signVoucher(CHANNEL, 10n, CONSUMER_KEY).pubkey };
    assert.equal((await call(swapped)).status, 402, "signature under a foreign pubkey must be refused");

    // Wrong channel.
    assert.equal((await call(signVoucher(999n, 10n, CONSUMER_KEY))).status, 402, "unknown channel must be refused");

    // Honest first call: exactly one call's worth of units.
    assert.equal((await call(signVoucher(CHANNEL, 10n, CONSUMER_KEY))).status, 200, "paid call must be served");

    // Replaying that same voucher buys nothing — the claim hasn't grown.
    assert.equal((await call(signVoucher(CHANNEL, 10n, CONSUMER_KEY))).status, 402, "replayed voucher must be refused");

    // Growing the claim buys the next call.
    assert.equal((await call(signVoucher(CHANNEL, 20n, CONSUMER_KEY))).status, 200, "grown claim must be served");

    // A different consumer starts from their own zero, unaffected by the above.
    assert.equal((await call(signVoucher(CHANNEL, 10n, ATTACKER_KEY))).status, 200, "channels must be per-consumer");

    console.log("selfcheck OK — payment gate refuses unpaid, forged, stale and cross-key vouchers");
  } finally {
    server.kill();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
