# Strkret

**Confidential, metered pay-per-use commerce between autonomous agents**, settled
privately on Starknet via [STRK20](https://strk20.starknet.io).

A consumer agent buys metered calls from a provider agent — priced and served
independently by the provider — and at the end of a session pays for exactly
what it used in a single **private transfer** through the STRK20 privacy
pool. The amount, the sender, and the recipient never appear on-chain: only
the pool's shielded notes do. Confidentiality is the pool's job; this project
is the metering and settlement logic sitting on top of it.

## Why a private transfer, not a private *proof*

The obvious design is a custom circuit that proves "settlement = usage ×
rate" without revealing usage or rate. STRK20 already solves the harder half
of that problem generically — every private transfer through its pool hides
sender, recipient, token, and amount behind a native STARK proof. So the
metering layer here doesn't need cryptography of its own: the provider prices
each call, accumulates what's owed over a session, and the consumer settles
the total with one ordinary-looking `transfer()` call into the pool. The
confidentiality guarantee comes from STRK20, not from a bespoke circuit.

## Anonymizer contract: `settlement` public, correctness enforced

A STRK20 anonymizer (`privacy_invoke`) contract lives at
[`contracts/metering-anonymizer`](contracts/metering-anonymizer) — **draft,
unreviewed**, deployed and verified end-to-end on Sepolia (see that
package's README for the review still needed before mainnet). It's an
alternative settlement path to
the plain `transfer()` above, not a replacement: it verifies the consumer's
signed usage voucher and the `rate_commitment` on-chain, computes
`settlement = total_units × rate` itself, and splits the escrowed deposit
into `settlement -> provider` and `refund -> consumer` in one atomic call —
restoring the on-chain-enforced correctness the original circuit-based
design had, which a bare `transfer()` doesn't give you.

The real tradeoff, worth stating precisely: `privacy_invoke`'s output lands
in a public-amount "open note" — structural, not a workaround. So this path
makes the **settlement amount** public to get that enforcement (matching
the original Stellar design's privacy level on amount), while still hiding
consumer/provider **identity** better than that original design did (it
published depositor/provider addresses as public signals; open notes hide
the owner). Plain `transfer()` above still hides the settlement amount too
and is the better choice when correctness-enforcement isn't worth that.

We didn't need a shadow account for the provider-gets-`owed`,
depositor-keeps-the-remainder split, either way — `surplusTo(...)` (plain
`transfer()` path) and the two-`OpenNoteDeposit` return (anonymizer path)
both give that for free from primitives that already exist for other
reasons.

## How it fits together

```mermaid
sequenceDiagram
    participant C as Consumer process
    participant P as Provider process (HTTP :4021)
    participant Pool as STRK20 Privacy Pool
    participant Anon as Metering Anonymizer (optional)

    Note over P,Pool: on-chain, once ever
    P->>Pool: register() — publish viewing key

    Note over C,P: off-chain metering — real HTTP, two separate OS processes
    C->>P: GET /terms
    P-->>C: { rate }
    loop N calls
        C->>P: POST /call { prompt }
        P-->>C: { completion, cost }
    end
    Note over C: owed = Σ cost

    Note over C,Pool: on-chain settlement
    C->>Pool: approve + deposit(escrowAmount)
    Note over C,Pool: wait 10 blocks — note maturity

    alt plain transfer — default, full privacy
        C->>Pool: transfer(owed)
        Pool-->>P: encrypted note credited
        Note over C,P,Pool: amount, sender, recipient all hidden — only a nullifier appears
    else anonymizer contract — on-chain enforced correctness
        C->>Pool: withdraw(escrowAmount) → Anon
        Pool->>Anon: privacy_invoke(voucher, signature, rate_commitment)
        Anon-->>Pool: OpenNoteDeposit × 2
        Pool-->>P: settlement (amount now public)
        Pool-->>C: refund (amount now public)
        Note over Anon,Pool: identity still hidden — only the amount is public
    end
```

A pnpm workspace, TypeScript project references throughout:

- **`packages/privacy-client`** (`@strkret/privacy-client`) — thin wrapper
  around `@starkware-libs/starknet-privacy-sdk`'s `createPrivateTransfers`:
  builds an `Account`, wires the viewing-key/proving/discovery providers, and
  exposes the register → deposit → transfer submission tail every operation
  shares (back off `provingBlockId`, spread proof details only when present,
  `tip: 0n`, wait for inclusion).
- **`packages/agent-core`** (`@strkret/agent-core`) — the priced
  `Service<Req, Res>` interface, `MeteredSession` (accumulates what's owed,
  off-chain, no signatures or vouchers needed since STRK20's own transfer
  confidentiality covers that), and `runSession`: the actual register →
  approve → deposit → meter → wait-for-maturity → settle flow, generic over
  whatever `Service` and `PrivacyClient`s it's given.
- **`agents/provider`** (`@strkret/agent-provider`) — owns the concrete
  `EchoService`, the deterministic demo service, and `server.ts`: runs the
  provider as its own HTTP process (`GET /terms`, `POST /call`). The
  provider prices independently and never trusts a consumer-claimed cost.
- **`agents/consumer`** (`@strkret/agent-consumer`) — `demo.ts` runs
  `runSession` against real infra (RPC, Sepolia or mainnet, a real prover +
  indexer) from the repo-root `.env`, and writes `strk20.json`.
  `demo-devnet.ts` runs the same flow against a disposable local Starknet
  devnet — no external services, no `.env`. `demo-networked-devnet.ts` is
  the same again, except the provider is a genuinely separate OS process
  (`remote-echo-service.ts` talks to it over real HTTP instead of calling
  `EchoService` in-process) — spawned automatically so it's still one
  command, but it's two real processes underneath, not two classes in one.
  `demo.ts` / `demo-devnet.ts` are what actually count for submission;
  the others are dev loops and architecture demonstrations.

## Running it against a local devnet (no credentials needed)

```bash
pnpm install
asdf install starknet-devnet 0.8.2 && asdf set starknet-devnet 0.8.2  # pinned in .tool-versions
./scripts/build-devnet-artifacts.sh   # see the script for why this is needed
pnpm -r build
pnpm --filter @strkret/agent-consumer run demo:devnet
```

Verified working end-to-end: register → deposit → meter 3 calls → wait out
note maturity → settle with one private transfer, all against the real
Cairo privacy-pool contract, locally. Three infra issues surfaced doing this
and are worth knowing about if you hit them again after a dependency bump:

- The SDK pins `starknet.js` at `10.5.0`; letting npm resolve a different
  top-level `starknet` version installs two copies with incompatible types.
  Keep `package.json`'s `starknet` version exactly matching whatever
  `node_modules/@starkware-libs/starknet-privacy-sdk`'s own dependency says.
- `starknet-devnet 0.7.2` (the SDK's own declared dependency range) doesn't
  support the `--proof-mode` flag the SDK passes; `0.9.2` supports the flag
  but rejects the SDK's proof-fact format as an unsupported protocol
  version. `0.8.2` is the version that actually works with
  `starknet-privacy-sdk@0.14.3-rc.5` — not documented anywhere, found by
  bisecting.
- The documented `POST /create_block` REST endpoint 404s on this devnet
  build; the `devnet_createBlock` JSON-RPC method (undocumented, found by
  trial) does the same thing and actually works — see the `onWaitTick` hook
  in `demo-devnet.ts`.

**Networked variant** — same on-chain flow, but the provider runs as its
own process and the consumer talks to it over real HTTP:

```bash
pnpm --filter @strkret/agent-consumer run demo:networked-devnet
```

This spawns `agent-provider`'s `serve` script as a child process (so it's
still one command, and a judge doesn't need two terminals to see it work),
waits for `GET /terms` to respond, then runs the consumer against it
exactly like `demo:devnet` — except every metered call is a real
`POST /call` over `localhost`, not an in-process method call. Two real OS
processes, real HTTP between them; the script just starts both for you.

## Running it for real (Sepolia or mainnet)

```bash
cp .env.example .env   # fill in RPC, pool/token addresses, both accounts' keys
pnpm --filter @strkret/agent-consumer run demo
```

**Before filling in `.env`:**

- `POOL_ADDRESS` / `TOKEN_ADDRESS` — confirm the current pool address for
  the network you're targeting, and a supported token, from
  [strk20-by-example.org](https://strk20-by-example.org) first. Don't guess
  these; a wrong pool address fails silently in confusing ways. Mainnet pool:
  `0x040337b1af3c663e86e333bab5a4b28da8d4652a15a69beee2b677776ffe812a`.
- `PROVING_SERVICE_URL` / `INDEXER_URL` — we have working Sepolia values for
  these (from the STRK20 team directly, not publicly documented — ask in
  their Telegram, linked from the skill docs, if you need your own). **The
  same ask for mainnet is still pending** and is the actual blocker on a
  real mainnet run right now, not the code — both settlement paths already
  ran successfully on Sepolia with these (see `demo-invoke-sepolia.ts` and
  its real tx hash in `contracts/metering-anonymizer/README.md`; the plain
  `transfer()` path via `demo.ts` was verified the same way). Self-hosting
  the Docker images from `starkware-libs/starknet-privacy` is the fallback
  if you don't have either.
- `CONSUMER_VIEWING_KEY` / `PROVIDER_VIEWING_KEY` — must be a decimal
  `BigInt` string, not hex. A hex string compiles fine but derives the wrong
  channel keys, and notes sent to that account never decrypt.
- The SDK needs **Node ≥ 24** and currently isn't on npmjs — install it from
  GitHub Packages:
  ```bash
  gh auth refresh -h github.com -s read:packages
  npm config set @starkware-libs:registry https://npm.pkg.github.com
  npm config set '//npm.pkg.github.com/:_authToken' "$(gh auth token)"
  ```

## Status

- [x] Metering + settlement logic against the Privacy SDK
- [x] Verified end-to-end against a local devnet (real pool contract, real
      register/deposit/transfer, real proofs)
- [x] Verified end-to-end on real Sepolia — both settlement paths: plain
      `transfer()` (`demo.ts`) and the anonymizer contract
      (`demo-invoke-sepolia.ts`)
- [x] Anonymizer contract (`contracts/metering-anonymizer`) — draft, 7/7
      tests pass, verified on devnet and Sepolia; still needs a security
      review before mainnet (see that package's README)
- [x] Incremental vouchers with a per-channel high-water mark, so a
      provider holds a running off-chain claim and settlement pays only the
      delta — verified on Sepolia (`demo-incremental-sepolia.ts`). The pool
      charges a flat ~6 STRK per `apply_actions` on mainnet, so per-call
      on-chain payment isn't viable; metering stays off-chain, settlement
      batches.
- [x] Two separate OS processes talking over real HTTP for the off-chain
      metering loop (`demo-networked-devnet.ts`) — not the x402 protocol
      specifically (no `402`/`X-PAYMENT` handshake), but genuinely two
      processes, not two classes in one
- [x] Mainnet prover — Starkscan's STRK20 prover relay, via the adapter in
      `packages/privacy-client/src/starkscan-prover.ts` (their API is
      pilot-phase: 10 proofs/day per key, and `deploy_account` isn't
      served by their RPC)
- [ ] Mainnet indexer/discovery endpoint — Starkscan doesn't offer one;
      still an open ask with the STRK20 team, and the remaining blocker on
      a full mainnet deposit → settle run
- [ ] Mainnet pool/token addresses confirmed and filled into `.env`
- [ ] Real run producing the 3 mainnet transaction hashes in `strk20.json`
- [ ] Live demo URL + demo video

## License

Apache-2.0 — see [LICENSE](LICENSE).
