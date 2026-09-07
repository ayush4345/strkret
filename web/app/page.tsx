"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { Buffer } from "buffer";
import { signVoucher, voucherToWire, type PaymentRequirements } from "@strkret/agent-core/voucher";
import { RemoteService } from "../lib/remote-service";
import {
  listWallets,
  connectWallet,
  type WalletWithStarknetFeatures,
} from "../lib/wallet-client";
import type { WalletAccountV6 } from "starknet";
import { STRK_ADDRESS, ESCROW_AMOUNT, IS_MAINNET, formatStrk, shieldAction, settlementAction } from "../lib/protocol";

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

  // Ready has shown the deposit as done in its own UI while the
  // `strk20InvokeTransaction()` promise it returns to this page stayed
  // pending — observed directly, not theorized. Rather than trust that
  // promise to resolve in step with the wallet's own state, treat it as
  // advisory: if it settles, great, keep the real tx hash; if the wallet
  // visibly finished and this page is still stuck, a manual continue moves
  // on regardless. Nothing after this needs the deposit to have literally
  // resolved in our code — metering is off-chain, and by the time Settle is
  // clicked, real time has passed either way.
  const [shieldStuck, setShieldStuck] = useState(false);
  useEffect(() => {
    if (stage !== "shield" || !busy) {
      setShieldStuck(false);
      return;
    }
    const id = setTimeout(() => setShieldStuck(true), 6000);
    return () => clearTimeout(id);
  }, [stage, busy]);

  const doShield = useCallback(async () => {
    if (!account) return;
    setBusy(true);
    setError("");
    try {
      const { transaction_hash } = await account.strk20InvokeTransaction([shieldAction()]);
      setDepositTx(transaction_hash);
      setStage("chat");
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }, [account]);

  const continueAfterShield = useCallback(() => {
    setDepositTx((prev) => prev || "confirmed in wallet, hash not returned to this page");
    setStage("chat");
    setBusy(false);
  }, []);

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

  const [settleStuck, setSettleStuck] = useState(false);
  useEffect(() => {
    if (stage !== "settling") {
      setSettleStuck(false);
      return;
    }
    const id = setTimeout(() => setSettleStuck(true), 6000);
    return () => clearTimeout(id);
  }, [stage]);

  const settle = useCallback(async () => {
    if (!account || owed <= 0n) return;
    setBusy(true);
    setError("");
    setStage("settling");
    try {
      if (!IS_MAINNET && terms) {
        // The real anonymizer path: sign the current cumulative total with
        // the same session key that signed every metered call, then hand it
        // to our relayer backend. Ready can't relay a private tx invoking a
        // third-party contract itself (confirmed directly by the STRK20
        // team), so the relayer — holding its own registered, pre-shielded
        // account — submits `privacy_invoke` on this voucher's behalf and
        // pays the settlement fee. The voucher is verified again server-side
        // before anything moves; see lib/relayer.ts.
        const voucher = signVoucher(BigInt(terms.channelId), owed, terms.rateCommitment, sessionKeyRef.current);
        const res = await fetch("/api/relay-settle", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ voucher: voucherToWire(voucher), refundAddress: account.address }),
        });
        const data = (await res.json()) as { transactionHash?: string; error?: string };
        if (!res.ok || !data.transactionHash) throw new Error(data.error || "relay settlement failed");
        setSettleTx(data.transactionHash);
        setStage("settled");
      } else {
        // Mainnet: no funded relayer escrow yet, so this stays a plain
        // private transfer — see the "recorded anonymizer path" disclosure
        // below for where the on-chain enforcement is actually proven.
        const { transaction_hash } = await account.strk20InvokeTransaction([settlementAction(owed)]);
        setSettleTx(transaction_hash);
        setStage("settled");
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setStage("chat");
    } finally {
      setBusy(false);
    }
  }, [account, owed, terms]);

  // See continueAfterShield above — same observed gap between Ready's own
  // UI and the promise it returns to this page.
  const continueAfterSettle = useCallback(() => {
    setSettleTx((prev) => prev || "confirmed in wallet, hash not returned to this page");
    setStage("settled");
    setBusy(false);
  }, []);

  const sessionOpen = account && stage !== "connect" && stage !== "shield";
  const activeStep = !account ? 0 : stage === "shield" ? 1 : stage === "chat" ? 2 : 3;
  const explorer = IS_MAINNET ? "https://voyager.online" : "https://sepolia.voyager.online";

  return (
    <>
      <a className="skip-link" href="#console">Skip to console</a>
      <div className="announcement">
        <span>Private by protocol. Open by design.</span>
        <a href="https://strk20.starknet.io/hackathon" target="_blank" rel="noreferrer">Built for the STRK20 Private Sprint <span aria-hidden="true">↗</span></a>
      </div>
      <header className="site-header">
        <div className="wrap nav-bar">
          <a className="wordmark" href="#" aria-label="Strkret home">
            <span className="brand-mark" aria-hidden="true"><i /><i /><i /></span>strkret<span className="wordmark__dot">.</span>
          </a>
          <nav aria-label="Main navigation">
            <a href="#console">Console</a>
            <a href="#how-it-works">How it works</a>
            <a href="https://github.com/ayush4345/strkret" target="_blank" rel="noreferrer">GitHub <span aria-hidden="true">↗</span></a>
          </nav>
          <span className="network"><i className="status-dot" />Starknet {IS_MAINNET ? "mainnet" : "Sepolia"}</span>
        </div>
      </header>

      <main>
        <section className="hero">
          <div className="hero__grid" aria-hidden="true" />
          <div className="wrap hero__inner">
            <p className="eyebrow"><span />Confidential agent commerce</p>
            <h1>EVERY CALL COUNTS.<br /><span>ONE PRIVATE PAYMENT.</span></h1>
            <p className="hero__description">
              Put your agents to work. Meter every request off-chain, then settle the total
              through STRK20 on Starknet: {IS_MAINNET ? "one private transfer." : "one sponsored contract settlement on Sepolia."}
            </p>
            <div className="hero__actions">
              <a className="btn" href="#console">Launch console <span aria-hidden="true">↗</span></a>
              <a className="text-link" href="https://github.com/ayush4345/strkret#readme" target="_blank" rel="noreferrer">Explore the protocol <span aria-hidden="true">↗</span></a>
            </div>
            <div className="hero__facts" aria-label="Project evidence">
              <span><b>03</b> Recorded mainnet transactions</span>
              <span><b>14</b> Contract tests</span>
              <span><b>00</b> Transactions per API call</span>
            </div>
          </div>
        </section>

        <section className="workspace" id="console">
          <div className="wrap">
            <div className="section-heading">
              <div><p className="eyebrow">01 / Live console</p><h2>Your usage. Your wallet.</h2></div>
              <span className={`wallet-status ${account ? "wallet-status--connected" : ""}`}>
                <i className="status-dot" />{account ? shorten(account.address) : "Wallet not connected"}
              </span>
            </div>

            <div className="session-layout">
              <section className="terminal" aria-labelledby="terminal-heading">
                <div className="terminal__bar">
                  <h3 id="terminal-heading"><span aria-hidden="true">&gt;_</span> Agent terminal</h3>
                  <span className="terminal__state">{!account ? "Awaiting connection" : stage === "settled" ? "Payment submitted" : "Session active"}</span>
                </div>
                <ol className="steps" aria-label="Session progress">
                  {["Connect", "Shield", "Use", "Settle"].map((label, i) => (
                    <li key={label} className={i === activeStep ? "is-current" : i < activeStep ? "is-complete" : ""} aria-current={i === activeStep ? "step" : undefined}>
                      <span>{i < activeStep ? "✓" : `0${i + 1}`}</span>{label}
                    </li>
                  ))}
                </ol>

                {!account && (
                  <div className="onboarding">
                    <div className="terminal-symbol" aria-hidden="true">[ &gt;_ ]</div>
                    <p className="eyebrow">Your keys. Your private balance.</p>
                    <h3>Start a private session.</h3>
                    <p>Connect a privacy-enabled wallet to use the metered agent. Your wallet handles the keys, proofs, and payments.</p>
                    <div className="wallet-options">
                      {wallets.length === 0 ? (
                        <p className="waiting"><i className="status-dot" />No wallet detected. Install or unlock Ready, then reload.</p>
                      ) : wallets.map((w) => (
                        <button key={w.name} className="btn" onClick={() => void doConnect(w)} disabled={busy}>
                          Connect {w.name} <span aria-hidden="true">↗</span>
                        </button>
                      ))}
                    </div>
                    <p className="fine-print">Requires a wallet with STRK20 support · Wallet API ≥ 0.10.3</p>
                    {connectError && <p className="err" role="alert">{connectError}</p>}
                  </div>
                )}

                {account && stage === "shield" && (
                  <div className="onboarding onboarding--shield">
                    <div className="terminal-symbol" aria-hidden="true">[ 02 ]</div>
                    <p className="eyebrow">Fund your private balance</p>
                    <h3>A small deposit. A private start.</h3>
                    <p>Shield {formatStrk(ESCROW_AMOUNT)} STRK into your private balance. Your wallet may request a token approval first. Review the pool fee and gas charges before confirming.</p>
                    <div className="wallet-options">
                      <button className="btn" onClick={() => void doShield()} disabled={busy} type="button">
                        {busy ? "Waiting for wallet…" : "Shield funds"}<span aria-hidden="true">↗</span>
                      </button>
                      {shieldStuck && <button className="btn btn--ghost" onClick={continueAfterShield} type="button">Already confirmed in my wallet — continue</button>}
                    </div>
                    {shieldStuck && <p className="fine-print">If Ready already shows success, use Continue. Its response to this page can arrive late.</p>}
                    <p className="privacy-note">The deposit is public, including your address and amount. Funds stay under your control and are not locked in escrow.</p>
                    {error && <p className="err" role="alert">{error}</p>}
                  </div>
                )}

                {sessionOpen && (
                  <div className="conversation">
                    {calls.length === 0 ? (
                      <div className="empty-chat">
                        <span className="terminal-symbol" aria-hidden="true">&gt;_</span>
                        <h3>The agent is ready.</h3>
                        <p>Ask your first question. Each response adds to your signed usage total, with no on-chain transaction.</p>
                      </div>
                    ) : (
                      <ol className="log" aria-label="Conversation">
                        {calls.map((c) => (
                          <li className="turn" key={c.at}>
                            <div className="turn__row"><span className="turn__who">You</span><p>{c.prompt}</p></div>
                            <div className="turn__row turn__row--agent"><span className="turn__who">Agent</span><div><p>{c.completion}</p><div className="turn__meta"><span>+{c.cost} units</span><span>Signed total: {c.claimAfter}</span><span>No transaction</span></div></div></div>
                          </li>
                        ))}
                      </ol>
                    )}
                    <div className="composer">
                      <form onSubmit={(e) => { e.preventDefault(); void ask(); }}>
                        <label className="sr-only" htmlFor="agent-prompt">Prompt</label>
                        <span className="composer__prefix" aria-hidden="true">&gt;</span>
                        <input id="agent-prompt" ref={inputRef} type="text" value={prompt} onChange={(e) => setPrompt(e.target.value)} placeholder="Ask the provider agent…" disabled={busy || stage === "settled"} />
                        <button className="btn" type="submit" disabled={busy || !prompt.trim() || stage === "settled"}>{busy && stage !== "settling" ? "Working…" : "Ask & meter"}<span aria-hidden="true">↗</span></button>
                      </form>
                      <div className="settlement-controls">
                        <p>Signed per call. Paid together.</p>
                        <button className="btn btn--ghost" type="button" onClick={() => void settle()} disabled={busy || owed <= 0n || stage === "settled"}>{stage === "settling" ? "Settling…" : stage === "settled" ? "Settlement submitted" : "Settle now"}<span aria-hidden="true">↗</span></button>
                      </div>
                      {settleStuck && (IS_MAINNET
                        ? <button className="text-link continue-link" type="button" onClick={continueAfterSettle}>Already confirmed in my wallet — continue →</button>
                        : <p className="fine-print" role="status">The relayer is preparing and submitting the proof. Wait for a transaction link; no wallet approval is needed here.</p>)}
                      {error && <p className="err" role="alert">{error}</p>}
                      <p className="fine-print">{IS_MAINNET ? "Before settling, wait for the deposit to confirm and its notes to mature (about 10 blocks). Keep enough funds for the pool fee. Unused funds remain shielded." : "On Sepolia, the relayer funds the payout and pool fee. Your shielded deposit stays untouched; the relayer’s escrow remainder is credited to your wallet."}</p>
                      {(depositTx || settleTx) && (
                        <div className="receipts" aria-label="Transactions">
                          {[["Deposit", depositTx], ["Settlement", settleTx]].filter(([, tx]) => tx).map(([label, tx]) => (
                            <p key={label}><span>{label}</span>{tx.startsWith("0x") ? <a href={`${explorer}/tx/${tx}`} target="_blank" rel="noreferrer">{shorten(tx)} ↗</a> : <span>{tx}</span>}</p>
                          ))}
                        </div>
                      )}
                    </div>
                  </div>
                )}
                <div className="terminal__foot"><span><i className="status-dot" />Network: {IS_MAINNET ? "Mainnet" : "Sepolia"}</span><span>Powered by STRK20</span></div>
              </section>

              <aside className="session-sidebar" aria-label="Session details">
                <section className="usage-panel" aria-labelledby="usage-heading">
                  <div className="panel-heading"><h3 id="usage-heading">Session usage</h3><span className="live-label"><i className="status-dot" />{account ? "Live" : "Standby"}</span></div>
                  <p className="usage-label">Accrued off-chain</p>
                  <p className="usage-total" aria-live="polite">{owed.toString()}<span>units</span></p>
                  <div className="usage-rows">
                    <div><span>Usage value</span><b>{terms ? `${formatStrk(owed * BigInt(terms.rate))} STRK` : "—"}</b></div>
                    <div><span>Calls served</span><b>{calls.length.toString().padStart(2, "0")}</b></div>
                    <div><span>Per-call chain fees</span><b>0</b></div>
                    <div><span>Settlement</span><b className={owed > 0n ? "accent-text" : ""}>{stage === "settled" ? "Submitted" : owed > 0n ? "Ready" : "Nothing owed"}</b></div>
                  </div>
                  <p className="fine-print">{stage === "settled" ? "Check your wallet or the explorer for confirmation." : "Many signed requests. One private payment."}</p>
                </section>
                <section className="terms-panel" aria-labelledby="terms-heading">
                  <div className="panel-heading"><h3 id="terms-heading">Provider terms</h3><span>Published</span></div>
                  <dl className="usage-rows">
                    <div><dt>Channel</dt><dd>{terms?.channelId ?? "—"}</dd></div>
                    <div><dt>Rate per unit</dt><dd>{terms ? `${formatStrk(BigInt(terms.rate))} STRK` : "—"}</dd></div>
                    <div><dt>Minimum settlement</dt><dd>{terms ? `${terms.minSettlementUnits} units` : "—"}</dd></div>
                    <div><dt>Rate commitment</dt><dd title={terms?.rateCommitment}>{terms?.rateCommitment ? shorten(terms.rateCommitment) : "—"}</dd></div>
                  </dl>
                  <p className="fine-print">Usage units per started {terms?.pricing?.charsPerBlock ?? 100}-character block: {terms?.pricing?.unitsPerBlock ?? "1"}. Pool fees are separate.</p>
                </section>
                <p className="sidebar-note"><span aria-hidden="true">↳</span> {IS_MAINNET ? "Pool fees apply to shielding and settlement. Your wallet shows the current cost before you confirm." : "Your wallet shows the shielding fee. The relayer sponsors settlement from its own testnet funds."}</p>
              </aside>
            </div>
          </div>
        </section>

        <section className="how-section wrap" id="how-it-works">
          <div className="section-heading"><div><p className="eyebrow">02 / The protocol</p><h2>Meter per call. Settle per batch.</h2></div><span className="section-caption">Less on-chain. More done.</span></div>
          <figure className="flow-diagram" aria-labelledby="flow-caption">
            <figcaption id="flow-caption"><span>Visitor console flow</span><span>{IS_MAINNET ? "Mainnet · wallet payment" : "Sepolia · sponsored settlement"}</span></figcaption>
            <ol className="flow-stages">
              <li>
                <div className="flow-stage-heading"><h3><span>01 /</span> Shield once</h3><span className="flow-badge">Public deposit · pool fee</span></div>
                <div className="flow-route">
                  <div className="flow-node"><span className="flow-node-label">You control</span><h4>Your wallet</h4><p>Approve and deposit STRK.</p></div>
                  <div className="flow-connector"><span>Shield funds</span><i aria-hidden="true">→</i></div>
                  <div className="flow-node flow-node--pool"><span className="flow-node-label">STRK20 pool</span><h4>Your private balance</h4><p>Funds become shielded notes.</p></div>
                </div>
              </li>
              <li>
                <div className="flow-stage-heading"><h3><span>02 /</span> Use as needed</h3><span className="flow-badge flow-badge--offchain">Off-chain · repeat per call</span></div>
                <div className="flow-route">
                  <div className="flow-node"><span className="flow-node-label">In your browser</span><h4>Session key</h4><p>Sign a voucher for the running usage total.</p></div>
                  <div className="flow-connector flow-connector--both"><span>Prompt + signed voucher</span><i aria-hidden="true">→</i><i aria-hidden="true">←</i><span>AI response + cost</span></div>
                  <div className="flow-node"><span className="flow-node-label">Off-chain service</span><h4>Provider agent</h4><p>Verify the voucher, then run the model.</p></div>
                </div>
                <p className="flow-note">The signed total grows with each request. No payment transaction happens here.</p>
              </li>
              <li>
                <div className="flow-stage-heading"><h3><span>03 /</span> Settle the total</h3><span className="flow-badge">{IS_MAINNET ? "Private transfer · pool fee" : "Relayed to the contract · pool fee"}</span></div>
                {IS_MAINNET ? (
                  <div className="flow-route flow-route--three">
                    <div className="flow-node"><span className="flow-node-label">You approve</span><h4>Your wallet</h4><p>Authorize the accrued amount.</p></div>
                    <div className="flow-connector"><span>Private transfer</span><i aria-hidden="true">→</i></div>
                    <div className="flow-node flow-node--pool"><span className="flow-node-label">On-chain</span><h4>STRK20 pool</h4><p>Move shielded funds directly.</p></div>
                    <div className="flow-connector"><span>Credited privately</span><i aria-hidden="true">→</i></div>
                    <div className="flow-node"><span className="flow-node-label">Recipient</span><h4>Provider balance</h4><p>Receive the total inside the pool.</p></div>
                  </div>
                ) : (
                  <div className="flow-route flow-route--three">
                    <div className="flow-node"><span className="flow-node-label">In your browser</span><h4>Session key</h4><p>Sign the cumulative usage total. No wallet approval at this step.</p></div>
                    <div className="flow-connector"><span>Signed voucher</span><i aria-hidden="true">→</i></div>
                    <div className="flow-node flow-node--pool"><span className="flow-node-label">Our backend · via STRK20</span><h4>Relayer</h4><p>Verify the voucher. Fund escrow and the fee from the relayer’s reserve, then submit the contract call.</p></div>
                    <div className="flow-connector"><span>On-chain enforcement</span><i aria-hidden="true">→</i></div>
                    <div className="flow-node"><span className="flow-node-label">MeteringAnonymizer</span><h4>Payout + remainder</h4><p>Credit the provider for unsettled usage × rate. Credit the escrow remainder to your wallet.</p></div>
                  </div>
                )}
                <p className="flow-note">
                  {IS_MAINNET
                    ? "Unused funds stay in your private balance. This console relies on you choosing to pay."
                    : "Sponsored with testnet STRK: your deposit is not spent or refunded by this step. Both credits come from the relayer’s escrow; open-note token and amounts are public."}
                </p>
              </li>
            </ol>
          </figure>
          <details className="contract-flow">
            <summary><span>{IS_MAINNET ? "Explore the recorded anonymizer path" : "Inside the anonymizer, step by step"}</span><span className="contract-flow__toggle" aria-hidden="true">+</span></summary>
            <div className="contract-flow__body">
              <p>{IS_MAINNET ? "The recorded SDK demo funds escrow and checks the signed usage and rate on-chain. This mainnet console uses a plain private transfer; its voucher does not enforce payment from your wallet." : "Inside stage 03: the relayer submits your signed voucher with its own escrow. The contract checks the signature and agreed rate, then returns credits to the pool."}</p>
              <div className="flow-route flow-route--three">
                <div className="flow-node"><span className="flow-node-label">Inputs</span><h4>Voucher + escrow</h4><p>{IS_MAINNET ? "Signed usage and consumer-funded escrow in the recorded SDK run." : "Signed usage and relayer-funded escrow on Sepolia."}</p></div>
                <div className="flow-connector"><span>Pool releases escrow</span><i aria-hidden="true">→</i></div>
                <div className="flow-node flow-node--pool"><span className="flow-node-label">MeteringAnonymizer</span><h4>Check and settle</h4><p>Verify signature and rate. Pay only the unsettled delta.</p></div>
                <div className="flow-connector"><span>Open-note credits</span><i aria-hidden="true">→</i></div>
                <div className="flow-node"><span className="flow-node-label">Back in the pool</span><h4>{IS_MAINNET ? "Payout + refund" : "Payout + remainder"}</h4><p>{IS_MAINNET ? "Provider receives payment; consumer receives unused escrow." : "Provider receives payment; your wallet receives the relayer’s remaining escrow."}</p></div>
              </div>
              <p className="flow-note">Open-note token and amount are public in this contract path. <a href="https://github.com/ayush4345/strkret#what-the-mainnet-run-cost" target="_blank" rel="noreferrer">See the recorded mainnet run ↗</a></p>
            </div>
          </details>
          <div className="disclosure"><span className="eyebrow">Know what stays private</span><p>Deposits and transaction timing are public. The provider sees your prompts and vouchers. {IS_MAINNET ? "Plain private transfers hide their amount and parties on-chain; contract open-note amounts are public." : "The relayer sees your voucher and wallet address. Contract open-note token and amounts are public; note owners are hidden."} Neither path hides your conversation from the provider.</p></div>
        </section>
      </main>
      <footer className="wrap site-footer"><a className="wordmark" href="#">strkret<span className="wordmark__dot">.</span></a><span>Confidential commerce for autonomous agents.</span><a className="text-link" href="https://github.com/ayush4345/strkret" target="_blank" rel="noreferrer">Open source ↗</a></footer>
    </>
  );
}
