"use client";

import { useCallback, useEffect, useRef, useState } from "react";

interface Terms {
  rate?: string;
  pricing?: { unitsPerBlock: string; charsPerBlock: number };
  channelId?: string;
  rateCommitment?: string;
  asset?: string;
  minSettlementUnits?: string;
  settlementContract?: string;
}
interface CallRecord { prompt: string; completion: string; cost: string; claimAfter: string; at: number }
interface SettlementRecord { amount: string; txHash: string; at: number }
interface State {
  phase: "booting" | "ready" | "settling" | "failed";
  detail: string; error: string;
  terms: Terms | null; serviceName: string;
  deposit: string; threshold: string; owed: string; settled: string;
  calls: CallRecord[]; settlements: SettlementRecord[];
}

const shorten = (v: string) => (v.length > 22 ? `${v.slice(0, 12)}…${v.slice(-6)}` : v);

export default function Page() {
  const [state, setState] = useState<State | null>(null);
  const [prompt, setPrompt] = useState("What is a nullifier in a shielded pool?");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const inputRef = useRef<HTMLInputElement>(null);

  const refresh = useCallback(async () => {
    try {
      const res = await fetch("/api/state", { cache: "no-store" });
      const data = (await res.json()) as State & { error?: string };
      if (res.ok) { setState(data); setError(""); }
      else setError(data.error ?? "session unreachable");
    } catch {
      setError("session server unreachable — run: pnpm --filter @strkret/agent-consumer run serve");
    }
  }, []);

  // Boot and settlement both finish on their own; poll so the page reflects
  // that without anyone reloading.
  useEffect(() => {
    void refresh();
    const id = setInterval(refresh, 1500);
    return () => clearInterval(id);
  }, [refresh]);

  const post = async (path: string, body?: unknown) => {
    setBusy(true);
    setError("");
    try {
      const res = await fetch(path, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: body ? JSON.stringify(body) : undefined,
      });
      const data = (await res.json()) as { ok?: boolean; error?: string };
      if (!data.ok) setError(data.error ?? "request failed");
      await refresh();
    } catch {
      setError("request failed");
    } finally {
      setBusy(false);
      inputRef.current?.focus();
    }
  };

  const phase = state?.phase ?? "booting";
  const ready = phase === "ready";
  const terms = state?.terms ?? {};
  const owed = BigInt(state?.owed ?? "0");
  const settled = BigInt(state?.settled ?? "0");
  const unsettled = owed - settled;
  // Calls covered by the next settlement. This is the amortisation factor —
  // one flat fee divided across however many calls you waited for — and it is
  // the number the whole design turns on.
  const lastSettleAt = state?.settlements.length ? state.settlements[state.settlements.length - 1].at : 0;
  const callsSinceSettle = (state?.calls ?? []).filter((c) => c.at > lastSettleAt).length;

  // Interleaved, newest first: a settlement fires mid-session, so the log has
  // to show it where it actually happened rather than in a separate list.
  const timeline = [
    ...(state?.calls ?? []).map((c) => ({ kind: "call" as const, at: c.at, c })),
    ...(state?.settlements ?? []).map((s) => ({ kind: "settle" as const, at: s.at, s })),
  ].sort((a, b) => b.at - a.at);

  const pillClass =
    phase === "ready" ? "pill pill--open"
    : phase === "failed" ? "pill pill--bad"
    : "pill pill--work";

  return (
    <main className="shell dash">
      <header className="dash__head">
        <div>
          <h1>Strkret</h1>
          <p className="dash__sub">
            A consumer agent buying metered work from a provider agent, settled confidentially
            through the STRK20 privacy pool. Metering is per call and off-chain; settlement is
            batched and shielded.
          </p>
        </div>
        <span className={pillClass}>
          <i className="pill__dot" />
          {phase === "booting" && (state?.detail || "booting")}
          {phase === "ready" && "channel open"}
          {phase === "settling" && "settling on-chain"}
          {phase === "failed" && "failed"}
        </span>
      </header>

      {phase === "failed" && <p className="err">{state?.error}</p>}

      <section className="tape" aria-label="Session meters">
        <div className="tape__cell">
          <div className="tape__k">accrued off-chain</div>
          <div className="tape__v tape__v--meter">{owed.toString()}</div>
          <div className="tape__s">signed per call · no chain contact · free</div>
        </div>
        <div className="tape__cell">
          <div className="tape__k">settled on-chain</div>
          <div className="tape__v tape__v--brand">{settled.toString()}</div>
          <div className="tape__s">
            {state?.settlements.length ?? 0} settlement{(state?.settlements.length ?? 0) === 1 ? "" : "s"} · one flat fee each
          </div>
        </div>
        <div className="tape__cell">
          <div className="tape__k">next settlement covers</div>
          <div className="tape__v">
            {callsSinceSettle}
            <span style={{ fontSize: ".45em", color: "var(--on-paper-mute)" }}>
              {callsSinceSettle === 1 ? " call" : " calls"}
            </span>
          </div>
          <div className="tape__s">
            {callsSinceSettle === 0
              ? "nothing outstanding"
              : `one flat fee across ${callsSinceSettle} — wait longer, pay less per call`}
          </div>
        </div>
      </section>

      <div className="dash__grid">
        <section className="panel" aria-labelledby="p-console">
          <h2 id="p-console" className="panel__head">Agent console</h2>

          <form
            className="ask"
            onSubmit={(e) => {
              e.preventDefault();
              if (prompt.trim()) void post("/api/call", { prompt });
            }}
          >
            <input
              ref={inputRef}
              type="text"
              value={prompt}
              onChange={(e) => setPrompt(e.target.value)}
              placeholder="Ask the provider agent…"
              disabled={!ready || busy}
              aria-label="Prompt"
            />
            <button className="btn" type="submit" disabled={!ready || busy || !prompt.trim()}>
              {busy ? "Working…" : "Ask & meter"}
            </button>
            <button
              className="btn btn--ghost"
              type="button"
              onClick={() => void post("/api/settle")}
              disabled={!ready || busy || unsettled <= 0n}
            >
              Settle now
            </button>
          </form>
          <p className="ask__hint">
            Every call signs a fresh voucher for the running total, off-chain and free. Settling is
            a decision — each one pays the pool&rsquo;s flat fee whatever its size, so the longer
            you wait, the less that fee costs per call.
          </p>
          {error && <p className="err">{error}</p>}

          {timeline.length === 0 ? (
            <p className="hint">No calls yet — ask something above.</p>
          ) : (
            <ul className="log">
              {timeline.map((row) =>
                row.kind === "call" ? (
                  <li className="turn" key={`c${row.at}`}>
                    <div className="turn__row turn__row--you">
                      <span className="turn__who">you</span>
                      <p className="turn__text">{row.c.prompt}</p>
                    </div>
                    <div className="turn__row turn__row--agent">
                      <span className="turn__who">agent</span>
                      <p className="turn__text">{row.c.completion}</p>
                      <div className="turn__meta">
                        <span>cost {row.c.cost}</span>
                        <span>signed claim {row.c.claimAfter}</span>
                        <span>chain untouched</span>
                      </div>
                    </div>
                  </li>
                ) : (
                  <li className="event" key={`s${row.at}`}>
                    <div className="event__k">settlement</div>
                    <div className="event__v">
                      {row.s.amount} units paid in one private transfer — amount, sender and
                      recipient all hidden.
                    </div>
                    <div className="event__tx">{row.s.txHash}</div>
                  </li>
                ),
              )}
            </ul>
          )}
        </section>

        <div style={{ display: "grid", gap: "1.25rem", alignContent: "start" }}>
          <section className="panel" aria-labelledby="p-terms">
            <h2 id="p-terms" className="panel__head">Channel terms — from the 402</h2>
            <dl className="rows">
              <div><dt>Service</dt><dd>{state?.serviceName || "—"}</dd></div>
              <div><dt>Channel</dt><dd className="is-num">{terms.channelId ?? "—"}</dd></div>
              <div><dt>Base rate</dt><dd className="is-num">{terms.rate ?? "—"}</dd></div>
              <div>
                <dt>Pricing</dt>
                <dd className="is-num">
                  {terms.pricing
                    ? `${terms.pricing.unitsPerBlock} / ${terms.pricing.charsPerBlock} chars`
                    : "flat per call"}
                </dd>
              </div>
              <div><dt>Min settle</dt><dd className="is-num">{terms.minSettlementUnits ?? "—"}</dd></div>
              <div><dt>Escrow</dt><dd className="is-num">{state?.deposit ?? "—"}</dd></div>
              <div>
                <dt>Asset</dt>
                <dd className="is-num" title={terms.asset}>{terms.asset ? shorten(terms.asset) : "—"}</dd>
              </div>
              <div>
                <dt>Rate commitment</dt>
                <dd className="is-num" title={terms.rateCommitment}>
                  {terms.rateCommitment ? shorten(terms.rateCommitment) : "—"}
                </dd>
              </div>
            </dl>
            <p className="panel__note">
              The first unpaid call was answered with <code>402 Payment Required</code> and these
              terms. Every voucher is signed over the rate commitment above, so a settlement can
              only happen at the rate this channel was opened at.
            </p>
          </section>

          <section className="panel" aria-labelledby="p-why">
            <h2 id="p-why" className="panel__head">Why it batches</h2>
            <p className="panel__note" style={{ marginTop: ".875rem" }}>
              The pool charges a <b>flat protocol fee per settlement</b> — 6 STRK on mainnet —
              regardless of how much value moves. Settling per call would cost 6 STRK a call, which
              no per-call price can absorb.
            </p>
            <p className="panel__note">
              So metering stays off-chain and free, and only settlement touches the chain. This
              session runs on a local devnet: the real pool contract and real proofs, on a chain
              that mines on demand — Sepolia would wait ~10 blocks per settlement for note
              maturity.
            </p>
          </section>
        </div>
      </div>
    </main>
  );
}
