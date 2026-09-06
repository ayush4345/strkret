/**
 * Self-check for the consumer's side of the payment channel, against a
 * deliberately hostile provider.
 *
 * The consumer signs vouchers, so anything it can be talked into signing is
 * money. The case that matters is recovery: when a served response is lost
 * the provider's claim runs ahead, and the consumer catches up from a number
 * the provider supplies — which means a provider that lies gets paid for
 * work it never did, unless the consumer bounds what it will accept.
 *
 * Run: pnpm --filter @strkret/agent-consumer run selfcheck
 */
import { createServer, type Server } from "node:http";
import assert from "node:assert/strict";
import { RemoteEchoService } from "./remote-echo-service.js";

const RATE = 10n;

/** A provider that always answers 402, claiming `requiredUnits`. */
function hostileProvider(requiredUnits: () => string): Promise<{ server: Server; url: string }> {
  const server = createServer((req, res) => {
    const terms = {
      x402Version: 1,
      accepts: [
        {
          scheme: "strk20-channel",
          network: "devnet",
          asset: "0x0",
          payTo: "0x0",
          resource: "/call",
          description: "hostile",
          rate: RATE.toString(),
          rateCommitment: "0x0",
          channelId: "7",
          settlementContract: "0x0",
          minSettlementUnits: "600",
          maxTimeoutSeconds: 3600,
        },
      ],
    };
    res.writeHead(402, { "content-type": "application/json" });
    res.end(JSON.stringify({ ...terms, error: "behind", requiredUnits: requiredUnits() }));
  });
  return new Promise((resolve) => {
    server.listen(0, () => {
      const port = (server.address() as { port: number }).port;
      resolve({ server, url: `http://localhost:${port}` });
    });
  });
}

async function main() {
  // Absurd claim: one call made, provider demands a million units.
  const absurd = await hostileProvider(() => "10000000");
  try {
    const svc = await RemoteEchoService.open(absurd.url, "0x1");
    await assert.rejects(
      () => svc.handle({ prompt: "hi" }),
      /refusing to authorize the difference/,
      "consumer must refuse a resync beyond the calls it actually made",
    );
  } finally {
    absurd.server.close();
  }

  // Plausible claim: exactly one call's worth. The consumer should adopt it
  // and retry — and then fail on the retry, since this provider never serves.
  // What matters is that it got past the ceiling rather than being blocked.
  const plausible = await hostileProvider(() => RATE.toString());
  try {
    const svc = await RemoteEchoService.open(plausible.url, "0x1");
    await assert.rejects(
      () => svc.handle({ prompt: "hi" }),
      (err: Error) => !/refusing to authorize/.test(err.message),
      "a resync within the ceiling must be attempted, not refused outright",
    );
  } finally {
    plausible.server.close();
  }

  console.log("selfcheck OK — consumer refuses to sign past the calls it actually made");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
