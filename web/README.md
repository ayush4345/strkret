# @strkret/web

A mainnet visitor console: connect a privacy-enabled Starknet wallet, shield
funds, buy metered inference, and pay the accrued amount in one private transfer.

## Run locally

After installing the workspace dependencies, set `OPENAI_API_KEY` in the
repo-root `.env`. `OPENAI_MODEL` is optional. The console requires a working
inference key; it does not fall back to an echo service.

```bash
pnpm --filter @strkret/agent-core run build
pnpm --filter @strkret/agent-provider run build
pnpm --filter @strkret/web run dev
```

Open http://localhost:3100. Next.js serves both the UI and the provider's API
routes; the standalone devnet session server is not needed.

## Wallet flow

1. Connect Ready with STRK20 support (Wallet API >= 0.10.3).
2. Choose **Shield funds** — deposits `RELAYER_FEE_BUFFER` worth of STRK
   (currently 10 STRK on mainnet, 6 on Sepolia; see "Whose money actually
   moves" below for why it's sized that way, not the token amount an
   earlier version of this console used). Review the token approval, if
   needed, followed by the deposit. The deposit reveals your address and
   amount publicly.
3. Ask a few prompts. Each request carries a signed cumulative usage voucher.
   Watch accrued units and calls served increase without transactions.
4. Choose **Settle now**. This is three steps behind one button:
   a. Your wallet withdraws the owed amount plus the fee buffer to the
      relayer's own address — a private-to-public withdraw, one of Ready's
      basic native actions.
   b. The page waits for that withdraw's notes to mature (~10 blocks),
      polling the chain directly rather than trusting the wallet's own
      promise to resolve in step with its UI (it has not, reliably).
   c. The relayer — a separate backend account, not your wallet — submits
      the real `privacy_invoke` settlement, paid from what you just funded.
      Follow the explorer link once it returns; a transaction hash means
      submitted.

If step (a)'s wallet prompt appears to hang with no popup and no error,
Ready may have completed it anyway without telling this page — a "continue"
option appears after a few seconds that waits out maturity on a fixed timer
and proceeds regardless, rather than leaving you stuck.

## Whose money actually moves

Ready can relay its own native STRK20 actions (deposit, withdraw, transfer)
but not a private transaction invoking a third-party contract — confirmed
directly by the STRK20 team. The anonymizer's `privacy_invoke` is exactly
that kind of call, so a **relayer** (a separate backend account holding its
own small pre-shielded reserve) submits it on your behalf.

That relayer is infrastructure, not a subsidy. **You fund your own
settlement.** The withdraw in step 4a sends the relayer real STRK — the
owed amount plus a fee buffer — and the relayer spends that, not its own
money, to pay the pool's protocol fee and gas. The only thing the relayer
contributes from its own funds is a small, mostly-refunded escrow buffer
(one usage unit's worth, a fraction of a cent) required by how
`privacy_invoke` works technically, not a real cost.

One honest gap: the fee buffer is a flat, conservative estimate, not
metered to what the relayer actually spends. You pay the full buffer
regardless of the relayer's real cost, and any surplus is not refunded —
it accumulates in the relayer's own balance rather than coming back to you.
That's a simplification, not the intended end state. The real fix is
**batching**: the contract already accepts a `Span<ProviderClaim>`, so a
relayer holding several visitors' claims could settle them all in one
`privacy_invoke` and split one protocol fee across many visitors instead of
each paying a full buffer — the same amortization argument this whole
project makes about metering, applied to the relayer itself. Not built yet;
this console settles one visitor at a time.

Each started block of 100 prompt characters adds one usage unit, priced at
**0.0001 STRK**. Three short prompts accrue three units worth **0.0003
STRK**, before fees. Both `/api/terms` and the 402 response publish
`rate: "100000000000000"` (raw STRK units per usage unit);
`pricing.unitsPerBlock` controls the separate metering count. The UI
displays the rate and accrued value in STRK.

Settlement is contract-enforced, not a plain transfer: the anonymizer
verifies your voucher's signature and rate commitment on-chain before
paying anyone, the same mechanism the mainnet run recorded in `strk20.json`
demonstrates. Private transfers and withdraws hide amount and parties
on-chain; the provider still sees your prompts and vouchers directly, since
metering happens over plain HTTP.

## Verify and build

The selfcheck uses Node 24+ and verifies metering boundaries, advertised rate
against its commitment, exact STRK formatting, settlement amounts, and Wallet
API FELT encoding, including addresses.

```bash
pnpm --filter @strkret/web run selfcheck
pnpm --filter @strkret/web exec tsc --noEmit
pnpm --filter @strkret/web run build
```

These checks do not replace a real Ready wallet test.

## Docker deployment

Build from the repository root. Set `GH_PACKAGES_TOKEN` in your shell to a
GitHub Packages token with `read:packages`; BuildKit mounts it as a secret.
It is not a build argument and is not stored in the image.

```bash
docker build --secret id=gh_packages_token,env=GH_PACKAGES_TOKEN -t strkret:submission .
```

Set `OPENAI_API_KEY` and optionally `OPENAI_MODEL` in your shell, then:

```bash
docker run --rm -p 3100:3100 --env OPENAI_API_KEY --env OPENAI_MODEL strkret:submission
```

For a hosted container, provide those inference variables as runtime secrets
and expose the server's `PORT` (default 3100). The browser wallet holds all
funds and privacy keys; the console server needs no account or viewing keys.
Use `/api/terms` as a health-check endpoint. The `.dockerignore` excludes
local credentials and build artifacts.

The provider keeps cumulative claim counters in memory; a restart clears
them. Use one process/replica for this demo. This is a demonstration endpoint
with provider-funded inference, not a production payment gate.
