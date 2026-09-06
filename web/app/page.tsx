"use client";

import { useCallback, useEffect, useState } from "react";

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

const short = (h: string) => (h.length > 20 ? `${h.slice(0, 12)}…${h.slice(-8)}` : h);

export default function Page() {
  const [state, setState] = useState<State | null>(null);
  const [prompt, setPrompt] = useState("What is a nullifier in a shielded pool?");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  const refresh = useCallback(async () => {
    try {
      const res = await fetch("/api/state", { cache: "no-store" });
      const data = (await res.json()) as State & { error?: string };
      if (res.ok) setState(data);
      else setError(data.error ?? "session unreachable");
    } catch {
      setError("session server unreachable");
    }
  }, []);

  // Poll while booting or settling; both finish on their own and the page
  // should reflect that without the user reloading.
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
    }
  };

  const phase = state?.phase ?? "booting";
  const ready = phase === "ready";
  const terms = state?.terms ?? {};
  const unsettled = state ? BigInt(state.owed) - BigInt(state.settled) : 0n;

  // Interleave calls and settlements so the log reads in the order things
  // actually happened — a settlement fires mid-session, not at the end.
  const timeline = [
    ...(state?.calls ?? []).map((c) => ({ kind: "call" as const, at: c.at, c })),
    ...(state?.settlements ?? []).map((s) => ({ kind: "settle" as const, at: s.at, s })),
  ].sort((a, b) => b.at - a.at);

  return (
    <div className="wrap">
      <header>
        <p className="eyebrow">STRK20 · live devnet session</p>
        <h1>Strkret</h1>
        <p>
          A consumer agent buying metered work from a provider agent, paid for through the STRK20
          privacy pool. Metering happens per call and off-chain; settlement is batched and shielded.
          This runs against a local devnet — the real pool contract and real proofs, on a chain that
          mines instantly.
        </p>
      </header>

      <div className="status">
        <span className={`dot ${phase}`} />
        {phase === "booting" && <span>Booting — {state?.detail || "starting"}… (~30s: devnet, contracts, register, deposit)</span>}
        {phase === "ready" && <span>Ready — channel open, escrow deposited</span>}
        {phase === "settling" && <span>Settling on-chain…</span>}
        {phase === "failed" && <span className="err">Failed — {state?.error}</span>}
      </div>

      <div className="meters">
        <div className="meter free">
          <div className="k">Owed (off-chain)</div>
          <div className="v">{state?.owed ?? "0"}</div>
        </div>
        <div className="meter paid">
          <div className="k">Settled (on-chain)</div>
          <div className="v">{state?.settled ?? "0"}</div>
        </div>
        <div className="meter">
          <div className="k">Unsettled / threshold</div>
          <div className="v">{unsettled.toString()}/{state?.threshold ?? "—"}</div>
        </div>
      </div>

      <div className="grid">
        <div className="card">
          <p className="eyebrow">Ask the provider agent</p>
          <form
            onSubmit={(e) => {
              e.preventDefault();
              if (prompt.trim()) void post("/api/call", { prompt });
            }}
          >
            <input
              type="text"
              value={prompt}
              onChange={(e) => setPrompt(e.target.value)}
              placeholder="Ask something…"
              disabled={!ready || busy}
              aria-label="Prompt"
            />
            <button type="submit" disabled={!ready || busy || !prompt.trim()}>
              {busy ? "Working…" : "Ask & meter"}
            </button>
          </form>
          <div style={{ display: "flex", gap: ".6rem", alignItems: "center" }}>
            <button className="ghost" onClick={() => void post("/api/settle")} disabled={!ready || busy || unsettled <= 0n}>
              Settle now ({unsettled.toString()})
            </button>
            <span className="note">
              Each call signs a fresh voucher for the running total. Settlement fires automatically
              once {state?.threshold ?? "…"} units are owed.
            </span>
          </div>
          {error && <p className="err">{error}</p>}

          <div className="log">
            {timeline.length === 0 && <p className="empty">No calls yet — ask something above.</p>}
            {timeline.map((row) =>
              row.kind === "call" ? (
                <div className="entry" key={`c${row.at}`}>
                  <div className="q">{row.c.prompt}</div>
                  <div className="a">{row.c.completion}</div>
                  <div className="m">
                    cost {row.c.cost} · signed claim now {row.c.claimAfter} units · no chain contact
                  </div>
                </div>
              ) : (
                <div className="entry settle" key={`s${row.at}`}>
                  <div className="q">Settled {row.s.amount} units privately</div>
                  <div className="m">one private transfer — amount, sender and recipient all hidden</div>
                  <a href={`#${row.s.txHash}`} onClick={(e) => e.preventDefault()}>{row.s.txHash}</a>
                </div>
              ),
            )}
          </div>
        </div>

        <div className="card">
          <p className="eyebrow">Channel terms — from the 402</p>
          <dl className="terms">
            <dt>service</dt><dd>{state?.serviceName || "—"}</dd>
            <dt>channel</dt><dd>{terms.channelId ?? "—"}</dd>
            <dt>base rate</dt><dd>{terms.rate ?? "—"}</dd>
            <dt>pricing</dt>
            <dd>
              {terms.pricing
                ? `${terms.pricing.unitsPerBlock} / ${terms.pricing.charsPerBlock} chars`
                : "flat per call"}
            </dd>
            <dt>min settle</dt><dd>{terms.minSettlementUnits ?? "—"}</dd>
            <dt>escrow</dt><dd>{state?.deposit ?? "—"}</dd>
            <dt>asset</dt><dd>{terms.asset ? short(terms.asset) : "—"}</dd>
            <dt>rate commit</dt><dd>{terms.rateCommitment ? short(terms.rateCommitment) : "—"}</dd>
          </dl>
          <p className="note">
            The provider answered the first unpaid call with <code>402 Payment Required</code> and
            these terms. The consumer signs every voucher over the rate commitment above, so a
            settlement can only happen at the rate this channel was opened at.
          </p>
          <p className="note">
            Settlement costs a flat protocol fee — 6 STRK on mainnet — regardless of size. That is
            why metering stays off-chain and settlement batches.
          </p>
        </div>
      </div>
    </div>
  );
}
