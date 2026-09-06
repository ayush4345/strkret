import { Contract, type BigNumberish, type ProviderInterface } from "starknet";
import { PrivacyPoolABI } from "@starkware-libs/starknet-privacy-sdk/abi";
import type { PoolContractInterface } from "@starkware-libs/starknet-privacy-sdk/testing";

/**
 * Adapts a plain starknet.js `Contract` to the SDK's `PoolContractInterface`,
 * which is all `ContractDiscoveryProvider` needs to do note discovery.
 *
 * Why this exists: discovery normally goes through a hosted indexer service,
 * and there isn't one for mainnet. But the pool exposes every view the
 * discovery walk needs — channels, subchannels, notes, nullifiers — so the
 * whole thing can run off ordinary `starknet_call`s against any RPC, with
 * the trial-decryption happening locally against the viewing key. That is
 * strictly better for privacy than a hosted indexer, which would otherwise
 * need the viewing key to do the same work.
 *
 * The cost is RPC volume: discovery bisects and scans over channels and
 * notes, so this is many small calls rather than one indexed query. Pass
 * `rateLimit` through `DiscoveryOptions` when pointing it at a metered
 * endpoint.
 *
 * Return values are read positionally where a struct comes back, because
 * starknet.js decodes Cairo structs to objects keyed by field name and the
 * SDK only ever reads those fields — converting defensively here keeps a
 * decode-shape surprise from surfacing later as a failed decryption.
 */
export function createPoolContract(address: string, provider: ProviderInterface): PoolContractInterface {
  const contract = new Contract({ abi: PrivacyPoolABI, address, providerOrAccount: provider });

  const call = async (method: string, args: BigNumberish[] = []): Promise<any> =>
    contract.call(method, args, { parseResponse: true });

  return {
    async channel_exists(channelMarker) {
      return Boolean(await call("channel_exists", [channelMarker]));
    },
    async get_num_of_channels(recipientAddr) {
      return BigInt(await call("get_num_of_channels", [recipientAddr]));
    },
    async get_channel_info(recipientAddr, channelIndex) {
      const r = await call("get_channel_info", [recipientAddr, channelIndex]);
      return {
        ephemeral_pubkey: r.ephemeral_pubkey,
        enc_channel_key: r.enc_channel_key,
        enc_sender_addr: r.enc_sender_addr,
      };
    },
    async subchannel_exists(subchannelMarker) {
      return Boolean(await call("subchannel_exists", [subchannelMarker]));
    },
    async get_subchannel_info(subchannelId) {
      const r = await call("get_subchannel_info", [subchannelId]);
      return { salt: r.salt, enc_token: r.enc_token };
    },
    async get_outgoing_channel_info(outgoingChannelId) {
      const r = await call("get_outgoing_channel_info", [outgoingChannelId]);
      return { salt: r.salt, enc_recipient_addr: r.enc_recipient_addr };
    },
    async get_note(noteId) {
      const r = await call("get_note", [noteId]);
      return { packed_value: r.packed_value, token: r.token };
    },
    async nullifier_exists(nullifier) {
      return Boolean(await call("nullifier_exists", [nullifier]));
    },
    async get_public_key(userAddr) {
      return await call("get_public_key", [userAddr]);
    },
    async get_enc_private_key(userAddr) {
      const r = await call("get_enc_private_key", [userAddr]);
      return {
        auditor_public_key: r.auditor_public_key,
        ephemeral_pubkey: r.ephemeral_pubkey,
        enc_private_key: r.enc_private_key,
      };
    },
    async get_auditor_public_key() {
      return await call("get_auditor_public_key");
    },
    async get_fee_amount() {
      return BigInt(await call("get_fee_amount"));
    },
    async get_fee_collector() {
      return await call("get_fee_collector");
    },
    async get_proof_validity_blocks() {
      return BigInt(await call("get_proof_validity_blocks"));
    },
  };
}
