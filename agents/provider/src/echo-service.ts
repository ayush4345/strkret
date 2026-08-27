import type { Service } from "@strkret/agent-core";

export interface EchoRequest {
  prompt: string;
}

export interface EchoResult {
  completion: string;
  cost: bigint;
}

/** Deterministic demo service so the metering flow is reproducible offline. */
export class EchoService implements Service<EchoRequest, EchoResult> {
  readonly name = "echo";

  constructor(private readonly costPerCall: bigint) {
    if (costPerCall <= 0n) throw new Error("costPerCall must be positive");
  }

  price(): bigint {
    return this.costPerCall;
  }

  async handle(req: EchoRequest): Promise<EchoResult> {
    return { completion: req.prompt.split("").reverse().join(""), cost: this.costPerCall };
  }
}
