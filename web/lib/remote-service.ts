"use client";

/**
 * Browser copy of `agents/consumer/src/remote-echo-service.ts`, retargeted
 * at this app's own `/api/call` instead of a standalone provider process.
 * The class is unchanged; see that file for the full rationale on the
 * resync-ceiling and voucher-behind recovery. Kept as its own copy rather
 * than imported because `@strkret/agent-consumer`'s package root pulls in
 * `env.ts`, which reads `process.env` at import time and is not
 * browser-safe.
 */
import { ec } from "starknet";
import { priceOf, signVoucher, voucherToWire, type PaymentRequired, type PaymentRequirements } from "@strkret/agent-core/voucher";

export interface CallRequest {
  prompt: string;
}
export interface CallResult {
  completion: string;
  cost: bigint;
}

class VoucherBehindError extends Error {
  constructor(readonly requiredUnits: bigint) {
    super(`voucher behind; provider requires ${requiredUnits} units`);
  }
}

export class RemoteService {
  readonly name: string;
  #authorizedUnits = 0n;
  #ceiling = 0n;

  private constructor(
    private readonly baseUrl: string,
    private readonly consumerPrivateKey: string,
    readonly terms: PaymentRequirements,
  ) {
    this.name = terms.description;
  }

  static async open(baseUrl: string, consumerPrivateKey: string, expectedAsset?: string): Promise<RemoteService> {
    const res = await fetch(`${baseUrl}/call`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ prompt: "" }),
    });
    if (res.status !== 402) {
      throw new Error(`expected 402 Payment Required to open a channel, got ${res.status}`);
    }
    const { accepts } = (await res.json()) as PaymentRequired;
    const terms = accepts?.[0];
    if (!terms) throw new Error("402 carried no payment requirements");
    if (terms.scheme !== "strk20-channel") {
      throw new Error(`unsupported payment scheme ${terms.scheme}`);
    }
    if (expectedAsset && BigInt(terms.asset) !== BigInt(expectedAsset)) {
      throw new Error(`provider settles in ${terms.asset}, but this consumer pays in ${expectedAsset}`);
    }
    return new RemoteService(baseUrl, consumerPrivateKey, terms);
  }

  price(req: CallRequest): bigint {
    return priceOf(this.terms, req.prompt);
  }

  get authorizedUnits(): bigint {
    return this.#authorizedUnits;
  }

  get minSettlementUnits(): bigint {
    return BigInt(this.terms.minSettlementUnits);
  }

  async handle(req: CallRequest): Promise<CallResult> {
    this.#ceiling += this.price(req);
    try {
      return await this.#attempt(req);
    } catch (err) {
      if (!(err instanceof VoucherBehindError)) throw err;
      if (err.requiredUnits > this.#ceiling) {
        throw new Error(
          `provider claims ${err.requiredUnits} units owed, above the ${this.#ceiling} ` +
            `this consumer's own requests could account for — refusing to authorize the difference`,
        );
      }
      this.#authorizedUnits = err.requiredUnits - this.price(req);
      return await this.#attempt(req);
    }
  }

  async #attempt(req: CallRequest): Promise<CallResult> {
    const next = this.#authorizedUnits + this.price(req);
    const voucher = signVoucher(BigInt(this.terms.channelId), next, this.terms.rateCommitment, this.consumerPrivateKey);

    const res = await fetch(`${this.baseUrl}/call`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ ...req, voucher: voucherToWire(voucher) }),
    });
    if (res.status === 402) {
      const detail = (await res.json()) as { error?: string; requiredUnits?: string };
      if (detail.requiredUnits) throw new VoucherBehindError(BigInt(detail.requiredUnits));
      throw new Error(`provider refused the voucher: ${detail.error ?? "payment required"}`);
    }
    if (!res.ok) {
      const detail = await res.text().catch(() => "");
      throw new Error(`POST /call failed: ${res.status}${detail ? ` — ${detail}` : ""}`);
    }
    this.#authorizedUnits = next;
    const { completion, cost } = (await res.json()) as { completion: string; cost: string };
    return { completion, cost: BigInt(cost) };
  }

  get pubkey(): string {
    return ec.starkCurve.getStarkKey(this.consumerPrivateKey);
  }
}
