/**
 * Does contract-based discovery agree with the hosted indexer?
 *
 * Sepolia is the only place both exist, so it's the only place the question
 * can be answered. If the two return the same notes here, then discovery on
 * mainnet — where no hosted indexer exists — can run off plain RPC calls
 * instead of being blocked on one.
 */
import { RpcProvider, Account } from "starknet";
import { createPrivateTransfers } from "@starkware-libs/starknet-privacy-sdk";
import { ContractDiscoveryProvider } from "@starkware-libs/starknet-privacy-sdk/testing";
import { createPoolContract } from "@strkret/privacy-client";
import { env } from "./env.js";

/** Total the account holds in the escrow token, per whichever path found it. */
function total(notes: any): bigint {
  return (notes.get(BigInt(env.tokenAddress)) ?? []).reduce((s: bigint, n: { amount: bigint }) => s + n.amount, 0n);
}

async function main() {
  const provider = new RpcProvider({ nodeUrl: env.rpcUrl });
  const account = new Account({
    provider,
    address: env.consumer.address,
    signer: env.consumer.privateKey,
    cairoVersion: "1",
  });
  const shared = {
    account,
    viewingKeyProvider: { getViewingKey: async () => env.consumer.viewingKey },
    provingProvider: { url: env.provingServiceUrl, chainId: await provider.getChainId() },
    poolContractAddress: env.poolAddress,
  } as const;

  console.log("discovering via the hosted indexer...");
  const viaIndexer = createPrivateTransfers({ ...shared, discoveryProvider: { url: env.indexerUrl } } as any);
  const a = total((await viaIndexer.discoverNotes()).notes);

  console.log("discovering via pool contract calls (no indexer)...");
  const viaContract = createPrivateTransfers({
    ...shared,
    discoveryProvider: new ContractDiscoveryProvider(createPoolContract(env.poolAddress, provider)),
  } as any);
  const b = total((await viaContract.discoverNotes()).notes);

  console.log(`  ${env.tokenAddress}: indexer=${a} contract=${b} ${a === b ? "match" : "MISMATCH"}`);
  if (a !== b) throw new Error("contract discovery disagreed with the hosted indexer");
  if (a === 0n) throw new Error("both sides found nothing — inconclusive, fund the account first");
  console.log("\nOK — contract discovery agrees with the hosted indexer.");
}

main().catch((err) => {
  console.error("\nfailed:");
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
