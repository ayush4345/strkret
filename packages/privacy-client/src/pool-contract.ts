import { Contract, type ProviderInterface } from "starknet";
import { PrivacyPoolABI } from "@starkware-libs/starknet-privacy-sdk/abi";
import type { PoolContractInterface } from "@starkware-libs/starknet-privacy-sdk/testing";

/**
 * A pool handle for `ContractDiscoveryProvider`, which is all it needs to do
 * note discovery.
 *
 * Why this exists: discovery normally goes through a hosted indexer service,
 * and there isn't one for mainnet. But the pool exposes every view the
 * discovery walk needs — channels, subchannels, notes, nullifiers — so the
 * whole thing runs off ordinary `starknet_call`s against any RPC, with the
 * trial-decryption happening locally against the viewing key. That is
 * strictly better for privacy than a hosted indexer, which would otherwise
 * need the viewing key to do the same work.
 *
 * `PoolContractInterface` is exactly the pool's view functions, and
 * starknet.js already generates those from the ABI, so this is a cast rather
 * than a wrapper. The cast is doing real work — it asserts the generated
 * methods match the interface — so it is checked by
 * `agents/consumer/src/check-contract-discovery.ts`, which runs one account
 * through both this and a hosted indexer and compares the notes they find.
 *
 * The cost is RPC volume: discovery bisects and scans over channels and
 * notes, so this is many small calls rather than one indexed query. Pass
 * `rateLimit` through `DiscoveryOptions` when pointing it at a metered
 * endpoint.
 */
export function createPoolContract(address: string, provider: ProviderInterface): PoolContractInterface {
  return new Contract({ abi: PrivacyPoolABI, address, providerOrAccount: provider }) as unknown as PoolContractInterface;
}
