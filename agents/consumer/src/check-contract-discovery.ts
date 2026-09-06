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

type Balances = Map<string, bigint>;

function summarize(notes: Map<bigint, { amount: bigint }[]> | any): Balances {
  const out: Balances = new Map();
  for (const [token, list] of notes.entries()) {
    out.set("0x" + BigInt(token).toString(16), (list as { amount: bigint }[]).reduce((s, n) => s + n.amount, 0n));
  }
  return out;
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
  const a = summarize((await viaIndexer.discoverNotes()).notes);

  console.log("discovering via pool contract calls (no indexer)...");
  const viaContract = createPrivateTransfers({
    ...shared,
    discoveryProvider: new ContractDiscoveryProvider(createPoolContract(env.poolAddress, provider)),
  } as any);
  const b = summarize((await viaContract.discoverNotes()).notes);

  const tokens = new Set([...a.keys(), ...b.keys()]);
  let mismatch = false;
  for (const t of tokens) {
    const x = a.get(t) ?? 0n;
    const y = b.get(t) ?? 0n;
    console.log(`  ${t}: indexer=${x} contract=${y} ${x === y ? "match" : "MISMATCH"}`);
    if (x !== y) mismatch = true;
  }
  if (tokens.size === 0) console.log("  (no notes on either side — inconclusive, fund the account first)");
  if (mismatch) throw new Error("contract discovery disagreed with the hosted indexer");
  console.log("\nOK — contract discovery agrees with the hosted indexer.");
}

main().catch((err) => {
  console.error("\nfailed:");
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
