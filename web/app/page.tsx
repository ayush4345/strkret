"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { Buffer } from "buffer";
import type { PaymentRequirements } from "@strkret/agent-core/voucher";
import { RemoteService } from "../lib/remote-service";
import {
  listWallets,
  connectWallet,
  type WalletWithStarknetFeatures,
  type STRK20_ACTION,
} from "../lib/wallet-client";
import type { WalletAccountV6 } from "starknet";
import { STRK_ADDRESS, PROVIDER_ADDRESS, ESCROW_AMOUNT } from "../lib/protocol";

interface CallRecord {
  prompt: string;
  completion: string;
  cost: string;
  claimAfter: string;
  at: number;
}

const shorten = (v: string) => (v.length > 22 ? `${v.slice(0, 10)}…${v.slice(-6)}` : v);

type Stage = "connect" | "shield" | "chat" | "settling" | "settled";

export default function Page() {
  const [wallets, setWallets] = useState<readonly WalletWithStarknetFeatures[]>([]);
  const [account, setAccount] = useState<WalletAccountV6 | null>(null);
  const [connectError, setConnectError] = useState("");
  const [stage, setStage] = useState<Stage>("connect");

  const [terms, setTerms] = useState<PaymentRequirements | null>(null);
  const serviceRef = useRef<RemoteService | null>(null);
  const sessionKeyRef = useRef<string>("");
  if (!sessionKeyRef.current) {
    // An ephemeral, per-visit metering key — signs vouchers only, never
    // touches funds. The wallet remains the sole custodian of anything that
    // moves value; this key just proves "I asked for this many calls."
    // 31 random bytes (248 bits) stays safely under the stark curve order,
    // which a full 32 bytes is not guaranteed to.
    const bytes = new Uint8Array(31);
    crypto.getRandomValues(bytes);
    sessionKeyRef.current = "0x" + Buffer.from(bytes).toString("hex");
  }

  const [prompt, setPrompt] = useState("What is a nullifier in a shielded pool?");
  const [calls, setCalls] = useState<CallRecord[]>([]);
  const [owed, setOwed] = useState(0n);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [depositTx, setDepositTx] = useState("");
  const [settleTx, setSettleTx] = useState("");
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    fetch("/api/terms")
      .then((r) => r.json())
      .then(setTerms)
      .catch(() => setError("could not reach /api/terms"));
  }, []);

  useEffect(() => listWallets(setWallets), []);

  const doConnect = useCallback(async (w: WalletWithStarknetFeatures) => {
    setConnectError("");
    try {
      const acct = await connectWallet(w);
      setAccount(acct);
      setStage("shield");
    } catch (e) {
      setConnectError(e instanceof Error ? e.message : String(e));
    }
  }, []);

  const doShield = useCallback(async () => {
    if (!account) return;
    setBusy(true);
    setError("");
    try {
      const actions: STRK20_ACTION[] = [{ type: "deposit", token: STRK_ADDRESS, amount: ESCROW_AMOUNT.toString() }];
      const { transaction_hash } = await account.strk20InvokeTransaction(actions);
      setDepositTx(transaction_hash);
      setStage("chat");
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }, [account]);

  const ask = useCallback(async () => {
    if (!prompt.trim()) return;
    setBusy(true);
    setError("");
    try {
      if (!serviceRef.current) {
        serviceRef.current = await RemoteService.open("/api", sessionKeyRef.current, STRK_ADDRESS);
      }
      const service = serviceRef.current;
      const cost = service.price({ prompt });
      const { completion } = await service.handle({ prompt });
      setOwed(service.authorizedUnits);
      setCalls((prev) => [
        ...prev,
        { prompt, completion, cost: cost.toString(), claimAfter: service.authorizedUnits.toString(), at: Date.now() },
      ]);
      setPrompt("");
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
      inputRef.current?.focus();
    }
  }, [prompt]);

  const settle = useCallback(async () => {
    if (!account || owed <= 0n) return;
    setBusy(true);
    setError("");
    setStage("settling");
    try {
      // A plain private transfer, not our anonymizer's `privacy_invoke` —
      // Ready currently only relays a private tx whose proof it generated
      // itself, and that covers the basic pool ops (deposit/withdraw/
      // transfer) but not an arbitrary third-party contract invoke. The
      // anonymizer's on-chain rate/signature enforcement is proven
      // separately by the mainnet run recorded in strk20.json; this path
      // trades that enforcement for something that actually relays today.
      // A plain transfer between registered pool users hides the amount
      // too (our provider registered on this pool in that same mainnet
      // run), unlike the anonymizer path, where the amount is public.
      const actions: STRK20_ACTION[] = [
        { type: "transfer", token: STRK_ADDRESS, amount: owed.toString(), recipient: PROVIDER_ADDRESS },
      ];
      const { transaction_hash } = await account.strk20InvokeTransaction(actions);
      setSettleTx(transaction_hash);
      setStage("settled");
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setStage("chat");
    } finally {
      setBusy(false);
    }
  }, [account, owed]);

  return (
    <main className="shell dash">
      <header className="dash__head">
        <div>
          <h1>Strkret</h1>
          <p className="dash__sub">
            A live mainnet channel: connect your own privacy-enabled Starknet wallet, chat with a
            metered provider agent off-chain and free, then settle in one shielded transaction
            through the pool. You pay only the flat protocol fee — the number this project exists
            to amortise.
          </p>
        </div>
        <span className={`pill ${account ? "pill--open" : "pill--work"}`}>
          <i className="pill__dot" />
          {account ? shorten(account.address) : "wallet not connected"}
        </span>
      </header>

      {!account && (
        <section className="panel" style={{ marginTop: "1.75rem" }}>
          <h2 className="panel__head">1 · Connect a privacy-enabled wallet</h2>
          <p className="panel__note">
            Needs the STRK20 Wallet API (Wallet API ≥ 0.10.3) — the Ready extension is the wallet
            the STRK20 team tests this against. Your wallet handles your viewing key and proving;
            this page never sees either.
          </p>
          {wallets.length === 0 ? (
            <p className="hint">No wallet detected yet. Install or unlock one, then reload.</p>
          ) : (
            <div className="ask" style={{ marginTop: "1rem" }}>
              {wallets.map((w) => (
                <button key={w.name} className="btn" onClick={() => void doConnect(w)} disabled={busy}>
                  Connect {w.name}
                </button>
              ))}
            </div>
          )}
          {connectError && <p className="err">{connectError}</p>}
        </section>
      )}

      {account && stage === "shield" && (
        <section className="panel" style={{ marginTop: "1.75rem" }}>
          <h2 className="panel__head">2 · Shield the escrow</h2>
          <p className="panel__note">
            One wallet-prompted mainnet transaction: shields {ESCROW_AMOUNT.toString()} raw units of
            STRK (about 1e-15 STRK — economically nothing) into the pool, plus the pool&rsquo;s flat
            protocol fee. This is the real cost of the demo, and it&rsquo;s the number the whole
            project argues you should pay once, not per call.
          </p>
          <button className="btn" onClick={() => void doShield()} disabled={busy} style={{ marginTop: "1rem" }}>
            {busy ? "Waiting for wallet…" : "Shield escrow"}
          </button>
          {error && <p className="err">{error}</p>}
        </section>
      )}

      {account && stage !== "connect" && stage !== "shield" && (
        <>
          <section className="tape" aria-label="Session meters" style={{ marginTop: "1.75rem" }}>
            <div className="tape__cell">
              <div className="tape__k">accrued off-chain</div>
              <div className="tape__v tape__v--meter">{owed.toString()}</div>
              <div className="tape__s">signed per call · no chain contact · free</div>
            </div>
            <div className="tape__cell">
              <div className="tape__k">calls served</div>
              <div className="tape__v tape__v--brand">{calls.length}</div>
              <div className="tape__s">this channel, this browser session</div>
            </div>
            <div className="tape__cell">
              <div className="tape__k">settlement</div>
              <div className="tape__v">{stage === "settled" ? "done" : owed > 0n ? "ready" : "nothing owed"}</div>
              <div className="tape__s">
                {stage === "settled" ? "paid on mainnet" : "one flat fee, whenever you choose"}
              </div>
            </div>
          </section>

          <div className="dash__grid">
            <section className="panel" aria-labelledby="p-console">
              <h2 id="p-console" className="panel__head">3 · Agent console</h2>
              <form
                className="ask"
                onSubmit={(e) => {
                  e.preventDefault();
                  void ask();
                }}
              >
                <input
                  ref={inputRef}
                  type="text"
                  value={prompt}
                  onChange={(e) => setPrompt(e.target.value)}
                  placeholder="Ask the provider agent…"
                  disabled={busy || stage === "settled"}
                  aria-label="Prompt"
                />
                <button className="btn" type="submit" disabled={busy || !prompt.trim() || stage === "settled"}>
                  {busy && stage !== "settling" ? "Working…" : "Ask & meter"}
                </button>
                <button
                  className="btn btn--ghost"
                  type="button"
                  onClick={() => void settle()}
                  disabled={busy || owed <= 0n || stage === "settled"}
                >
                  {stage === "settling" ? "Settling…" : "Settle now"}
                </button>
              </form>
              <p className="ask__hint">
                Every call signs a fresh voucher off-chain and free. Settling is your decision —
                one wallet-prompted transaction pays the provider and refunds the rest, whatever
                the number of calls behind it.
              </p>
              {error && <p className="err">{error}</p>}
              {depositTx && (
                <p className="ask__hint">
                  escrow tx: <code>{shorten(depositTx)}</code>
                </p>
              )}
              {settleTx && (
                <p className="ask__hint">
                  settled — <code>{shorten(settleTx)}</code>
                </p>
              )}

              {calls.length === 0 ? (
                <p className="hint">No calls yet — ask something above.</p>
              ) : (
                <ul className="log">
                  {[...calls].reverse().map((c) => (
                    <li className="turn" key={c.at}>
                      <div className="turn__row turn__row--you">
                        <span className="turn__who">you</span>
                        <p className="turn__text">{c.prompt}</p>
                      </div>
                      <div className="turn__row turn__row--agent">
                        <span className="turn__who">agent</span>
                        <p className="turn__text">{c.completion}</p>
                        <div className="turn__meta">
                          <span>cost {c.cost}</span>
                          <span>signed claim {c.claimAfter}</span>
                          <span>chain untouched</span>
                        </div>
                      </div>
                    </li>
                  ))}
                </ul>
              )}
            </section>

            <div style={{ display: "grid", gap: "1.25rem", alignContent: "start" }}>
              <section className="panel" aria-labelledby="p-terms">
                <h2 id="p-terms" className="panel__head">Channel terms — from GET /api/terms</h2>
                <dl className="rows">
                  <div><dt>Channel</dt><dd className="is-num">{terms?.channelId ?? "—"}</dd></div>
                  <div><dt>Base rate</dt><dd className="is-num">{terms?.rate ?? "—"}</dd></div>
                  <div><dt>Min settle</dt><dd className="is-num">{terms?.minSettlementUnits ?? "—"}</dd></div>
                  <div>
                    <dt>Rate commitment</dt>
                    <dd className="is-num" title={terms?.rateCommitment}>
                      {terms?.rateCommitment ? shorten(terms.rateCommitment) : "—"}
                    </dd>
                  </div>
                </dl>
                <p className="panel__note">
                  Every call signs a voucher over the rate commitment above, and the provider
                  refuses to serve one signed for less than it should — that&rsquo;s what gates
                  metering. Settlement itself is a plain private transfer for whatever accrued,
                  amount and identities both hidden: Ready relays a wallet-generated proof for the
                  pool&rsquo;s own operations, not an arbitrary contract call, so this path
                  doesn&rsquo;t route through our anonymizer the way the recorded mainnet run
                  does — that on-chain rate/signature enforcement is proven separately, in{" "}
                  <code>strk20.json</code>.
                </p>
              </section>

              <section className="panel" aria-labelledby="p-why">
                <h2 id="p-why" className="panel__head">What you&rsquo;re actually paying</h2>
                <p className="panel__note" style={{ marginTop: ".875rem" }}>
                  The pool charges a <b>flat protocol fee per settlement</b> — 6 STRK on mainnet —
                  regardless of how much value moves. Two wallet-prompted transactions this page
                  makes (shield, settle) each pay that fee once; the calls in between cost nothing
                  and touch no chain, however many you ask.
                </p>
              </section>
            </div>
          </div>
        </>
      )}
    </main>
  );
}
