import { createPoolContract, type PrivacyClient } from "@strkret/privacy-client";
import { MeteredSession } from "./meter.js";
import type { Service } from "./service.js";

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export interface RunSessionOptions {
  tokenAddress: string;
  poolAddress: string;
  depositAmount: bigint;
  /** Devnet mines instantly; poll every 1s there instead of 15s against real infra. */
  maturityPollMs?: number;
  /**
   * Settle mid-session once this much value has accrued unsettled, instead
   * of only at the end. Each settlement is its own `apply_actions` call and
   * pays the pool's flat protocol fee (6 STRK on mainnet), so a threshold
   * below roughly ten times that fee spends more on settling than it moves.
   * Leave unset to settle exactly once, at session close.
   */
  settlementThreshold?: bigint;
  log?: (msg: string) => void;
  /**
   * Called on each block-wait poll. Real networks produce blocks on their
   * own; a devnet in "transaction"-triggered block mode never advances while
   * this loop just polls, so the devnet demo passes a hook that forces a new
   * (empty) block via devnet's `devnet_createBlock`.
   */
  onWaitTick?: () => Promise<void>;
}

export interface RunSessionResult {
  txHashes: string[];
  owed: bigint;
  calls: number;
  /**
   * How many settlement transfers this session made. One unless
   * `settlementThreshold` triggered mid-session settlements — worth
   * surfacing, since each one paid the pool's flat protocol fee.
   */
  settlements: number;
}

/**
 * Every `provingBlockId` is `currentBlock - 10` by design (note maturity +
 * reorg safety — see sdk__proving-config.md). That means ANY state change a
 * proof depends on — a fresh deposit note, but just as much a plain ERC-20
 * approve — needs ~10 blocks to fall inside that window before the next
 * proof can see it. Skipping this wait is what "Insufficient ERC20
 * allowance" on a deposit that just approved really means.
 */
async function waitForBlocks(
  client: PrivacyClient,
  blocks: number,
  pollMs: number,
  onTick: (() => Promise<void>) | undefined,
  log: (msg: string) => void,
  label: string,
): Promise<void> {
  const target = (await client.provider.getBlockNumber()) + blocks;
  log(`[${label}] waiting for block >= ${target}...`);
  while ((await client.provider.getBlockNumber()) < target) {
    await onTick?.();
    await sleep(pollMs);
  }
}

/** Registering an already-registered viewing key reverts — tolerate that on reruns. */
async function registerIfNeeded(label: string, client: PrivacyClient, log: (msg: string) => void): Promise<string | undefined> {
  try {
    const provingBlockId = await client.provingBlockId();
    const { callAndProof } = await client.transfers.build().register().execute({ provingBlockId });
    const hash = await client.submit(callAndProof);
    log(`[${label}] registered viewing key: ${hash}`);
    return hash;
  } catch (err) {
    log(`[${label}] register skipped (likely already registered): ${(err as Error).message}`);
    return undefined;
  }
}

// Every pool action — register included — can collect a protocol fee via an
// STRK transfer from the caller when the deployment has a non-zero fee
// configured (see interface.cairo: "Fee collection ... may revert with
// ERC20 errors ... when fee is non-zero"). That needs its own allowance,
// same mechanism as a deposit. Assumes the fee token is `opts.tokenAddress`
// — true for STRK, which is what this demo uses; a deployment charging fees
// in a different token than the one being shielded would need a second
// approval this doesn't do.
/**
 * What to approve per fee-charged call: the pool's own `get_fee_amount()`
 * plus half again as headroom.
 *
 * This used to be a hardcoded 3 STRK, sized against the 2 STRK Sepolia
 * charges. Mainnet charges 6, so that constant approved less than half of
 * what the pool pulls and every mainnet call would have reverted on
 * allowance — after the gas to get there had already been spent. The pool
 * publishes the number; read it rather than carry a guess that is only
 * right on one network.
 */
async function feeApprovalPerCall(
  client: PrivacyClient,
  poolAddress: string,
  log: (msg: string) => void,
): Promise<bigint> {
  const fee = BigInt(await createPoolContract(poolAddress, client.provider).get_fee_amount());
  const approval = fee + fee / 2n;
  log(`[session] pool charges ${fee} per apply_actions; approving ${approval} per call`);
  return approval;
}

async function approveAndWait(
  client: PrivacyClient,
  tokenAddress: string,
  poolAddress: string,
  amount: bigint,
  pollMs: number,
  onWaitTick: (() => Promise<void>) | undefined,
  log: (msg: string) => void,
  label: string,
): Promise<void> {
  const approveTx = await client.account.execute(
    { contractAddress: tokenAddress, entrypoint: "approve", calldata: [poolAddress, amount.toString(), "0"] },
    { tip: 0n },
  );
  await client.provider.waitForTransaction(approveTx.transaction_hash);
  log(`[${label}] approved pool for ${amount}: ${approveTx.transaction_hash}`);
  await waitForBlocks(client, 10, pollMs, onWaitTick, log, label);
}

/**
 * The full metering + settlement flow: register the provider, shield the
 * consumer's deposit, meter a batch of requests against `service` off-chain,
 * wait out note maturity, settle with one private transfer. Shared between
 * the real-infra demo and the local-devnet demo in `@strkret/agent-consumer`
 * — only how the two `PrivacyClient`s are constructed differs.
 */
export async function runSession<Req, Res>(
  consumer: PrivacyClient,
  provider: PrivacyClient,
  service: Service<Req, Res>,
  requests: Req[],
  opts: RunSessionOptions,
): Promise<RunSessionResult> {
  const log = opts.log ?? console.log;
  const txHashes: string[] = [];
  const pollMs = opts.maturityPollMs ?? 15_000;

  const feePerCall = await feeApprovalPerCall(consumer, opts.poolAddress, log);

  // Provider has no deposit of its own — approve just the fee buffer.
  await approveAndWait(provider, opts.tokenAddress, opts.poolAddress, feePerCall, pollMs, opts.onWaitTick, log, "provider");
  const providerRegisterTx = await registerIfNeeded("provider", provider, log);
  if (providerRegisterTx) txHashes.push(providerRegisterTx);

  // --- Deposit: shield tokens into the pool, bundling the consumer's own
  // registration into the same build if it isn't registered yet. Each
  // fee-charged call (the deposit, then every settlement) needs its own fee
  // allowance, approved up front so no settlement has to run its own
  // approve-and-wait-10-blocks cycle mid-session. With a threshold set there
  // can be several settlements, so size the allowance for the worst case the
  // requests could produce rather than the single settlement of the default.
  const expectedOwed = requests.reduce((sum, req) => sum + service.price(req), 0n);
  const maxSettlements = opts.settlementThreshold
    ? expectedOwed / opts.settlementThreshold + 1n
    : 1n;
  await approveAndWait(
    consumer,
    opts.tokenAddress,
    opts.poolAddress,
    opts.depositAmount + (1n + maxSettlements) * feePerCall,
    pollMs,
    opts.onWaitTick,
    log,
    "consumer",
  );

  const depositBlockId = await consumer.provingBlockId();
  const depositBuild = await consumer.transfers
    .build({ autoRegister: true, autoSetup: true })
    .with(opts.tokenAddress, (t) => t.deposit({ amount: opts.depositAmount }))
    .surplusTo(consumer.account.address)
    .execute({ provingBlockId: depositBlockId });
  const depositHash = await consumer.submit(depositBuild.callAndProof);
  log(`[consumer] deposited ${opts.depositAmount} into the pool: ${depositHash}`);
  txHashes.push(depositHash);

  // --- Settle: one private transfer for the given amount. Amount, sender
  // and recipient stay inside the pool — nothing but the earlier deposit and
  // this note's existence is public. A freshly created note matures 10
  // blocks after creation, so wait that out first: on the first settlement
  // that is the deposit note, and on any later one it is the change note the
  // previous settlement left behind. ---
  let settled = 0n;
  let settlements = 0;
  const settle = async (amount: bigint): Promise<void> => {
    await waitForBlocks(consumer, 10, pollMs, opts.onWaitTick, log, "consumer");
    const settleBlockId = await consumer.provingBlockId();
    const settleBuild = await consumer.transfers
      .build({ autoSetup: true, autoSelectNotes: "naive", autoDiscover: { notes: "refresh" } })
      .surplusTo(consumer.account.address)
      .with(opts.tokenAddress, (t) => t.transfer({ recipient: provider.account.address, amount }))
      .execute({ provingBlockId: settleBlockId });
    const settleHash = await consumer.submit(settleBuild.callAndProof);
    settled += amount;
    settlements += 1;
    log(`[consumer] settled ${amount} to provider privately: ${settleHash}`);
    txHashes.push(settleHash);
  };

  // --- Meter a session against the provider's service. Off-chain, instant —
  // no chain call per unit; only settlement touches the pool. ---
  const session = new MeteredSession(service);
  for (const req of requests) {
    const { result, cost } = await session.call(req);
    const answer = (result as { completion?: string }).completion;
    log(
      `[session] ${service.name} served a call (cost ${cost})` +
        (answer ? `: ${answer.replace(/\s+/g, " ").slice(0, 120)}` : ""),
    );
    if (opts.settlementThreshold && session.owed - settled >= opts.settlementThreshold) {
      log(`[session] ${session.owed - settled} unsettled >= threshold ${opts.settlementThreshold}`);
      await settle(session.owed - settled);
    }
  }
  log(`[session] ${session.calls} calls served, ${session.owed} owed`);

  const outstanding = session.owed - settled;
  if (outstanding > 0n) await settle(outstanding);

  return { txHashes, owed: session.owed, calls: session.calls, settlements };
}
