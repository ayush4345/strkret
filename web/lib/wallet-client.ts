"use client";
import { Buffer } from "buffer";
if (typeof globalThis.Buffer === "undefined") {
  (globalThis as unknown as { Buffer: typeof Buffer }).Buffer = Buffer;
}

/**
 * Browser-only wiring for the Starknet STRK20 Wallet API. Connects to a
 * privacy-enabled wallet (the Ready extension, per the STRK20 team's own
 * testing note), then issues shield/withdraw/invoke actions through it — the
 * wallet holds the viewing key and does the proving; this app never sees
 * private state.
 *
 * Version baseline this is built against: starknet.js 10.5.0 (STRK20 support
 * landed 10.4.0), get-starknet-discovery/wallet-standard 6.0.3, types-js
 * 0.10.3 — matching `.agents/skills/strk20-wallet-api/SKILL.md`.
 */
import { createStore } from "@starknet-io/get-starknet-discovery";
import type { WalletWithStarknetFeatures } from "@starknet-io/get-starknet-wallet-standard/features";
import { RpcProvider, WalletAccountV6, walletV6, compareVersions, type STRK20_ACTION } from "starknet";
import { RPC_URL } from "./protocol";

export type { WalletWithStarknetFeatures };

/** Discover wallets currently injected into the page. Call after the page
 * has mounted — wallets register themselves asynchronously on load. */
export function listWallets(onChange: (wallets: readonly WalletWithStarknetFeatures[]) => void): () => void {
  const store = createStore();
  onChange(store.getWallets() as WalletWithStarknetFeatures[]);
  return store.subscribe(onChange as (w: readonly WalletWithStarknetFeatures[]) => void);
}

const provider = new RpcProvider({ nodeUrl: RPC_URL });

/** Minimum Wallet API version the STRK20 actions below need. */
const MIN_WALLET_API = "0.10.3";

/**
 * Connect to one wallet and confirm it actually understands the STRK20
 * methods below via a version query — never by probing with a real
 * balance/action call, which would trip a wallet's consent prompt for a
 * call that was only ever meant to check capability.
 */
export async function connectWallet(wallet: WalletWithStarknetFeatures): Promise<WalletAccountV6> {
  // get-starknet-discovery@6.0.3 (which produced `wallet`) resolves against a
  // newer @starknet-io/types-js than the get-starknet-wallet-standard-v6
  // copy bundled inside starknet@10.5.0 itself, so pnpm keeps two physically
  // distinct, structurally-identical copies of `WalletWithStarknetFeatures`.
  // TS treats them as different nominal types; at runtime they're the same
  // Wallet Standard object. Cast at this one boundary rather than pin the
  // whole dependency graph to a single older release under time pressure.
  const w = wallet as unknown as Parameters<typeof walletV6.supportedWalletApi>[0];
  const versions = await walletV6.supportedWalletApi(w);
  const supported = versions.some((v) => compareVersions(v, MIN_WALLET_API) >= 0);
  if (!supported) {
    throw new Error(
      `this wallet does not advertise STRK20 Wallet API >= ${MIN_WALLET_API}. ` +
        "Try the Ready extension, updated to a build with private-account support.",
    );
  }
  return WalletAccountV6.connect(provider, w);
}

export type { STRK20_ACTION };
