# Strkret

**Confidential, metered pay-per-use commerce between autonomous agents**, settled
privately on Starknet via [STRK20](https://strk20.starknet.io).

A consumer agent buys metered calls from a provider agent — priced and served
independently by the provider — and pays for exactly what it used through the
STRK20 privacy pool. Metering happens per call and off-chain; settlement is
batched and shielded. Confidentiality is the pool's job; this project is the
metering and settlement logic on top of it, and the reason those two are
deliberately separated is the first thing worth explaining.

## The problem: pay-per-use and confidentiality pull against each other

Confidential settlement is not free. Every settlement is an `apply_actions`
call on the pool, and the pool charges a flat protocol fee for it —
**6 STRK on mainnet**, read straight off the deployed contract:

```
starknet_call → get_fee_amount() → 0x53444835ec580000 = 6 × 10^18
```

Flat, per call, regardless of how much value moves. Pay-per-use wants the
opposite: many small payments, one per API call. Put those together naively
and every API call costs 6 STRK to settle, which no per-call price can
absorb. **Shielded micropayments, done the obvious way, do not exist as a
product.**

So the question worth engineering is not "how do we pay privately per call",
it's:

> How do you keep per-call metering granularity while paying settlement cost
> only once?

## How Strkret answers it

By decoupling **metering** from **settlement**:

- **Metering is per-call, off-chain, and free.** After each call the consumer
  signs a voucher for its running cumulative total, and the provider keeps
  the highest one. Signing and verifying cost nothing and touch no chain, so
  the provider holds an enforceable claim for everything it has served — it
  is never serving on trust and hoping for a voucher at the end.
- **Settlement is batched, on-chain, and confidential.** One settlement
  covers a whole session, or fires when accrued value crosses a threshold.
  Because vouchers carry a cumulative total and the contract tracks a
  per-channel high-water mark, settling twice pays the delta, never the total
  twice.

The anonymizer contract is what makes that decoupling safe rather than merely
cheap: it verifies the consumer's signature and the rate commitment on-chain,
so the provider cannot inflate usage and the consumer cannot repudiate it.
Per-call accountability, per-session settlement cost.

The batching idea itself is old — payment channels and rollups amortise the
same way. What is specific here is the combination: **metering correctness
verified inside a shielded settlement**, so batching doesn't require trusting
either party.

The economics, stated plainly rather than hidden: at 6 STRK per settlement,
keeping the fee under 5% overhead needs ≥120 STRK moving per settlement, and
under 1% needs ≥600 STRK. The provider advertises a `minSettlementUnits` in
its terms for exactly this reason — below it, settling costs more than the
work is worth, and the consumer should know that before it starts spending
rather than discover it at settlement.

## What the mainnet run cost

Not a projection — this is the run recorded in `strk20.json`, measured from
the receipts:

| step | gas | pool fee | total |
| --- | ---: | ---: | ---: |
| provider register | 2.32 | 6.00 | 8.32 |
| consumer deposit | 2.44 | 6.00 | 8.44 |
| **12 metered calls** | **0** | **0** | **0** |
| anonymizer settle | 2.55 | 6.00 | 8.55 |
| | | | **25.31 STRK** |

The escrow moved was 1000 wei — about 1e-15 STRK. Economically nothing, and
that is the point: what costs money here is the fee, not the payment.

Read the middle row first. Twelve calls were served, priced and signed for
without a single transaction. Paying per call would have meant twelve
`apply_actions` at 6 STRK each — **72 STRK to move a rounding error**.
Instead the session cost three on-chain actions, and settling after 100 calls
would cost exactly the same three. The per-call settlement cost falls toward
zero while the payment stays shielded.

The number metered off-chain and the number settled on-chain are the same
number: 12 units metered, 12 units paid to the provider, 988 refunded to the
consumer out of the 1000 escrow. That equality is enforced by the contract,
not asserted here — it is visible in the transfers of the settle transaction.

Reproducing it, once `.env` points at mainnet (see "Running it for real"):

```bash
pnpm --filter @strkret/agent-consumer run demo:metered
```

The script is network-agnostic — it reads which chain it is on from the pool
address and adapts. Two things it does only on mainnet: it passes explicit
`resourceBounds` to skip the broken fee estimate, and it routes proving
through the Starkscan relay. Set `CHANNEL_ID` to a channel this consumer has
not settled before, since the high-water mark persists on-chain per
`(consumer, channel)`. `SKIP_PROVIDER_REGISTER=1` skips step 1 once the
provider has registered — registration is permanent per account, and
re-running it reverts, which on mainnet still costs gas and one of the day's
ten proofs.

## What's built

**Runs on mainnet.** Twelve metered calls served off-chain and settled once
through our own anonymizer contract, against the live STRK20 pool. Three
successful mainnet transactions, listed in `strk20.json`.

**The anonymizer contract** (`contracts/metering-anonymizer`) — 14/14 tests,
verified on devnet, Sepolia and mainnet. It verifies the consumer's
signature and the rate commitment on-chain, so a provider cannot inflate
usage and a consumer cannot repudiate it. A security review is documented in
that package's README, including the two findings it fixed: an unenforced
settlement amount, and a reentrancy path through the caller-supplied token.

**Settlement is batched.** `privacy_invoke` takes a span of provider claims,
so a consumer using M providers pays them in one settlement instead of M. At
6 STRK a settlement, that is the difference between 6 and 6M — and the only
lever available, since the fee itself is flat.

**Vouchers are incremental.** Each voucher carries a cumulative total and
the contract tracks a per-channel high-water mark, so settling twice pays
the delta rather than the total twice. Verified on Sepolia by reading
balances back from `discoverNotes()` between rounds rather than trusting the
run's own logs.

**The rate is enforced, not advertised.** The rate commitment lives inside
the signed message, so a voucher can only ever be settled at the rate its
consumer agreed to.

**No hosted indexer required.** Discovery runs off plain `starknet_call`s
against the pool and decrypts locally with the viewing key — which is what
makes mainnet possible at all, since no hosted indexer exists there.
Verified equivalent to the hosted indexer on Sepolia, where both exist.

**The provider sells real work** — an agent answering prompts with a model,
priced per request, rather than a string reverser standing in for one. The
payment gate is hardened: consumer pubkey pinning, channel resync after a
lost response, and a consumer-side ceiling so a provider cannot name a
figure and be signed for it. Both sides ship `selfcheck` scripts covering
the refusals.

**An x402-shaped handshake.** An unpaid call gets `402` plus `accepts`, and
every paid call carries a signed cumulative voucher. Deliberately not x402
proper — there is no per-request `X-PAYMENT` payload, because per-request
on-chain payment is exactly what the flat fee rules out.

## How deeply this uses STRK20

Not a wrapper around one helper call. The project touches the pool at four
levels, and implements two of the SDK's own interfaces rather than only
consuming them.

**Every pool operation.** `register` publishes a viewing key, `deposit`
shields the escrow, `withdraw` releases it to the anonymizer, and `transfer`
credits a provider directly on the simpler settlement path. All four run on
mainnet or Sepolia in the demos, not just in tests.

**Shielded balances, handled properly.** Notes, nullifiers and viewing keys
are the substrate the whole design sits on. Balances are read back by
decrypting notes with the viewing key — `discoverNotes()` — which is how the
incremental-voucher test verifies the high-water mark rather than trusting
its own logs. Note maturity is respected explicitly: proofs are generated
against `head − 10`, because proving against an immature note surfaces later
as a baffling "insufficient allowance" on a deposit that just approved.

**Our own anonymizer contract.** `MeteringAnonymizer` is Cairo we wrote,
declared and deployed to mainnet, and invoked by the pool through
`privacy_invoke`. It receives a span of provider claims, verifies each
consumer signature and rate commitment on-chain, pays
`(units − already_settled) × rate`, and returns funds to the pool as two
`OpenNoteDeposit`s — settlement to the provider, refund to the consumer.
This is the integration point the pool is designed to expose, and using it is
what makes batched settlement trustworthy rather than merely cheap.

**SDK interfaces implemented, not just called.** Two custom providers plug
into the SDK's own extension points:

- `StarkscanProverProvider` implements `ProofProviderInterface` against
  Starkscan's REST proving relay, because mainnet has no JSON-RPC prover.
  Job queue, polling with backoff, and L1→L2 message decoding.
- Discovery runs through `ContractDiscoveryProvider`, reading the pool over
  plain `starknet_call` and decrypting locally — so no hosted indexer is
  needed, which is the only reason a mainnet run is possible at all.

**Two settlement paths, with different privacy trade-offs**, both working:

| | plain `transfer` | via the anonymizer |
| --- | --- | --- |
| amounts | hidden | public |
| identities | hidden | hidden |
| correctness | trusted between the parties | enforced on-chain |

The anonymizer trades amount privacy for verifiable correctness — the
consumer's signature and the agreed rate are checked by the contract, so
neither side has to trust the other. Which one you want depends on whether
the counterparty is known.

Stealth accounts are the one STRK20 feature the design does not use: the
recipients here are pool notes credited by the contract, so there is nothing
for a stealth address to add.

## Why no bespoke ZK circuit

The obvious design is a custom circuit proving "settlement = usage × rate"
without revealing usage or rate. STRK20 already solves the harder half of
that generically — every private transfer through its pool hides sender,
recipient, token and amount behind a native STARK proof. Rebuilding that
would be reimplementing the pool badly.

So the confidentiality guarantee is STRK20's, not ours. What this project
adds is the cheap half: **STARK-curve signatures and a Poseidon rate
commitment**, which is ordinary applied cryptography rather than a circuit.
A voucher costs nothing to sign or verify, which is exactly why metering can
happen on every call while proving stays where it belongs — inside the
pool's own settlement, once per batch.

Worth being precise, since these are easy to conflate: the *shielding* is
zero-knowledge and comes from the pool. The *metering integrity* is
signatures and commitments, and is not zero-knowledge — a voucher reveals
the unit count to whoever holds it, which is only ever the two parties to
the channel.

## Anonymizer contract: `settlement` public, correctness enforced

A STRK20 anonymizer (`privacy_invoke`) contract lives at
[`contracts/metering-anonymizer`](contracts/metering-anonymizer) — **draft,
unreviewed**, deployed and verified end-to-end on Sepolia (see that
package's README for the review still needed before mainnet). It's an
alternative settlement path to
the plain `transfer()` above, not a replacement: it verifies the consumer's
signed usage voucher and the `rate_commitment` on-chain, computes
`settlement = (total_units − already_settled) × rate` itself — paying only
what this channel hasn't already settled — and splits the escrowed deposit
into `settlement -> provider` and `refund -> consumer` in one atomic call —
so the settlement amount is enforced on-chain rather than trusted, which a
bare `transfer()` doesn't give you.

The real tradeoff, worth stating precisely: `privacy_invoke`'s output lands
in a public-amount "open note" — structural, not a workaround. So this path
trades a **public settlement amount** for on-chain-enforced correctness,
while still hiding both parties' **identity**, since an open note hides its
owner. Plain `transfer()` hides the amount too, and is the better choice
whenever that enforcement isn't worth making the amount public.

Neither path needs a shadow account for the provider-gets-`owed`,
consumer-keeps-the-remainder split: `surplusTo(...)` on the `transfer()`
path and the two-`OpenNoteDeposit` return on the anonymizer path each give
that for free from primitives that exist for other reasons.

## How it fits together

The pieces, and which of them ever touches the chain:

```mermaid
flowchart TB
    subgraph CP["Consumer process"]
        RES["RemoteEchoService<br/>opens channel from 402,<br/>signs a voucher per call,<br/>resyncs within its own ceiling"]
        RUN["runSession<br/>approve → deposit → meter →<br/>settle on threshold or close"]
    end

    subgraph PP["Provider process"]
        SRV["server.ts — payment gate<br/>402 + accepts, verify signature,<br/>require claim grew ≥ price,<br/>optional pubkey pinning"]
        SVC["LlmService — answers prompts, priced per<br/>prompt block; EchoService offline stand-in"]
    end

    subgraph CORE["@strkret/agent-core"]
        VOU["voucher.ts<br/>sign / verify poseidon(channel, units)<br/>— identical to the Cairo side"]
        MET["MeteredSession<br/>accumulates what is owed"]
    end

    subgraph PCL["@strkret/privacy-client"]
        CLI["createPrivacyClient"]
        DISC["createPoolContract<br/>→ ContractDiscoveryProvider<br/>(no indexer needed)"]
        PROV["StarkscanProverProvider<br/>(mainnet proving relay)"]
    end

    POOL[("STRK20 Privacy Pool<br/>shielded notes, nullifiers,<br/>get_fee_amount()")]
    ANON["MeteringAnonymizer (Cairo)<br/>verifies voucher + rate commitment,<br/>pays (units − settled) × rate"]

    RES -->|"HTTP + X-STRK20-VOUCHER"| SRV
    SRV --> SVC
    RES -.uses.-> VOU
    SRV -.uses.-> VOU
    RUN --> MET
    RUN -->|"settle"| CLI
    CLI --> DISC
    CLI --> PROV
    DISC -->|"starknet_call, decrypt locally"| POOL
    CLI -->|"deposit / transfer / withdraw"| POOL
    POOL -->|"privacy_invoke"| ANON
    ANON -->|"OpenNoteDeposit x2"| POOL

    classDef chain fill:#2d3748,stroke:#4a5568,color:#fff
    class POOL,ANON chain
```

Everything above the pool line is free and off-chain. Only `runSession`'s
settle step and the one-time `register`/`deposit` cross into the shaded
boxes, and each crossing pays the flat protocol fee — which is why the
metering loop deliberately never does.

```mermaid
sequenceDiagram
    participant C as Consumer process
    participant P as Provider process (HTTP)
    participant Pool as STRK20 Privacy Pool
    participant Anon as Metering Anonymizer (optional)

    Note over P,Pool: on-chain, once ever
    P->>Pool: register() — publish viewing key

    Note over C,P: channel open — x402-shaped, no chain contact
    C->>P: POST /call (no voucher)
    P-->>C: 402 Payment Required + accepts{rate, channelId,<br/>rateCommitment, minSettlementUnits}

    Note over C,P: metering — per call, off-chain, free
    loop N calls
        C->>C: sign voucher(channelId, cumulative units, rateCommitment)
        C->>P: POST /call + X-STRK20-VOUCHER
        P->>P: verify sig, require claim grew by ≥ price
        P-->>C: { completion, cost, claimedUnits }
    end
    Note over P: holds an enforceable claim for everything served

    Note over C,Pool: settlement — batched, on-chain, confidential
    C->>Pool: approve + deposit(escrow)
    Note over C,Pool: wait 10 blocks — note maturity

    alt plain transfer — amount hidden too
        C->>Pool: transfer(owed since last settlement)
        Pool-->>P: encrypted note credited
        Note over C,Pool: amount, sender, recipient all hidden
    else anonymizer — correctness enforced on-chain
        C->>Pool: withdraw(escrow) → Anon
        Pool->>Anon: privacy_invoke(span of claims, one per provider)
        Anon->>Anon: per claim: check sig over the commitment,<br/>pay (units − settled) × rate
        Anon-->>Pool: OpenNoteDeposit × 2
        Pool-->>P: settlement to each provider (amounts public)
        Pool-->>C: refund (amount public)
        Note over Anon,Pool: identities still hidden — mark advances
    end

    Note over C,Pool: repeat settlement per threshold or at close —<br/>each costs the flat 6 STRK fee, so batch it
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
  off-chain), `voucher.ts` (signing and verification of cumulative usage
  vouchers, plus the `accepts` payment-requirements shape the 402 carries),
  and `runSession`: the register → approve → deposit → meter →
  wait-for-maturity → settle flow, generic over whatever `Service` and
  `PrivacyClient`s it's given. Pass `settlementThreshold` to settle
  mid-session once enough value has accrued instead of only at close.

  The voucher's signed message is `poseidon(channel_id, total_units)` —
  byte-identical to what the Cairo contract verifies. A mismatch there
  wouldn't fail at the HTTP boundary; it would fail on-chain at settlement,
  after the work was already served.
- **`agents/provider`** (`@strkret/agent-provider`) — what is actually being
  sold, plus the payment gate in front of it. `LlmService` answers prompts
  with a real model and prices per block of prompt characters;
  `EchoService` is the deterministic offline stand-in. The provider picks
  between them by whether `OPENAI_API_KEY` is set — the fallback is not a
  courtesy, since the devnet demos and both selfchecks have to run
  reproducibly without a paid key for anyone cloning this. `server.ts`: runs the
  provider as its own HTTP process with the payment gate in front of it. An
  unpaid `POST /call` gets `402` and the terms; a paid one must carry a
  voucher whose claim has grown by at least this call's price. The provider
  prices independently and never trusts a consumer-claimed cost.
  `pnpm --filter @strkret/agent-provider run selfcheck` asserts the gate
  refuses unpaid, forged, stale, cross-key and wrong-channel vouchers.
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

- `snforge test` must run **inside** `contracts/metering-anonymizer/`. It is a
  separate Scarb project pinning Scarb `2.18.0` in its own `.tool-versions`,
  so running it from the repo root picks up whatever Scarb is global and
  fails with "Scarb Version X doesn't satisfy minimal 2.13.1". That message
  reads as "upgrade Scarb", but the right version is already installed — it
  is just not active in the directory you are standing in.
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

## Running it in a browser

A mainnet console using your own privacy-enabled wallet. Set `OPENAI_API_KEY`
in the repo-root `.env` (and optionally `OPENAI_MODEL`), then run:

```bash
pnpm --filter @strkret/agent-core run build
pnpm --filter @strkret/agent-provider run build
pnpm --filter @strkret/web run dev   # http://localhost:3100
```

Connect Ready, shield funds, and ask a few questions. Each answer accrues a
signed usage claim without a chain transaction. **Settle now** is three
steps behind one button: your wallet withdraws the owed amount plus a fee
buffer to a relayer's own address (Ready can relay its own native actions,
just not a private transaction invoking a third-party contract itself), the
page waits out note maturity, then the relayer submits the real
`privacy_invoke` settlement — paid from what you just funded, not out of the
relayer's own pocket. The anonymizer's on-chain rate and signature checks
run for real here, the same mechanism the recorded mainnet run demonstrates,
not a separate path. The console runs its provider through Next.js API
routes; it does not need the devnet session server.

See [`web/README.md`](web/README.md) for Docker deployment and verification.

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
- `RPC_URL` — **on mainnet this is not interchangeable.** The node must do
  two things at once: accept writes, and hash the STRK20 proof extension
  into the transaction. A v3 transaction carrying a STRK20 proof commits to
  `poseidonHashMany(proofFacts)`, so a node computing a stock v3 hash
  derives a different hash and rejects a perfectly valid signature as
  `Account: invalid signature`. We lost six attempts to this before finding
  a node that does both:
  `https://mainnet.nodes.starknet.org/rpc/v0_10` (spec `0.10.3-rc.0`), which
  is what the recorded mainnet run used. Two dead ends worth naming so you
  don't repeat them: Starkscan's RPC serves reads and proofs but refuses
  `addInvokeTransaction` with `method_not_supported_in_pilot`, and a node on
  an older spec accepts the submission but rejects the signature. Note also
  that `estimateFee` still fails on this path — a starknet.js BigInt
  serialization bug, not the node — so mainnet calls pass explicit
  `resourceBounds`, which skips estimation. See `BOUNDS_MAINNET` in
  `demo-metered-run.ts`.
- `PROVING_SERVICE_URL` — a hosted prover. We have a working Sepolia one
  from the STRK20 team (not publicly documented; ask in their Telegram).
  For **mainnet** there is no JSON-RPC prover, but Starkscan runs a REST
  relay in front of one — set `starkscanProverApiKey` on the client instead
  and `provingServiceUrl` becomes the relay base URL. Their API is
  pilot-phase: 10 proofs/day per key, and it will not serve
  `deploy_account`.
- `INDEXER_URL` — **optional.** Left empty, discovery runs off plain
  `starknet_call`s against the pool and decrypts locally with the viewing
  key, so no hosted indexer is needed on any network. Verified equivalent to
  the hosted one on Sepolia, where both exist. Set it only if you have one
  and want to spare the RPC volume.
- `OPENAI_API_KEY` — **optional.** Set it and the provider sells real
  inference instead of echoing; leave it empty and everything still runs
  offline. `OPENAI_MODEL` defaults to `gpt-5.4-mini`. Note that the `gpt-5`
  family rejects `max_tokens` and requires `max_completion_tokens`, which
  fails at the first paid call rather than at startup.
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

## Testing on Sepolia

Sepolia is where everything is verified end to end against real infra — real
pool, real prover, real proofs — without spending mainnet money. Work
outward: the first two need no network at all, and each step proves
something the next one assumes.

**1. No network — logic and the payment gate**

```bash
pnpm -r build
(cd contracts/metering-anonymizer && snforge test)   # 14 tests — must run inside that dir
pnpm --filter @strkret/agent-provider run selfcheck  # gate refuses bad vouchers
pnpm --filter @strkret/agent-consumer run selfcheck  # consumer refuses to over-sign
```

The contract suite signs with real starknet.js vectors, so it proves the
Cairo and TypeScript sides agree on `poseidon(channel_id, total_units)` —
not merely that the Cairo compiles.

**2. Local devnet — the whole flow, no credentials**

```bash
asdf install starknet-devnet 0.8.2 && asdf set starknet-devnet 0.8.2
./scripts/build-devnet-artifacts.sh
pnpm --filter @strkret/agent-consumer run demo:devnet             # plain transfer
pnpm --filter @strkret/agent-consumer run demo:invoke-devnet      # anonymizer path
pnpm --filter @strkret/agent-consumer run demo:networked-devnet   # 402 + vouchers + threshold
```

The networked one is the interesting demo: two real OS processes, a 402
handshake, a signed voucher per call, and — with a threshold of 20 against
30 owed — **two** settlements rather than one.

**3. Sepolia — real infra**

Fill `.env` first (see above; `INDEXER_URL` can stay empty). Both accounts
need STRK for the deposit and the protocol fee, which is 2 STRK per
settlement on Sepolia — the code reads that from the pool rather than
assuming it.

```bash
pnpm --filter @strkret/agent-consumer run demo                    # plain transfer path
pnpm --filter @strkret/agent-consumer run demo:invoke-sepolia     # anonymizer, one settlement
pnpm --filter @strkret/agent-consumer run demo:incremental-sepolia # two settlements, delta only
pnpm --filter @strkret/agent-consumer run check:discovery         # indexer vs contract discovery
```

What each is actually evidence of:

| Command | Proves |
|---|---|
| `demo` | plain `transfer()` settlement works against the real pool |
| `demo:invoke-sepolia` | the contract computes and enforces the settlement on-chain |
| `demo:incremental-sepolia` | a second voucher on one channel pays the **delta**, not the total again |
| `check:discovery` | contract discovery finds exactly what the hosted indexer does |

`demo:incremental-sepolia` is the one worth reading the output of. It runs
two rounds on the same channel — cumulative 100 then 150 — and asserts the
provider is credited `+500` then `+250`, reading the balance back from
`discoverNotes()` between rounds rather than trusting its own logs. If the
high-water mark ever regressed, that second number would read `750`.

**Expect it to be slow.** Every settlement waits ~10 blocks for note
maturity, so a two-round run is 20–30 minutes of mostly waiting. That wait
is not incidental: skipping it is what surfaces as a baffling "insufficient
allowance" on a deposit that just approved.

**Reruns:** bump `CHANNEL_ID` in `demo-incremental-sepolia.ts`. The
high-water mark persists on-chain per `(consumer, channel)`, so a channel
already settled at 150 will reject a fresh run starting at 100 — correctly,
that is the replay guard doing its job.

## License

Apache-2.0 — see [LICENSE](LICENSE).
