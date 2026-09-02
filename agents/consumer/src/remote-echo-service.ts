import type { Service } from "@strkret/agent-core";
import type { EchoRequest, EchoResult } from "@strkret/agent-provider";

/**
 * The consumer's view of a provider running as its own process
 * (`@strkret/agent-provider`'s `serve` script), reached over HTTP instead
 * of an in-process call. The rate is fetched once from GET /terms at
 * construction — matching the "provider advertises terms once, consumer
 * accepts them" pattern — so `price()` can stay synchronous per the
 * `Service` interface without a network round-trip on every call.
 */
export class RemoteEchoService implements Service<EchoRequest, EchoResult> {
  readonly name = "echo";

  private constructor(
    private readonly baseUrl: string,
    private readonly rate: bigint,
  ) {}

  static async connect(baseUrl: string): Promise<RemoteEchoService> {
    const res = await fetch(`${baseUrl}/terms`);
    if (!res.ok) throw new Error(`GET /terms failed: ${res.status}`);
    const { rate } = (await res.json()) as { rate: string };
    return new RemoteEchoService(baseUrl, BigInt(rate));
  }

  price(): bigint {
    return this.rate;
  }

  async handle(req: EchoRequest): Promise<EchoResult> {
    const res = await fetch(`${this.baseUrl}/call`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(req),
    });
    if (!res.ok) throw new Error(`POST /call failed: ${res.status}`);
    const { completion, cost } = (await res.json()) as { completion: string; cost: string };
    return { completion, cost: BigInt(cost) };
  }
}
