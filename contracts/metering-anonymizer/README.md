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

## Deploying for real: one thing only the pool operator can grant

STRK20's screening rule: an `Invoke` target that funds open notes and
carries no policy becomes the transaction's screening subject, so the pool
demands a screening attestation naming the anonymizer itself — which
nothing here can produce. The devnet demo works around this by calling
`set_open_note_screening_policy(anonymizer, Exempt)` using **devnet's own
admin account**, which we don't have on Sepolia or mainnet. A real
deployment needs whoever holds `AppGovernor` on the target pool to grant
this exemption for this contract's address — that has to be requested from
the STRK20 team, the same channel as the prover/indexer ask.

## Sepolia

Declared and deployed, unreviewed, **not yet exempted from screening** (see
above — invoking it for real will fail until that's granted):

- Class hash: `0x661a6cd77f20de9c18dcc2c701ebacbcb255fc315841be58d13f473ea2b4574`
- Contract address: `0x01d50cb0d1fa94d5912b62b42d64e7ff3d49f517f7b137f3a05daf7641cc9c4f`

## Dependency pinning

`privacy = { git = "...", rev = "980da8affafb9f8350975ca93c03b2299a31ac9b" }`
— pinned to a specific commit of `starkware-libs/starknet-privacy` rather
than a branch, so a build today and a build next month resolve identically.
Re-verify this commit is still what's deployed before relying on it for
anything beyond local development.

## Build

Needs Scarb `2.18.0` (pinned in this directory's `.tool-versions`) and
Starknet Foundry `0.63.0` for `snforge test`.
