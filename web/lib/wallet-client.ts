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
import { RpcProvider, WalletAccountV6, type STRK20_ACTION } from "starknet";
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

function withTimeout<T>(p: Promise<T>, ms: number, label: string): Promise<T> {
  return Promise.race([
    p,
    new Promise<T>((_, reject) => setTimeout(() => reject(new Error(`${label} timed out after ${ms / 1000}s — check for a pending approval in your wallet`)), ms)),
  ]);
}

/**
 * Connect to one wallet.
 *
 * Deliberately does NOT probe `walletV6.supportedWalletApi()` first, despite
 * that being the documented capability-check pattern — observed directly,
 * not theorized: that call can simply hang with this wallet, silently,
 * with no popup and no rejection, which reads to a visitor as "nothing
 * happens" when they click Connect. The same promise-doesn't-resolve
 * behavior showed up independently on the shield and settle actions (see
 * the continue-after-stuck handling in page.tsx) — treating it as a
 * pattern rather than three separate bugs. Going straight to the real
 * connect handshake, with a timeout so a hang is at least surfaced instead
 * of silent, is more robust than gating on a probe that may never answer.
 */
export async function connectWallet(wallet: WalletWithStarknetFeatures): Promise<WalletAccountV6> {
  return withTimeout(WalletAccountV6.connect(provider, wallet as never), 30_000, "Wallet connect");
}

export type { STRK20_ACTION };
