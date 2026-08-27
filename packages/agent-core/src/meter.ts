import type { Service } from "./service.js";

/**
 * Runs a metered session against one {@link Service}: serves each call,
 * accumulates what's owed, and hands back the final total for the consumer
 * to settle in a single private transfer.
 *
 * There's no per-call cryptographic voucher here — STRK20's private transfer
 * already hides the settlement amount and both parties on-chain, so plain
 * accounting is enough: the provider prices independently and never trusts
 * a consumer-claimed cost.
 */
export class MeteredSession<Req, Res> {
  #owed = 0n;
  #calls = 0;

  constructor(private readonly service: Service<Req, Res>) {}

  async call(req: Req): Promise<{ result: Res; cost: bigint }> {
    const cost = this.service.price(req);
    if (cost <= 0n) throw new Error("service price must be positive");
    const result = await this.service.handle(req);
    this.#owed += cost;
    this.#calls += 1;
    return { result, cost };
  }

  get owed(): bigint {
    return this.#owed;
  }

  get calls(): number {
    return this.#calls;
  }
}
