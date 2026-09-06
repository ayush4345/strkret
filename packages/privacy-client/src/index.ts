import { Account, RpcProvider, constants } from "starknet";
import { createPrivateTransfers } from "@starkware-libs/starknet-privacy-sdk";
// ContractDiscoveryProvider is packaged under /testing, but it is a real
// implementation of DiscoveryProviderInterface, not a mock — it is what the
// SDK's own devnet environment runs. The /testing subpath is public in the
// package's exports map; internal/ is not, which is why it comes from here.
import { ContractDiscoveryProvider } from "@starkware-libs/starknet-privacy-sdk/testing";
import { createPoolContract } from "./pool-contract.js";
import type { CallAndProof, PrivateTransfersInterface } from "@starkware-libs/starknet-privacy-sdk";
import { StarkscanProverProvider } from "./starkscan-prover.js";

export { StarkscanProverProvider } from "./starkscan-prover.js";
export { createPoolContract } from "./pool-contract.js";

export interface PrivacyClientConfig {
  rpcUrl: string;
  accountAddress: string;
  accountPrivateKey: string;
  viewingKey: bigint;
  poolAddress: string;
  provingServiceUrl: string;
  /**
   * Hosted discovery service. Optional: when omitted, discovery runs off
   * plain `starknet_call`s to the pool via {@link createPoolContract},
   * decrypting locally against the viewing key. That is what makes mainnet
   * possible at all — no hosted indexer exists for it — and it keeps the
   * viewing key on this machine rather than handing it to a service.
   *
   * Verified equivalent on Sepolia, where both exist: the two paths return
   * identical note balances for the same account
   * (`agents/consumer/src/check-contract-discovery.ts`).
   *
   * The tradeoff is RPC volume — discovery bisects and scans rather than
   * issuing one indexed query — so prefer a hosted indexer where one exists
   * and the endpoint is metered.
   */
  indexerUrl?: string;
  /**
   * When set, uses Starkscan's STRK20 prover relay
   * (https://starkscan.co/docs/api/strk20-prover) instead of the SDK's
   * default JSON-RPC proving client. `provingServiceUrl` is then read as
   * the relay's base URL (e.g. https://api.starkscan.co/v1/SN_MAIN),
   * not a JSON-RPC prover URL. Mainnet only — there is no Sepolia relay.
   */
  starkscanProverApiKey?: string;
}

export interface PrivacyClient {
  provider: RpcProvider;
  account: Account;
  transfers: PrivateTransfersInterface;
  /** Current block minus the maturity window every operation must prove against. */
  provingBlockId(): Promise<number>;
  /**
   * Shared submission tail for every builder above: back off provingBlockId,
   * conditionally spread proof details, tip 0, wait for inclusion.
   * See .claude/skills/strk20-privacy-sdk/references/sdk__getting-started.md
   */
  submit(callAndProof: CallAndProof): Promise<string>;
}

/**
 * Wrap an already-constructed `Account` + `RpcProvider` + `PrivateTransfersInterface`
 * into the common {@link PrivacyClient} surface — shared by the production
 * client below and the local-devnet adapter in `@strkret/agent-consumer`, so
 * the rest of the app (`@strkret/agent-core`'s `runSession`) doesn't care which
 * environment it's talking to.
 */
export function wrapPrivacyClient(
  account: Account,
  provider: RpcProvider,
  transfers: PrivateTransfersInterface,
): PrivacyClient {
  return {
    provider,
    account,
    transfers,
    async provingBlockId() {
      // Notes mature 10 blocks after creation; proving against a slightly
      // older block avoids both immaturity and reorg invalidation.
      return (await provider.getBlockNumber()) - 10;
    },
    async submit(callAndProof) {
      const proofDetails = callAndProof.proof.proofFacts?.length
        ? { proofFacts: callAndProof.proof.proofFacts, proof: callAndProof.proof.data }
        : {};
      const tx = await account.execute(callAndProof.call, { tip: 0n, ...proofDetails });
      await provider.waitForTransaction(tx.transaction_hash);
      return tx.transaction_hash;
    },
  };
}

export async function createPrivacyClient(config: PrivacyClientConfig): Promise<PrivacyClient> {
  const provider = new RpcProvider({ nodeUrl: config.rpcUrl });

  // Ask the RPC which network it's actually on rather than trust a
  // configured/default chainId — a mismatch here signs proofs for the wrong
  // network and every pool call reverts with INVALID_SIGNATURE.
  const chainId = (await provider.getChainId()) as constants.StarknetChainId;

  // cairoVersion "1" is required for accounts sending v3 transactions.
  const account = new Account({
    provider,
    address: config.accountAddress,
    signer: config.accountPrivateKey,
    cairoVersion: "1",
  });

  const provingProvider = config.starkscanProverApiKey
    ? new StarkscanProverProvider(config.provingServiceUrl, config.starkscanProverApiKey, chainId, provider, config.poolAddress)
    : { url: config.provingServiceUrl, chainId };

  const discoveryProvider = config.indexerUrl
    ? { url: config.indexerUrl }
    : new ContractDiscoveryProvider(createPoolContract(config.poolAddress, provider));

  const transfers = createPrivateTransfers({
    account,
    viewingKeyProvider: { getViewingKey: async () => config.viewingKey },
    provingProvider,
    discoveryProvider,
    poolContractAddress: config.poolAddress,
  });

  return wrapPrivacyClient(account, provider, transfers);
}
