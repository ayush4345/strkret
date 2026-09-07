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

1. Connect Ready with STRK20 support (Wallet API >= 0.10.3) on mainnet.
2. Choose **Shield funds**. Review the token approval, if needed, followed by
   the deposit. The deposit reveals your address and amount publicly.
3. Ask a few prompts. Each request carries a signed cumulative usage voucher.
   Watch accrued units and calls served increase without transactions.
4. Wait for the deposit to confirm and its notes to mature (about 10 blocks).
   Your wallet also needs enough funds to cover the pool fee.
5. Choose **Settle now** and approve the private transfer. Follow the explorer
   link to check confirmation; a returned transaction hash means submitted.

The console shields **0.01 STRK**. Each started block of 100 prompt characters
adds one usage unit, priced at **0.0001 STRK**. Three short prompts accrue
three units worth **0.0003 STRK**, before pool fees. Both `/api/terms` and the
402 response publish `rate: "100000000000000"` (raw STRK units per usage unit);
`pricing.unitsPerBlock` controls the separate metering count. The UI displays
the rate and accrued value in STRK.

Shielding and settlement each incur a pool fee. The recorded mainnet run
used the earlier 1-wei rate and 1000-wei escrow and paid 6 STRK per private
operation; those historical numbers are unchanged. Review current fees in
your wallet. Unused funds remain in your private balance.

The browser uses an ephemeral key to sign vouchers, and payment is voluntary.
This flow does not lock escrow or enforce payment on-chain. The separate
anonymizer run recorded in `strk20.json` demonstrates contract-enforced
settlement. Private transfers hide amount and parties on-chain; the provider
still receives your prompts and vouchers.

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
