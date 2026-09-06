import { ec } from "starknet";
import type { Service } from "@strkret/agent-core";
import { priceOf, signVoucher, voucherToWire, type PaymentRequired, type PaymentRequirements } from "@strkret/agent-core";
import type { EchoRequest, EchoResult } from "@strkret/agent-provider";

/**
 * The consumer's view of a provider running as its own process, reached over
 * HTTP instead of an in-process call.
 *
 * Terms come from the provider's 402: the first unpaid `POST /call` answers
 * `402 Payment Required` with an `accepts` block, and `open()` reads the
 * rate and channel out of it. That is an x402-shaped handshake, not x402
 * itself — there is no per-request `X-PAYMENT` payload, because settling per
 * request is exactly what a flat ~6 STRK protocol fee rules out. Here 402
 * means "you have no funded channel with me".
 *
 * After that, every call carries a fresh voucher for the CUMULATIVE units
 * authorized so far, each superseding the last. Signing is free and
 * off-chain, so the provider holds an enforceable claim for everything it
 * has served while the chain stays untouched until settlement.
 */
/** The provider's claim is ahead of ours — it tells us where to catch up to. */
class VoucherBehindError extends Error {
  constructor(readonly requiredUnits: bigint) {
    super(`voucher behind; provider requires ${requiredUnits} units`);
  }
}

export class RemoteEchoService implements Service<EchoRequest, EchoResult> {
  /**
   * What the provider actually sells, taken from its advertised description
   * rather than hardcoded — this class proxies whatever is on the other end,
   * and calling it "echo" when it is selling inference makes the session log
   * quietly wrong.
   */
  readonly name: string;

  /** Cumulative units authorized so far — what each new voucher signs over. */
  #authorizedUnits = 0n;

  /**
   * The most this consumer could legitimately owe: the sum of the prices of
   * the calls it actually asked for. Computed here rather than taken from the
   * provider — which is the whole point of it. A running sum rather than
   * calls × rate, because price depends on the request once the service
   * charges by size.
   */
  #ceiling = 0n;

  private constructor(
    private readonly baseUrl: string,
    private readonly consumerPrivateKey: string,
    readonly terms: PaymentRequirements,
  ) {
    this.name = terms.description;
  }

  /**
   * Open a channel by provoking the provider's 402 and reading its terms.
   * Deliberately does not send a voucher: the 402 is the discovery step.
   */
  static async open(
    baseUrl: string,
    consumerPrivateKey: string,
    /**
     * The token this consumer intends to settle in. Checked against the
     * provider's advertised asset: a channel opened against one asset and
     * settled in another pays the provider in something it never agreed to
     * accept, and nothing on-chain would catch it — the contract credits
     * whatever token the calldata names.
     */
    expectedAsset?: string,
  ): Promise<RemoteEchoService> {
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
      throw new Error(
        `provider settles in ${terms.asset}, but this consumer pays in ${expectedAsset}`,
      );
    }
    return new RemoteEchoService(baseUrl, consumerPrivateKey, terms);
  }

  /**
   * Priced through the shared rule, from the terms the provider advertised —
   * so the number signed here is the number the gate will check against.
   */
  price(req: EchoRequest): bigint {
    return priceOf(this.terms, req.prompt);
  }

  /** The running claim the provider currently holds against this consumer. */
  get authorizedUnits(): bigint {
    return this.#authorizedUnits;
  }

  /**
   * Below this, the protocol fee costs more than the session is worth — the
   * provider advertises it so the decision can be made up front.
   */
  get minSettlementUnits(): bigint {
    return BigInt(this.terms.minSettlementUnits);
  }

  async handle(req: EchoRequest): Promise<EchoResult> {
    this.#ceiling += this.price(req);
    try {
      return await this.#attempt(req);
    } catch (err) {
      // A served call whose response was lost leaves the provider's claim
      // ahead of ours, and every later voucher is then too low — the channel
      // wedges. The 402 says where to catch up to, so adopt that and try
      // once more. Once only: a second refusal is a real disagreement, not a
      // dropped reply.
      if (!(err instanceof VoucherBehindError)) throw err;

      // But never on the provider's word alone. `requiredUnits` arrives from
      // the counterparty that gets paid, and adopting it unchecked would let
      // a provider name any figure and have the consumer sign for work it
      // never received — the same usage inflation the on-chain settlement
      // check exists to stop. We know how many calls we asked for, so that
      // is the ceiling, and it is computed here rather than accepted from
      // over there.
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

  async #attempt(req: EchoRequest): Promise<EchoResult> {
    // Authorize this call before it is served, then sign the new cumulative
    // total. The provider rejects anything that has not grown by at least
    // its price, so the claim and the work stay in step.
    const next = this.#authorizedUnits + this.price(req);
    // Signed over the provider's published commitment, so the settlement is
    // pinned to the rate this channel was opened at.
    const voucher = signVoucher(
      BigInt(this.terms.channelId),
      next,
      this.terms.rateCommitment,
      this.consumerPrivateKey,
    );

    const res = await fetch(`${this.baseUrl}/call`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-strk20-voucher": JSON.stringify(voucherToWire(voucher)),
      },
      body: JSON.stringify(req),
    });
    if (res.status === 402) {
      const detail = (await res.json()) as { error?: string; requiredUnits?: string };
      if (detail.requiredUnits) throw new VoucherBehindError(BigInt(detail.requiredUnits));
      throw new Error(`provider refused the voucher: ${detail.error ?? "payment required"}`);
    }
    if (!res.ok) {
      // Surface what the provider said. A bare status tells you nothing about
      // whether the service failed, the request was malformed, or the model
      // refused — and the call may already have cost the consumer.
      const detail = await res.text().catch(() => "");
      throw new Error(`POST /call failed: ${res.status}${detail ? ` — ${detail}` : ""}`);
    }

    // Only bank the authorization once the call was actually served, so a
    // failed call does not silently inflate what the consumer owes.
    this.#authorizedUnits = next;
    const { completion, cost } = (await res.json()) as { completion: string; cost: string };
    return { completion, cost: BigInt(cost) };
  }

  /** The consumer's public key, as the settlement contract will see it. */
  get pubkey(): string {
    return ec.starkCurve.getStarkKey(this.consumerPrivateKey);
  }
}
