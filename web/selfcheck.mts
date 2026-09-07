import assert from "node:assert/strict";
import { STRK_ADDRESS, PROVIDER_ADDRESS, ESCROW_AMOUNT, shieldAction, settlementAction } from "./lib/protocol.ts";

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
assert.equal(BigInt(transfer.amount), 12n);
assert.match(transfer.recipient, felt);
assert.equal(BigInt(transfer.recipient), BigInt(PROVIDER_ADDRESS));
console.log("Wallet action selfcheck passed (deposit + private transfer).");
