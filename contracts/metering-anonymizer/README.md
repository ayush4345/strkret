# metering-anonymizer

**DRAFT — unreviewed. Do not deploy to mainnet without a security review.**

A STRK20 anonymizer (`privacy_invoke`) contract that verifies a
consumer-signed usage voucher on-chain and splits an escrowed deposit into
`settlement -> provider` and `refund -> consumer` in one atomic private
transaction — restoring the "settlement amount is provably correct"
guarantee that a plain STRK20 `transfer()` doesn't give you, at the cost of
making the settlement amount (not the rate, not the unit count, not either
party's identity) public. See the root README's "Anonymizer contract:
settlement public, correctness enforced" section for the full reasoning.

## What it checks

1. `rate_commitment == poseidon(rate, rate_blind)` — the settlement uses the
   same rate committed to at channel-open, without revealing it.
2. The consumer's own STARK-curve signature over
   `poseidon(channel_id, total_units)` — proof the consumer, not the
   provider, authorized paying for exactly `total_units`.
3. The voucher is strictly newer than this channel's high-water mark
   (`settled_units` map, keyed by `channel_id`) — see below.
4. `settlement = (total_units - already_settled) * rate <= escrow_amount`
   (escrow measured from this contract's own token balance, never trusted
   as a calldata argument).

## Incremental vouchers and the high-water mark

`total_units` is **cumulative for the channel**, not per-settlement. That is
what lets vouchers be incremental: the consumer signs a fresh voucher for
the running total as metering proceeds, each superseding the last, so the
provider holds an enforceable claim for everything served so far without a
single chain interaction. Settlement then pays only the units beyond what
that channel has already settled.

This is what makes the economics work at all. The pool charges a flat
protocol fee per `apply_actions` call (6 STRK on mainnet, read live from
`get_fee_amount()`), so settling per API call is not viable at any sane
per-call price. Metering stays off-chain and per-call; only settlement
touches the chain, and it can then be batched or threshold-triggered.

The guard is a per-channel **high-water mark** rather than a set of spent
voucher hashes, and that distinction is load-bearing. A `used_vouchers` set
keyed by `poseidon(channel_id, total_units)` stops an *identical* voucher
being replayed, but incremental vouchers open a subtler hole: vouchers
`(ch, 100)` and `(ch, 150)` hash differently, so after settling at 150 the
older-but-still-validly-signed 100 voucher could be settled again against a
fresh escrow on the same channel. Requiring `total_units > settled_units`
subsumes plain replay and closes that hole, and the strict `>` is also what
keeps the settlement subtraction from underflowing.

## Security review needed before any deploy

- **The signature check is the highest-risk part.** A bug here lets anyone
  who can see a voucher (which the provider legitimately does, as part of
  normal metering) forge a settlement claim. Independently verify
  `check_ecdsa_signature` is being called with the right message hash and
  that there's no way to satisfy it without the consumer's real private key.
- Confirm calldata to `privacy_invoke` isn't itself published on-chain in a
  way that would leak `rate`/`rate_blind` even though they never appear in
  a public signal — this wasn't independently verified before writing this
  contract.
- Confirm the high-water mark's key (`channel_id` alone) can't collide
  across different consumers — two consumers picking the same `channel_id`
  would share a mark, letting one block or cap the other's settlements.
  `channel_id` is currently caller-chosen and unbound to any identity;
  binding it to the consumer's pubkey is the obvious hardening if this
  survives review.
- Arithmetic: `(total_units - already_settled) * rate` relies on Cairo's
  default checked u128 multiplication (panics on overflow) — confirm this
  holds for the actual deployed Cairo/Scarb version, don't just trust this
  comment. The subtraction is guarded by the strict `>` check above.

## Testing

`snforge test` — 7 tests, including a happy-path case using a real
STARK-curve signature generated with starknet.js (the same library the
production TS client uses) for `private_key = 0x1`, verified correctly by
the on-chain `check_ecdsa_signature` call. That's evidence the signing and
verification sides are compatible, not just that the Cairo compiles.

**Verified further, end-to-end, against a local devnet**
(`agents/consumer/src/demo-invoke-devnet.ts`,
`pnpm --filter @strkret/agent-consumer run demo:invoke-devnet`): deploys this
contract fresh, then runs the real STRK20 pool through register → deposit →
withdraw-to-helper → `privacy_invoke` → two `OpenNoteDeposit`s, and confirms
the provider actually receives exactly the on-chain-computed settlement.
Not a mock — the real pool contract source, invoking this contract for
real, with a signature the on-chain check actually verifies.

**Verified again on real Sepolia** (`agents/consumer/src/demo-invoke-sepolia.ts`,
`pnpm --filter @strkret/agent-consumer run demo:invoke-sepolia`), against
this deployment, using the consumer's real account key rather than a test
vector. Succeeded on the first real attempt — tx
`0x3f3fec75f0e64e079788e08e7a365a1d631cd9863142d248faea597a13221e6`,
provider's note independently confirmed at exactly `500` (the on-chain
settlement) via `discoverNotes()`, not just this script's own say-so.

## Open-note screening

The unexempted default (`OpenNoteScreeningPolicy::Required`, per
`privacy::objects`) doesn't mean "blocked until a pool operator manually
allowlists you" — it means "screened automatically via FPI on every proof,
same as any depositor." The SDK's proving-service client documents this
directly: every proof carries an optional attestation "for screened
deposits," attached transparently by the hosted prover, which calls FPI
itself. The Sepolia run above never needed a manual exemption because the
hosted prover (`transaction-prover.alpha-sepolia.sw-dev.io`, the one the
STRK20 team gave us) requested and attached that attestation on its own —
nothing in our code or the contract does anything screening-related. Our
address just wasn't flagged by whatever FPI actually checks.

That also explains why the **devnet** demo needs the manual
`set_open_note_screening_policy(..., Exempt)` call: devnet has no real FPI
to call, so nothing would pass screening there without it — that workaround
is for the test environment's sake, not evidence production needs the same
manual step. Still worth confirming this holds for whatever prover mainnet
ends up using, since "the hosted prover handles it" is a property of that
specific prover, not of the contract.

## Sepolia

Declared, deployed, and **invoked for real** — see above.

Current deployment (with the per-channel high-water mark):

- Class hash: `0x4b431fe16b17b7bc74d9322917feefefc27fc0f81a9f599eff9cbc87134b261`
- Contract address: `0x06623cb10adc1ddd5511e6e19ee466943f7d7ce18d1703ca1a3b809a61cbd7a4`
- Declare tx: `0xe9ae0991c00edb00ac05a65dbecb00f531dface573489d2f4c2e4187490192`
- Deploy tx: `0x02a90af57dfc6cf54778ac1028b90ed18ba316ca46df5ff22beaf7bb5ef5040a`

**Incremental settlement verified on real Sepolia**
(`agents/consumer/src/demo-incremental-sepolia.ts`,
`pnpm --filter @strkret/agent-consumer run demo:incremental-sepolia`): two
settlements on the same `channel_id`, the second carrying a cumulative
voucher, with the provider's credited amount read back from
`discoverNotes()` between rounds rather than trusted from the script.

- Round 1, cumulative `100` against a mark of `0` — settle tx
  `0x6f49d1ac64c1b1eec6e51ba5d736d48366dff3ae836e78ca879b3c99107e284`,
  provider credited `+500`.
- Round 2, cumulative `150` against a mark of `100` — settle tx
  `0x21637073f597df1ec02b7bf171e7c5f85ae8ef59afbc1f36005cec364a20d32`,
  provider credited `+250`, the 50-unit delta rather than the cumulative
  `750` a naive reading would pay.

Previous deployment, before the high-water mark (single-settlement only):

- Class hash: `0x661a6cd77f20de9c18dcc2c701ebacbcb255fc315841be58d13f473ea2b4574`
- Contract address: `0x01d50cb0d1fa94d5912b62b42d64e7ff3d49f517f7b137f3a05daf7641cc9c4f`
- Settle tx: `0x3f3fec75f0e64e079788e08e7a365a1d631cd9863142d248faea597a13221e6`

## Dependency pinning

`privacy = { git = "...", rev = "980da8affafb9f8350975ca93c03b2299a31ac9b" }`
— pinned to a specific commit of `starkware-libs/starknet-privacy` rather
than a branch, so a build today and a build next month resolve identically.
Re-verify this commit is still what's deployed before relying on it for
anything beyond local development.

## Build

Needs Scarb `2.18.0` (pinned in this directory's `.tool-versions`) and
Starknet Foundry `0.63.0` for `snforge test`.
