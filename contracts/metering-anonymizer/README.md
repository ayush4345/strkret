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
3. The signed voucher hasn't been used before (`used_vouchers` map, keyed by
   the message hash) — replay protection, since this contract is otherwise
   stateless.
4. `settlement = total_units * rate <= escrow_amount` (escrow measured from
   this contract's own token balance, never trusted as a calldata argument).

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
- Confirm the replay guard's key (the signed message hash) can't collide
  across different consumers or channels in a way that blocks a legitimate
  second voucher.
- Arithmetic: `total_units * rate` relies on Cairo's default checked u128
  multiplication (panics on overflow) — confirm this holds for the actual
  deployed Cairo/Scarb version, don't just trust this comment.

## Testing

`snforge test` — 5 tests, including a happy-path case using a real
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
