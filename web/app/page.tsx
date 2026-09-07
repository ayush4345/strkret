"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { Buffer } from "buffer";
import { signVoucher, voucherToWire, type PaymentRequirements } from "@strkret/agent-core/voucher";
import { RemoteService } from "../lib/remote-service";
import {
  listWallets,
  connectWallet,
  shieldedBalance,
  waitForBlock,
  provider as rpcProvider,
  type WalletWithStarknetFeatures,
} from "../lib/wallet-client";
import type { WalletAccountV6 } from "starknet";
import { STRK_ADDRESS, ESCROW_AMOUNT, IS_MAINNET, PROVIDER_ADDRESS, RELAYER_FEE_BUFFER, RATE, RELAYER_RESERVE_TOPUP, formatStrk, shieldAction, withdrawAction, fundRelayerReserveAction } from "../lib/protocol";

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
  const [shieldedBal, setShieldedBal] = useState<bigint | null>(null);
  const [withdrawTx, setWithdrawTx] = useState("");
  const [settleStatus, setSettleStatus] = useState("");
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
    // Only the funding withdraw is blocked on Ready's own promise; the
    // maturity wait and the relay-settle call are scripted polling/fetch,
    // not a wallet prompt, so a "stuck" escape hatch would be misleading
    // during those — they are supposed to take a few minutes.
    if (stage !== "settling" || settleStatus !== "Funding settlement…") {
      setSettleStuck(false);
      return;
    }
    const id = setTimeout(() => setSettleStuck(true), 6000);
    return () => clearTimeout(id);
  }, [stage, settleStatus]);

  // Step 3, factored out so the funded-normally path and the "continue"
  // fallback (funding already sent, just no tx hash to confirm it with)
  // both reach the same real settlement rather than duplicating it.
  const submitRelaySettle = useCallback(async () => {
    if (!account || owed <= 0n || !terms) return;
    setSettleStatus("Relayer settling through the anonymizer…");
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
  }, [account, owed, terms]);

  const settle = useCallback(async () => {
    if (!account || owed <= 0n || !terms) return;
    setBusy(true);
    setError("");
    setStage("settling");
    try {
      // Step 1 — fund the relayer. Ready can't relay a private tx invoking
      // a third-party contract itself (confirmed directly by the STRK20
      // team), so a separate relayer submits privacy_invoke on this
      // voucher's behalf — but IT pays that call's protocol fee and gas,
      // from ITS OWN public balance. This withdraw is what covers that:
      // a plain, wallet-native private->public action (same category as
      // shield), sending the owed amount plus a fee buffer to the relayer's
      // own address, so the relayer's cost is funded per-visitor instead of
      // paid out of pocket every time.
      setSettleStatus("Funding settlement…");
      const owedValue = owed * RATE;
      const fundAmount = owedValue + RELAYER_FEE_BUFFER;
      const { transaction_hash: fundTx } = await account.strk20InvokeTransaction([
        withdrawAction(fundAmount, PROVIDER_ADDRESS),
      ]);

      // Step 2 — wait for note maturity (~10 blocks) so the relayer's own
      // settlement can actually spend what this just funded.
      setSettleStatus("Waiting for note maturity (~10 blocks)…");
      const receipt = await rpcProvider.waitForTransaction(fundTx);
      const fundBlock = (receipt as { block_number?: number }).block_number ?? (await rpcProvider.getBlockNumber());
      await waitForBlock(fundBlock + 10, (head) => setSettleStatus(`Waiting for note maturity — block ${head}/${fundBlock + 10}…`));

      await submitRelaySettle();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setStage("chat");
    } finally {
      setBusy(false);
      setSettleStatus("");
    }
  }, [account, owed, terms, submitRelaySettle]);

  // See continueAfterShield above — same observed gap between Ready's own
  // UI and the promise it returns to this page.
  // Trusts that the funding step actually landed — Ready's own promise
  // hanging doesn't mean the withdraw failed, it has meant the opposite
  // every time this session (confirmed by checking the relayer's balance
  // directly). No transaction hash means no exact block to wait on, so
  // this waits a fixed, generous window instead of the precise ~10-block
  // poll the normal path uses, then attempts the same real settlement.
  const continueAfterSettle = useCallback(async () => {
    setBusy(true);
    setError("");
    try {
      const waitMs = 150_000; // ~150s: comfortably past 10 Sepolia/mainnet blocks
      const stepMs = 5_000;
      for (let elapsed = 0; elapsed < waitMs; elapsed += stepMs) {
        setSettleStatus(`Assuming funding landed — waiting for maturity (${Math.round((waitMs - elapsed) / 1000)}s)…`);
        await new Promise((r) => setTimeout(r, stepMs));
      }
      await submitRelaySettle();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setStage("chat");
    } finally {
      setBusy(false);
      setSettleStatus("");
    }
  }, [submitRelaySettle]);

  const [reserveTx, setReserveTx] = useState("");
  const fundRelayerReserve = useCallback(async () => {
    if (!account) return;
    setBusy(true);
    setError("");
    try {
      const { transaction_hash } = await account.strk20InvokeTransaction([fundRelayerReserveAction()]);
      setReserveTx(transaction_hash);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }, [account]);

  const checkBalance = useCallback(async () => {
    if (!account) return;
    setBusy(true);
    setError("");
    try {
      setShieldedBal(await shieldedBalance(account, STRK_ADDRESS));
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }, [account]);

  const withdrawRemaining = useCallback(async () => {
    if (!account) return;
    setBusy(true);
    setError("");
    try {
      // Always fetch fresh — don't withdraw against a balance read before
      // this session's own settle changed it.
      const bal = await shieldedBalance(account, STRK_ADDRESS);
      setShieldedBal(bal);
      if (bal <= 0n) {
        setError("nothing shielded to withdraw");
        return;
      }
      const { transaction_hash } = await account.strk20InvokeTransaction([withdrawAction(bal, account.address)]);
      setWithdrawTx(transaction_hash);
      setShieldedBal(0n);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }, [account]);

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
              through STRK20 on Starknet: one contract-enforced settlement, funded by you.
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
                    <p>Shield {formatStrk(ESCROW_AMOUNT)} STRK into your private balance — sized to cover a real settlement later, not a token amount. Your wallet may request a token approval first. Review the pool fee and gas charges before confirming.</p>
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
                        <button className="btn btn--ghost" type="button" onClick={() => void settle()} disabled={busy || owed <= 0n || stage === "settled"}>{stage === "settling" ? (settleStatus || "Settling…") : stage === "settled" ? "Settlement submitted" : "Settle now"}<span aria-hidden="true">↗</span></button>
                      </div>
                      <button className="text-link" type="button" onClick={() => void fundRelayerReserve()} disabled={busy}>
                        Top up relayer's reserve (one-time, {formatStrk(RELAYER_RESERVE_TOPUP)} STRK from your own shielded balance) →
                      </button>
                      {reserveTx && (
                        <p className="fine-print">
                          reserve funded: {reserveTx.startsWith("0x") ? <a href={`${explorer}/tx/${reserveTx}`} target="_blank" rel="noreferrer">{shorten(reserveTx)} ↗</a> : reserveTx}
                        </p>
                      )}
                      {stage === "settling" && settleStatus && !settleStuck && <p className="fine-print" role="status">{settleStatus}</p>}
                      {settleStuck && <button className="text-link continue-link" type="button" onClick={continueAfterSettle}>Already confirmed in my wallet — continue →</button>}
                      {error && <p className="err" role="alert">{error}</p>}
                      <p className="fine-print">Settle sends the relayer the owed amount plus its own fee, waits ~10 blocks for maturity, then the relayer submits the real anonymizer settlement — your unused shielded balance stays untouched throughout.</p>
                      {(depositTx || settleTx) && (
                        <div className="receipts" aria-label="Transactions">
                          {[["Deposit", depositTx], ["Settlement", settleTx], ["Withdrawal", withdrawTx]].filter(([, tx]) => tx).map(([label, tx]) => (
                            <p key={label}><span>{label}</span>{tx.startsWith("0x") ? <a href={`${explorer}/tx/${tx}`} target="_blank" rel="noreferrer">{shorten(tx)} ↗</a> : <span>{tx}</span>}</p>
                          ))}
                        </div>
                      )}
                      {stage === "settled" && (
                        <div className="settlement-controls">
                          <p>
                            {shieldedBal === null
                              ? "Any unused shielded balance stays private and yours — nothing else to do unless you want it back as ordinary public STRK."
                              : `Shielded balance: ${formatStrk(shieldedBal)} STRK.`}
                          </p>
                          {shieldedBal === null || shieldedBal > 0n ? (
                            <button className="btn btn--ghost" type="button" onClick={() => void checkBalance()} disabled={busy}>
                              Check shielded balance<span aria-hidden="true">↗</span>
                            </button>
                          ) : null}
                          {shieldedBal !== null && shieldedBal > 0n && (
                            <button className="btn btn--ghost" type="button" onClick={() => void withdrawRemaining()} disabled={busy}>
                              Withdraw to public balance<span aria-hidden="true">↗</span>
                            </button>
                          )}
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
                <p className="sidebar-note"><span aria-hidden="true">↳</span> Pool fees apply to shielding and settlement. Your wallet shows the current cost before you confirm.</p>
              </aside>
            </div>
          </div>
        </section>

        <section className="how-section wrap" id="how-it-works">
          <div className="section-heading"><div><p className="eyebrow">02 / The protocol</p><h2>Meter per call. Settle per batch.</h2></div><span className="section-caption">Less on-chain. More done.</span></div>
          <figure className="flow-diagram" aria-labelledby="flow-caption">
            <figcaption id="flow-caption"><span>Visitor console flow</span><span>You fund every step</span></figcaption>
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
                <div className="flow-stage-heading"><h3><span>03 /</span> Settle the total</h3><span className="flow-badge">Withdraw funds it · pool fee</span></div>
                <div className="flow-route flow-route--three">
                  <div className="flow-node"><span className="flow-node-label">You approve</span><h4>Your wallet</h4><p>Withdraw the owed amount plus a fee buffer to the relayer's address.</p></div>
                  <div className="flow-connector"><span>Funds the relayer</span><i aria-hidden="true">→</i></div>
                  <div className="flow-node flow-node--pool"><span className="flow-node-label">Our backend · via STRK20</span><h4>Relayer</h4><p>Verify your signed voucher, then call the anonymizer with what you just funded — not its own reserve.</p></div>
                  <div className="flow-connector"><span>On-chain enforcement</span><i aria-hidden="true">→</i></div>
                  <div className="flow-node"><span className="flow-node-label">MeteringAnonymizer</span><h4>Payout + remainder</h4><p>Pays the provider unsettled usage × rate. Credits the remainder back to your wallet.</p></div>
                </div>
                <p className="flow-note">
                  Ready can relay its own basic actions (shield, withdraw) but not a private
                  transaction invoking a third-party contract — so a relayer submits the real
                  settlement, funded by the withdraw above rather than its own money. Open-note
                  token and amounts are public on this path; identities stay hidden.
                </p>
              </li>
            </ol>
          </figure>
          <details className="contract-flow">
            <summary><span>Inside the anonymizer, step by step</span><span className="contract-flow__toggle" aria-hidden="true">+</span></summary>
            <div className="contract-flow__body">
              <p>Stage 03 above, expanded: the relayer submits your signed voucher with escrow funded by the withdraw you just approved. The contract checks the signature and agreed rate on-chain, then returns credits to the pool.</p>
              <div className="flow-route flow-route--three">
                <div className="flow-node"><span className="flow-node-label">Inputs</span><h4>Voucher + escrow</h4><p>Your signed usage total, and escrow funded by your own withdraw.</p></div>
                <div className="flow-connector"><span>Pool releases escrow</span><i aria-hidden="true">→</i></div>
                <div className="flow-node flow-node--pool"><span className="flow-node-label">MeteringAnonymizer</span><h4>Check and settle</h4><p>Verify signature and rate. Pay only the unsettled delta.</p></div>
                <div className="flow-connector"><span>Open-note credits</span><i aria-hidden="true">→</i></div>
                <div className="flow-node"><span className="flow-node-label">Back in the pool</span><h4>Payout + remainder</h4><p>Provider receives payment; your wallet receives what's left of the escrow.</p></div>
              </div>
              <p className="flow-note">Open-note token and amount are public in this contract path. <a href="https://github.com/ayush4345/strkret#what-the-mainnet-run-cost" target="_blank" rel="noreferrer">See the recorded mainnet run ↗</a></p>
            </div>
          </details>
          <div className="disclosure"><span className="eyebrow">Know what stays private</span><p>Deposits and withdraws are public, including your address and amount. The provider sees your prompts and vouchers directly. The relayer sees your voucher and wallet address. Contract open-note token and amounts are public; note owners are hidden. Nothing here hides your conversation from the provider.</p></div>
        </section>
      </main>
      <footer className="wrap site-footer"><a className="wordmark" href="#">strkret<span className="wordmark__dot">.</span></a><span>Confidential commerce for autonomous agents.</span><a className="text-link" href="https://github.com/ayush4345/strkret" target="_blank" rel="noreferrer">Open source ↗</a></footer>
    </>
  );
}
