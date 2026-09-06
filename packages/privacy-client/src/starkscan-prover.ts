import { ETransactionVersion, RpcProvider, constants } from "starknet";
import type {
  AdditionalData,
  Proof,
  ProofInvocation,
  ProofInvocationFactoryDetails,
  ProofProviderInterface,
} from "@starkware-libs/starknet-privacy-sdk";

/**
 * Custom ProofProviderInterface implementation for Starkscan's STRK20 prover
 * relay (https://starkscan.co/docs/api/strk20-prover) — mainnet only, no
 * Sepolia equivalent exists. The SDK's built-in ProvingServiceProofProvider
 * speaks JSON-RPC (starknet_proveTransaction) directly to a prover; this
 * relay is a REST job queue (submit, then poll) in front of the same
 * underlying prover, so it needs its own thin adapter rather than a
 * PROVING_SERVICE_URL swap.
 *
 * getDefaultDetails()'s shape (transaction-version defaults + pool nonce
 * fetched from an RPC) and prove()'s response field mapping
 * (proof/proof_facts/l2_to_l1_messages/additional_data -> data/proofFacts/
 * output/additionalData) are copied from the SDK's own
 * ProvingServiceProofProvider (dist/internal/proving-service-provider.js) —
 * that part of the contract is provider-agnostic, verified against the
 * SDK's actual shipped implementation, not guessed.
 *
 * UNTESTED against a live job — there is no Sepolia prover to rehearse
 * against, so the first real use of this is necessarily on mainnet. Verify
 * response shapes against a real submission before trusting settlement
 * amounts that matter.
 */
export class StarkscanProverProvider implements ProofProviderInterface {
  private cachedNonce: bigint | null = null;

  constructor(
    private readonly apiUrl: string, // e.g. https://api.starkscan.co/v1/SN_MAIN
    private readonly apiKey: string,
    private readonly chainId: constants.StarknetChainId,
    private readonly rpcProvider: RpcProvider,
    private readonly poolAddressHex: string,
    /** How often to re-poll if the relay doesn't say (defensive default). */
    private readonly fallbackPollMs = 5_000,
  ) {}

  invalidateNonceCache(): void {
    this.cachedNonce = null;
  }

  async getDefaultDetails(): Promise<ProofInvocationFactoryDetails> {
    // Matches getDefaultProofDetails() in the SDK's
    // internal/proof-invocation-factory.ts — that path isn't in the
    // package's exports map, so reproduced here rather than imported.
    // `version`/`versions` MUST be starknet.js's ETransactionVersion.V3
    // ("0x3"), not the plain number 3 — account.signer.signTransaction()
    // switches on this exact value and throws "unsupported signTransaction
    // version" otherwise (caught by the mainnet register() test run).
    const base = {
      versions: [ETransactionVersion.V3],
      nonce: 0n,
      skipValidate: true,
      resourceBounds: {
        l1_gas: { max_amount: 1n, max_price_per_unit: 0n },
        l2_gas: { max_amount: 100_000_000n, max_price_per_unit: 0n },
        l1_data_gas: { max_amount: 1n, max_price_per_unit: 0n },
      },
      tip: 0n,
      paymasterData: [],
      accountDeploymentData: [],
      nonceDataAvailabilityMode: "L1",
      feeDataAvailabilityMode: "L1",
      version: ETransactionVersion.V3,
      chainId: this.chainId,
    } as unknown as ProofInvocationFactoryDetails;

    if (this.cachedNonce == null) {
      this.cachedNonce = BigInt(await this.rpcProvider.getNonceForAddress(this.poolAddressHex, "latest"));
    }
    return { ...base, nonce: this.cachedNonce };
  }

  async prove(invocation: ProofInvocation, blockIdentifier?: number | "latest"): Promise<Proof> {
    const blockId = typeof blockIdentifier === "number" ? blockIdentifier : await this.rpcProvider.getBlockNumber();

    const idempotencyKey = crypto.randomUUID();
    const submitBody = JSON.stringify({ block_id: { block_number: blockId }, transaction: invocation });
    if (process.env.DEBUG_STARKSCAN_PROVER) {
      const fs = await import("node:fs/promises");
      await fs.writeFile(process.env.DEBUG_STARKSCAN_PROVER, submitBody);
      console.error(`[debug] wrote submit body (${submitBody.length} bytes) to ${process.env.DEBUG_STARKSCAN_PROVER}`);
      console.error(`[debug] idempotencyKey: ${idempotencyKey}`);
    }
    const submitRes = await fetch(`${this.apiUrl}/prove`, {
      method: "POST",
      headers: {
        "X-Starkscan-Api-Key": this.apiKey,
        "Idempotency-Key": idempotencyKey,
        "content-type": "application/json",
      },
      body: submitBody,
    });
    if (!submitRes.ok) {
      throw new Error(`Starkscan prover submit failed: ${submitRes.status} ${await submitRes.text()}`);
    }
    let job = (await submitRes.json()) as StarkscanProveJob;

    while (!job.terminal) {
      const waitMs = (job.pollAfterSeconds ?? this.fallbackPollMs / 1000) * 1000;
      await new Promise((r) => setTimeout(r, waitMs));
      const pollRes = await fetch(`${this.apiUrl}/prove/${job.jobId}`, {
        headers: { "X-Starkscan-Api-Key": this.apiKey },
      });
      if (!pollRes.ok) {
        throw new Error(`Starkscan prover poll failed: ${pollRes.status} ${await pollRes.text()}`);
      }
      job = (await pollRes.json()) as StarkscanProveJob;
    }

    if (job.status !== "succeeded" || !job.result) {
      throw new Error(`Starkscan prover job ${job.jobId} ended with status "${job.status}": ${JSON.stringify(job)}`);
    }

    // Same mapping as ProvingServiceProofProvider.prove() — filter
    // l2_to_l1_messages down to the pool's own message. Compare as BigInt,
    // not lowercased strings: Starkscan returns from_address unpadded
    // (0x40337b1a...) while poolAddressHex here may carry a leading zero
    // (0x040337b1a...) from config — string compare silently drops every
    // match and prove() falls back to `output: []`, which then produces
    // truncated apply_actions calldata ("Failed to deserialize param #1").
    const result = job.result;
    const poolAddressBig = BigInt(this.poolAddressHex);
    const poolMessage = result.l2_to_l1_messages?.find((m) => m.from_address != null && BigInt(m.from_address) === poolAddressBig);
    return {
      data: result.proof,
      output: poolMessage?.payload ?? [],
      proofFacts: result.proof_facts ?? [],
      additionalData: result.additional_data,
    };
  }
}

interface StarkscanProveJob {
  jobId: string;
  status: "queued" | "dispatched" | "succeeded" | "failed" | "unavailable" | "unknown_delivery";
  terminal: boolean;
  pollAfterSeconds?: number;
  result?: {
    proof: string;
    proof_facts: string[];
    l2_to_l1_messages: { from_address: string; to_address: string; payload: string[] }[];
    additional_data?: AdditionalData;
  };
}
