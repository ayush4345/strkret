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

## How it fits together

```
consumer agent                          provider agent
  MeteredSession.call() ×N  ─────────►  EchoService.price()/.handle()
        │  (off-chain, instant, no chain call per unit)
        ▼
  session.owed  ──────────────────────► one STRK20 private transfer
                                          (register → deposit → transfer)
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
  `EchoService`, the deterministic demo service. The provider prices
  independently and never trusts a consumer-claimed cost.
- **`agents/consumer`** (`@strkret/agent-consumer`) — `demo.ts` runs
  `runSession` against real infra (RPC, Sepolia or mainnet, a real prover +
  indexer) from the repo-root `.env`, and writes `strk20.json`.
  `demo-devnet.ts` runs the same flow against a disposable local Starknet
  devnet with the real privacy pool contract deployed — no external
  services, no `.env`. That's the fast dev loop; `demo.ts` is what actually
  counts for submission.

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
- `PROVING_SERVICE_URL` / `INDEXER_URL` — there's no publicly documented
  hosted prover/indexer for Sepolia or mainnet as of this writing. Either
  self-host the Docker images from `starkware-libs/starknet-privacy`, or ask
  in their Telegram (linked from the skill docs) for hosted endpoints.
  **This is the actual blocker on a real run right now**, not the code.
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
- [ ] Prover + indexer endpoint for Sepolia/mainnet (see above — the actual
      blocker on a real run)
- [ ] Mainnet pool/token addresses confirmed and filled into `.env`
- [ ] Real run producing the 3 mainnet transaction hashes in `strk20.json`
- [ ] Live demo URL + demo video
- [ ] x402-style networked handshake between two separate agent processes
      (this demo runs both sides in-process for now — see
      `packages/agent-core/src/session.ts`)

## License

Apache-2.0 — see [LICENSE](LICENSE).
