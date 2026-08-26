import { Account, RpcProvider, constants } from "starknet";
import { createPrivateTransfers } from "@starkware-libs/starknet-privacy-sdk";
import type { CallAndProof, PrivateTransfersInterface } from "@starkware-libs/starknet-privacy-sdk";

export interface PrivacyClientConfig {
  rpcUrl: string;
  accountAddress: string;
  accountPrivateKey: string;
  viewingKey: bigint;
  poolAddress: string;
  provingServiceUrl: string;
  indexerUrl: string;
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

  const transfers = createPrivateTransfers({
    account,
    viewingKeyProvider: { getViewingKey: async () => config.viewingKey },
    provingProvider: { url: config.provingServiceUrl, chainId },
    discoveryProvider: { url: config.indexerUrl },
    poolContractAddress: config.poolAddress,
  });

  return wrapPrivacyClient(account, provider, transfers);
}
