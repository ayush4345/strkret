/**
 * Runs the provider as its own HTTP process, with an x402-shaped payment
 * handshake in front of the metered service.
 *
 * `POST /call` with no usable voucher answers `402` and a set of payment
 * requirements; with one, it verifies the signature, checks the claim has
 * grown by at least this call's price, serves, and reports the running total
 * back. That 402 means "you have no funded channel with me", not "pay for
 * this request" — per-request on-chain payment is precisely what the pool's
 * flat ~6 STRK protocol fee per settlement rules out. Vouchers are free to
 * issue and verify; only settlement touches the chain.
 *
 * The provider still prices independently and never trusts a
 * consumer-claimed cost. What the voucher adds is the other direction: the
 * provider holds an enforceable claim for everything it has served, instead
 * of serving on trust and hoping for a voucher at the end.
 */
import { createServer, type ServerResponse } from "node:http";
import { hash } from "starknet";
import {
  starkKeyOf,
  verifyVoucher,
  voucherFromWire,
  type PaymentRequired,
  type Voucher,
  type VoucherWire,
} from "@strkret/agent-core";
import type { PaymentRequirements, Service } from "@strkret/agent-core";
import { EchoService, type EchoRequest } from "./echo-service.js";
import { LlmService } from "./llm-service.js";

const PORT = Number(process.env.PORT ?? 4021);

/**
 * Sell real inference when a key is configured, and fall back to the
 * deterministic echo service when one isn't.
 *
 * The fallback is not a courtesy — the devnet demos and both selfchecks have
 * to run offline and reproducibly, and a provider that needs a paid API key to
 * start would make `demo:networked-devnet` unrunnable for anyone cloning this.
 * The metering, voucher and settlement paths are identical either way; only
 * what is being sold changes.
 */
const service: Service<{ prompt: string }, { completion: string; cost: bigint }> =
  process.env.OPENAI_API_KEY ? new LlmService(10n) : new EchoService(10n);

/**
 * The minimum a request can cost. Advertised as `rate` because a per-request
 * price is not a single number once pricing depends on the request — the
 * formula goes in `pricing`, and the consumer computes its own price from it.
 */
const BASE_RATE = service.price({ prompt: "" });


/** Header the consumer carries its running signed claim in. */
export const VOUCHER_HEADER = "x-strk20-voucher";

// Channel-open parameters. The rate commitment is what the anonymizer checks
// on-chain at settlement, so it is published here, at channel open, exactly
// as that contract's docs describe. The blind keeps the rate itself out of
// the commitment's preimage for anyone who only sees the commitment.
const RATE_BLIND = BigInt(process.env.RATE_BLIND ?? 42);
const CHANNEL_ID = BigInt(process.env.CHANNEL_ID ?? 7);
const PAY_TO = process.env.PROVIDER_ADDRESS ?? "0x0";
/**
 * The token settlement happens in. STRK's address is the same on mainnet and
 * Sepolia, so that is the default; a devnet deploys its own and overrides it.
 * Advertised in the terms so the consumer can check it is the token it is
 * actually about to pay in — a channel opened against one asset and settled
 * in another pays the provider in something it never agreed to accept.
 */
const ASSET = process.env.TOKEN_ADDRESS ?? "0x04718f5a0fc34cc1af16a1cdee98ffb20c31f5cd61d6ab07201858f4287c938d";
const SETTLEMENT_CONTRACT = process.env.ANONYMIZER_ADDRESS ?? "0x0";
const NETWORK = process.env.STARKNET_NETWORK ?? "starknet-sepolia";

// A session that settles less value than the protocol fee costs more to
// settle than it is worth. Advertised so the consumer can decide before it
// starts spending rather than discover it when settlement turns out
// uneconomic.
const MIN_SETTLEMENT_UNITS = BigInt(process.env.MIN_SETTLEMENT_UNITS ?? 600);

/**
 * The rate commitment this provider settles against, published in its terms.
 * Vouchers must be signed over exactly this: a voucher signed over some other
 * commitment verifies perfectly well and then settles at whatever rate that
 * commitment opens to, which is how a consumer would underpay.
 */
const RATE_COMMITMENT = hash.computePoseidonHashOnElements([BASE_RATE, RATE_BLIND]);



/**
 * Stark keys allowed to spend on this channel, comma-separated.
 *
 * Verifying a signature only proves whoever holds *some* key authorized the
 * claim — it says nothing about that key being the consumer this channel was
 * opened with. Without pinning, anyone signs with their own key, gets their
 * own high-water mark, and is served indefinitely for free.
 *
 * Left unset the gate stays open, which is fine for a local demo and not
 * fine anywhere else, so it says so loudly at startup.
 */
const ALLOWED = new Set(
  (process.env.ALLOWED_CONSUMER_KEYS ?? "")
    .split(",")
    .map((k) => k.trim())
    .filter(Boolean)
    .map((k) => BigInt(k).toString()),
);

/**
 * Highest cumulative units seen per (pubkey, channel), mirroring the
 * contract's own high-water mark. In-memory on purpose: this is a claim
 * cache, and the authoritative mark lives on-chain in `settled_units`. A
 * restart loses the cache, not the money — the consumer's highest voucher is
 * still valid and still settles for the full delta.
 */
const claims = new Map<string, bigint>();
const claimKey = (v: Voucher): string => `${starkKeyOf(v.pubkey)}:${v.channelId}`;

function paymentRequired(): PaymentRequired {
  return {
    x402Version: 1,
    accepts: [
      {
        scheme: "strk20-channel",
        network: NETWORK,
        asset: ASSET,
        payTo: PAY_TO,
        resource: "/call",
        description: `${service.name} service, metered per call`,
        rate: BASE_RATE.toString(),
        pricing: (service as { pricing?: PaymentRequirements["pricing"] }).pricing,
        rateCommitment: RATE_COMMITMENT,
        channelId: CHANNEL_ID.toString(),
        settlementContract: SETTLEMENT_CONTRACT,
        minSettlementUnits: MIN_SETTLEMENT_UNITS.toString(),
        maxTimeoutSeconds: 3600,
      },
    ],
  };
}

function readVoucher(raw: string | string[] | undefined): Voucher | undefined {
  if (typeof raw !== "string") return undefined;
  try {
    return voucherFromWire(JSON.parse(raw) as VoucherWire);
  } catch {
    return undefined;
  }
}

function json(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify(body));
}

const server = createServer((req, res) => {
  if (req.method === "GET" && req.url === "/terms") {
    // The same terms the 402 carries, readable without provoking a
    // payment-required response.
    json(res, 200, paymentRequired().accepts[0]);
    return;
  }

  if (req.method === "POST" && req.url === "/call") {
    let body = "";
    req.on("data", (chunk) => (body += chunk));
    req.on("end", async () => {
      try {
        // Parse before pricing: what a request costs depends on what it asks
        // for, so the claim can't be checked until the body is known.
        const request = JSON.parse(body) as EchoRequest;
        const price = service.price(request);

        const voucher = readVoucher(req.headers[VOUCHER_HEADER]);
        if (!voucher) {
          json(res, 402, paymentRequired());
          return;
        }
        if (!verifyVoucher(voucher)) {
          json(res, 402, { error: "voucher signature did not verify", ...paymentRequired() });
          return;
        }
        if (voucher.channelId !== CHANNEL_ID) {
          json(res, 402, { error: `unknown channel ${voucher.channelId}`, ...paymentRequired() });
          return;
        }
        // Pin the commitment. The signature covers it, so a voucher naming a
        // different one is genuinely signed — just for a different rate than
        // this provider agreed to be paid at.
        if (BigInt(voucher.rateCommitment) !== BigInt(RATE_COMMITMENT)) {
          json(res, 402, { error: "voucher is signed against a different rate", ...paymentRequired() });
          return;
        }
        const signer = BigInt(starkKeyOf(voucher.pubkey)).toString();
        if (ALLOWED.size > 0 && !ALLOWED.has(signer)) {
          json(res, 402, { error: "signer is not a party to this channel", ...paymentRequired() });
          return;
        }

        // The claim has to have grown by at least what this call costs,
        // otherwise the consumer is asking to be served for units it has not
        // authorized. Comparing against the stored high-water mark rather
        // than the voucher alone is what stops a replayed older voucher
        // buying another call.
        const previous = claims.get(claimKey(voucher)) ?? 0n;
        if (voucher.totalUnits < previous + price) {
          // `requiredUnits` is the recovery path, not decoration: if a served
          // response is lost in flight the provider's mark has advanced and
          // the consumer's has not, and without being told the number it
          // would re-send the same too-low claim forever.
          json(res, 402, {
            error: `voucher must cover at least ${previous + price} units, got ${voucher.totalUnits}`,
            requiredUnits: (previous + price).toString(),
            ...paymentRequired(),
          });
          return;
        }

        // price() is what the voucher was signed against, so the gate above
        // has already accepted this request's cost.
        const result = await service.handle(request);
        claims.set(claimKey(voucher), voucher.totalUnits);

        // JSON.stringify throws on bigint, and cost is one — it travels as a
        // string. This threw after writeHead(200) once, which surfaced as
        // ERR_HTTP_HEADERS_SENT from the catch block rather than as itself.
        json(res, 200, {
          completion: result.completion,
          cost: result.cost.toString(),
          claimedUnits: voucher.totalUnits.toString(),
        });
      } catch (err) {
        if (res.headersSent) {
          console.error("error after response started:", err);
          return;
        }
        json(res, 400, { error: err instanceof Error ? err.message : String(err) });
      }
    });
    return;
  }

  res.writeHead(404);
  res.end();
});

server.listen(PORT, () => {
  console.log(`provider serving on :${PORT} — ${service.name}, ${BASE_RATE}+ units/call, channel=${CHANNEL_ID}`);
  console.log(
    ALLOWED.size > 0
      ? `payment gate pinned to ${ALLOWED.size} consumer key(s)`
      : "WARNING: ALLOWED_CONSUMER_KEYS unset — any valid signature is served. Demo only.",
  );
});
