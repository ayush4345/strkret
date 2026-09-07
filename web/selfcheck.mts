import assert from "node:assert/strict";
import { hash } from "starknet";
import { priceOf } from "@strkret/agent-core/voucher";
import { STRK_ADDRESS, PROVIDER_ADDRESS, ESCROW_AMOUNT, RELAYER_FEE_BUFFER, RATE, RATE_BLIND, UNITS_PER_BLOCK, buildTerms, formatStrk, shieldAction, settlementAction } from "./lib/protocol.ts";

// @starknet-io/types-js 0.10.3: both ADDRESS and action amounts use FELT.
const felt = /^0x(0|[a-fA-F1-9][a-fA-F0-9]{0,62})$/;
const deposit = shieldAction();
const transfer = settlementAction(12n);
assert.equal(deposit.type, "deposit");
assert.equal(transfer.type, "transfer");
for (const action of [deposit, transfer]) {
  assert.match(action.token, felt);
  assert.match(action.amount, felt);
  assert.equal(BigInt(action.token), BigInt(STRK_ADDRESS));
}
assert.equal(BigInt(deposit.amount), ESCROW_AMOUNT);
assert.equal(BigInt(transfer.amount), 1_200_000_000_000_000n);
assert.match(transfer.recipient, felt);
assert.equal(BigInt(transfer.recipient), BigInt(PROVIDER_ADDRESS));
const terms = buildTerms({ unitsPerBlock: UNITS_PER_BLOCK.toString(), charsPerBlock: 100 });
assert.equal(terms.rate, "100000000000000");
assert.equal(hash.computePoseidonHashOnElements([BigInt(terms.rate), RATE_BLIND]), terms.rateCommitment);
for (const [length, units] of [[0, 1n], [100, 1n], [101, 2n], [200, 2n], [201, 3n]] as const) {
  assert.equal(priceOf(terms, "x".repeat(length)), units);
  assert.equal(BigInt(settlementAction(units).amount), units * BigInt(terms.rate));
}
// Shield is sized to exactly cover the later funding withdraw, not a
// separate token amount — see the note on protocol.ts's ESCROW_AMOUNT.
assert.equal(ESCROW_AMOUNT, RELAYER_FEE_BUFFER);
assert.equal(formatStrk(RATE), "0.0001");
assert.equal(formatStrk(3n * BigInt(terms.rate)), "0.0003");
assert.equal(formatStrk(0n), "0");
assert.equal(formatStrk(1n), "0.000000000000000001");
assert.equal(formatStrk(100n * 10n ** 18n + 1n), "100.000000000000000001");
console.log("Pricing and wallet selfcheck passed (metering units, committed rate, exact STRK amounts, and FELT payloads).");
