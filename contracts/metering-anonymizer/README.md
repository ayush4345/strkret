# metering-anonymizer

**DRAFT.** Reviewed in-repo (see Review status below); not independently audited.

A STRK20 anonymizer (`privacy_invoke`) contract that verifies a
consumer-signed usage voucher on-chain and splits an escrowed deposit into
`settlement -> provider` and `refund -> consumer` in one atomic private
transaction. It checks signed units and rate arithmetic. Settlement amounts,
token, rate, rate blind, unit count, channel, consumer public key and signature
are public in the submitted calldata and output. Open-note owners are
concealed, but the transaction sender and reused signing keys can identify or
link activity. See the root README's privacy comparison.

## Batched settlement

`privacy_invoke` takes a **span of claims**, one per provider being paid out
of the escrow, and returns one deposit per claim in claim order plus a
trailing refund only if a remainder exists. Each claim carries its own
voucher, rate commitment and signature. The signature does not bind the
provider note, refund note, token or deployment: the caller selects those,
so signature verification alone does not authorize recipient routing.

This is the point of the contract's shape, not a convenience. The pool
charged a flat protocol fee per settlement (6 STRK in the recorded mainnet
run), so at that fee a consumer using ten providers pays 60 STRK settling
them one at a time and 6
settling them together. The per-counterparty overhead falls as the batch
grows. Execution gas can still increase with the number of claims; read the
current pool fee before submitting.

Two things follow from batching that per-claim checks would miss, and both
are tested:

- **The escrow cap is checked against the batch total.** Claims that each fit
  individually can still exceed the escrow together.
- **The same cumulative voucher cannot be paid twice in one batch.** The
  high-water mark is written inside the loop, so the second entry sees the
  first as already settled and is rejected for not being strictly newer.
  A second, higher cumulative voucher for that channel pays only its delta.

## What it checks

Per claim in the batch:

1. `rate_commitment == poseidon(rate, rate_blind)` — the settlement uses the
   same rate committed to at channel-open. Both witnesses are public calldata.
2. The consumer's own STARK-curve signature over
   `poseidon(channel_id, total_units, rate_commitment)` — proof the consumer,
   not the provider, authorized paying for exactly `total_units` **at the
   committed rate**.

   The commitment is inside the signed message, and that is what makes the
   amount enforceable. Check 1 on its own is circular: `rate`, `rate_blind`
   and `rate_commitment` all arrive in the same calldata from the same
   caller, so it proves only that whoever built the transaction can hash two
   numbers it chose. Before the commitment was signed, whoever assembled the
   settlement picked the payout — a consumer could settle a 100-unit voucher
   at rate 1 instead of the agreed 5 and the contract would accept it, which
   defeated the contract's entire purpose. A provider must correspondingly
   refuse any voucher not signed over the commitment it published at channel
   open.
3. The voucher is strictly newer than this channel's high-water mark
   (`settled_units` map, keyed by `poseidon(consumer_pubkey, channel_id)`)
   — see below.
4. `settlement = (total_units - already_settled) * rate`, with the **sum**
   across the batch capped at `escrow_amount` (escrow measured from this
   contract's own token balance, never trusted as a calldata argument).

## Incremental vouchers and the high-water mark

`total_units` is **cumulative for the channel**, not per-settlement. That is
what lets vouchers be incremental: the consumer signs a fresh voucher for
the running total as metering proceeds, each superseding the last, so the
provider can verify the signed usage without a chain interaction. It still
needs funded settlement to be submitted: the voucher does not lock or debit
consumer funds. Settlement pays only units beyond the channel's prior mark.

This is what makes the economics work at all. The pool charges a flat
protocol fee per `apply_actions` call (6 STRK in the recorded mainnet run),
which overwhelms the demo's tiny per-call price. Metering stays off-chain;
only settlement
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

The mark is keyed by `poseidon(consumer_pubkey, channel_id)` rather than
`channel_id` alone. `channel_id` is caller-chosen and carries no identity,
so keying on it alone would let two consumers who happened to pick the same
value share a mark — the first to settle would cap or block the second,
who never agreed to share a channel. Binding it to the pubkey the
signature was just verified against isolates each consumer's channels to
that consumer.

## Review status

**Fixed.**

- *The settlement amount was not enforced.* The signature covered only
  `(channel_id, total_units)`, so the rate was unbound and whoever assembled
  the transaction chose the payout — a 100-unit voucher agreed at rate 5
  could be settled at rate 1. The commitment is now inside the signed
  message. `rejects_a_voucher_settled_at_a_different_rate` covers it.
- *Reentrancy through the caller-supplied token.* `token` comes from
  calldata and `balance_of` is called on it **before** any high-water mark is
  written, so a malicious token could reenter while every mark still read
  zero and replay the vouchers the outer call was settling. Guarded with
  OpenZeppelin's `ReentrancyGuardComponent`.
  `rejects_reentrancy_from_a_malicious_token` deploys a token that actually
  reenters, and fails when the guard is removed — it discriminates rather
  than passing vacuously.
- *Unexplained panic on the balance conversion.* `u256 -> u128` used a bare
  `unwrap()`; it now fails as `ESCROW_TOO_LARGE`. Not reachable for a real
  token, but a named error beats a silent one in a settlement path.

**Accepted, with reasons.**

- *Escrow is the contract's entire balance of `token`.* Anyone can send
  tokens here and they are swept into the next settlement's refund note.
  Measuring the balance is deliberate — the alternative is trusting a
  calldata argument for the escrow amount, which is worse. The contract is
  drained every call, so this is an accounting oddity for a donor rather
  than a loss for a settling party.
- *The pool's allowance is not reset.* Each call approves exactly
  `escrow_amount` and the pool pulls it within the same transaction, so a
  residue only exists if the pool under-pulls. Resetting afterwards is
  impossible — the pull happens after this function returns.

**Remaining limitations.** The entry point is permissionless and the caller
chooses the token and output note IDs. The signed message does not bind those
fields or the chain/deployment. The high-water mark also omits token and rate
commitment. These are trust and replay-domain limitations, not guarantees
covered by the 14 tests; the contract is not a complete payment channel.

- **The signature check is the highest-risk part.** A bug here lets anyone
  who can see a voucher (which the provider legitimately does, as part of
  normal metering) forge a settlement claim. Independently verify
  `check_ecdsa_signature` is being called with the right message hash and
  that there's no way to satisfy it without the consumer's real private key.
- The recorded mainnet settlement publishes the claim's rate, blind, unit
  count, channel, public key and signature in transaction calldata. A rate
  commitment does not hide its witnesses once they are submitted there.
- The high-water mark is keyed by `poseidon(consumer_pubkey, channel_id)`,
  not `channel_id` alone, so two consumers picking the same caller-chosen
  `channel_id` don't share a mark and can't cap or block each other.
  `channels_are_isolated_per_consumer` covers this with a second real
  signing key. Still worth confirming independently that the pubkey bound
  into the key is always the one the signature was verified against.
- Arithmetic: `(total_units - already_settled) * rate` relies on Cairo's
  default checked u128 multiplication (panics on overflow) — confirm this
  holds for the actual deployed Cairo/Scarb version, don't just trust this
  comment. The subtraction is guarded by the strict `>` check above.

## Testing

`snforge test` — 14 tests, including a happy-path case using a real
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
`pnpm --filter @strkret/agent-consumer run demo:invoke-sepolia`), using the
consumer's real account key rather than a test vector. Succeeded on the
first real attempt — tx
`0x3f3fec75f0e64e079788e08e7a365a1d631cd9863142d248faea597a13221e6`,
provider's note independently confirmed at exactly `500` (the on-chain
settlement) via `discoverNotes()`, not just this script's own say-so. That
run was against the original deployment; the script now points at the
current one (see Sepolia below), and the flow is unchanged, since a first
settlement's delta is its full total.

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
manual step. The recorded mainnet run used the Starkscan prover relay and
succeeded; that does not guarantee every prover configuration supplies the
required attestations.

## Mainnet

Declared, deployed, and invoked on Starknet mainnet. The settlement in
[`strk20.json`](../../strk20.json) succeeded and credited 12 wei and 988 wei
to the provider and refund open notes respectively from 1000 wei of escrow.
Its receipt and public claim calldata were rechecked on 2026-09-08.

- Class hash: `0x1c539d0bcb4a7fc16cb0d6bae06ec451fa7058c06c352d73cdd8014b1cc9d8f`
- Contract address: `0x050d3089d17b8552460a9e4b36f5ed95d991493f5f3efaf66d79769cd1840428`
- Declare tx: `0x664f9e8d7b4b26d3a85724bed5316747009f1aa4694307c15f24dfd4df51c9b`
- Deploy tx: `0x0715f3332988e540c5f4bd8b9041aa9155c922064c6df79cb561e89b197b3546`
- [Settlement tx](https://voyager.online/tx/0x23e848a8a12f2509fa056b8f2d6ea595af2177bcd9cd564012c117ac75b5f6c): 12 usage units at 1 wei per unit; gas 2.54768365902817728 STRK plus 6 STRK pool fee.
- Cost: 4.53 STRK, almost all of it the declare — the class is 75.9 KB of
  Sierra and posting it is what you pay for. Deploying an instance of an
  already-declared class is cheap.

The same code verified on Sepolia below. It is reviewed in-repo but **not
independently audited** (see Review status), and it computes settlement
amounts — worth weighing before it moves value that matters.

### Submitting mainnet transactions

Historical RPC observations from the deployment attempts:

- **Starkscan's RPC cannot submit declares or account deployments.** Both
  returned `method_not_supported_in_pilot`. The recorded privacy invokes used
  `https://mainnet.nodes.starknet.org/rpc/v0_10` for submission and Starkscan's
  separate REST service for proving; do not assume the proving relay's RPC
  accepts transaction submissions.
- **Lava rejects sncast's `pre_confirmed` block tag** even on its `/rpc/v0_10`
  path, which reports spec 0.10.2 — it still implements the older `pending`.
  The failure surfaces as `Invalid block id`, which does not point at the
  cause.
- `https://api.cartridge.gg/x/starknet/mainnet` accepts both and is what these
  deployments used.

One more worth knowing: sncast reserves a **max** resource bound, not the
estimated fee. A declare estimated at 4.51 STRK demanded a balance above
~10.11 STRK and then charged 4.53. Fund for the bound, not the estimate.

## Sepolia

Declared, deployed, and **invoked for real** — see above.

Current deployment — batched claims, per-channel high-water mark keyed by
`poseidon(consumer_pubkey, channel_id)`, and the rate commitment bound into
the signed voucher:

- Class hash: `0x4a874051b4e4af6067f3df232eb7174d08b020c0531c28eb1c45fce784b456b`
- Contract address: `0x04ca3501bfbc7c6efb292d26ca39f04d3914e61608ecee9aef84fab33312372b`
- Declare tx: `0x5f962ea3ce310e4a1939c7249f3bdda6fab130ee7e7052ffdb4da1579c4f6d4`
- Deploy tx: `0x03a02cb092d5c544a3d58610f6946f6e2c11effc35bf90b0112ad384d262317a`

**Incremental settlement verified on real Sepolia**
(`agents/consumer/src/demo-incremental-sepolia.ts`,
`pnpm --filter @strkret/agent-consumer run demo:incremental-sepolia`): two
settlements on the same `channel_id`, the second carrying a cumulative
voucher, with the provider's credited amount read back from
`discoverNotes()` between rounds rather than trusted from the script.

- Round 1, cumulative `100` against a mark of `0` — settle tx
  `0x496611eb368a474f7783ad03ac32246027ce2f5c0e4a0a37c4913ad2be0927f`,
  provider credited `+500`.
- Round 2, cumulative `150` against a mark of `100` — settle tx
  `0x6c4d2bfae82d13d86dbd055df067447290a6b13d37fd1e63fc6f85de7f94b7d`,
  provider credited `+250`, the 50-unit delta rather than the cumulative
  `750` a naive reading would pay.

Earlier deployments, kept for provenance:

- High-water mark keyed by `channel_id` alone (superseded — two consumers
  sharing a `channel_id` would have shared a mark). Class hash
  `0x4b431fe16b17b7bc74d9322917feefefc27fc0f81a9f599eff9cbc87134b261`,
  address `0x06623cb10adc1ddd5511e6e19ee466943f7d7ce18d1703ca1a3b809a61cbd7a4`.
  Same two-round behaviour verified on it: settle txs
  `0x6f49d1ac64c1b1eec6e51ba5d736d48366dff3ae836e78ca879b3c99107e284`
  (`+500`) and
  `0x21637073f597df1ec02b7bf171e7c5f85ae8ef59afbc1f36005cec364a20d32`
  (`+250`).
- Before the high-water mark, single-settlement only. Class hash
  `0x661a6cd77f20de9c18dcc2c701ebacbcb255fc315841be58d13f473ea2b4574`,
  address `0x01d50cb0d1fa94d5912b62b42d64e7ff3d49f517f7b137f3a05daf7641cc9c4f`,
  settle tx `0x3f3fec75f0e64e079788e08e7a365a1d631cd9863142d248faea597a13221e6`.

## Dependency pinning

`privacy = { git = "...", rev = "980da8affafb9f8350975ca93c03b2299a31ac9b" }`
— pinned to a specific commit of `starkware-libs/starknet-privacy` rather
than a branch, so a build today and a build next month resolve identically.
Re-verify this commit is still what's deployed before relying on it for
anything beyond local development.

## Build

Needs Scarb `2.18.0` (pinned in this directory's `.tool-versions`) and
Starknet Foundry `0.63.0` for `snforge test`.
