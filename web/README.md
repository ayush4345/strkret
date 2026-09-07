# @strkret/web

A visitor console for confidential, metered agent commerce: connect a
privacy-enabled Starknet wallet, shield funds, buy metered inference, then
settle through the real anonymizer contract — enforced on-chain, not a
plain transfer. Defaults to mainnet; Sepolia is available for testing.

## Run locally

After installing the workspace dependencies, set `OPENAI_API_KEY` in the
repo-root `.env` (`OPENAI_MODEL` is optional). Settlement needs the relayer
configuration below.

```bash
pnpm --filter @strkret/agent-core run build
pnpm --filter @strkret/agent-provider run build
pnpm --filter @strkret/web run dev
```

Open http://localhost:3100. Next.js serves both the UI and the provider's
API routes; the standalone devnet session server is not needed.

To run against Sepolia instead, prefix the dev or build command with
`NEXT_PUBLIC_STRK20_NETWORK=sepolia`. Network selection is compiled into the
browser bundle, so switching it on a deployed build means rebuilding.

## Wallet flow

1. Connect Ready with STRK20 support (Wallet API >= 0.10.3).
2. Choose **Shield funds** — deposits `RELAYER_FEE_BUFFER` worth of STRK
   (10 STRK on mainnet, 6 on Sepolia). Review any token approval and
   deposit fees; the deposit reveals your address, token and amount
   publicly. Wait for the deposit's notes to mature before settling.
3. Ask a few prompts. Each request carries a signed cumulative usage
   voucher. Watch accrued units and calls served increase without any
   chain transaction.
4. Choose **Top up relayer's reserve** once (persists across sessions) —
   a small private transfer from your own shielded balance, proved by
   your own wallet.
5. Choose **Settle now**. Your wallet withdraws the owed amount plus the
   fee buffer to the relayer's public address; the page waits for note
   maturity, then posts your signed voucher to `/api/relay-settle`, which
   submits `privacy_invoke` from the relayer's shielded reserve. Follow the
   returned explorer link to see the settlement.

If a wallet-prompted step (funding or the reserve top-up) sits with no
popup and no error for a few seconds, Ready may have completed it without
telling this page — a "continue" option appears and lets the flow proceed.

## Whose money actually moves

Ready can relay its own native STRK20 actions (deposit, withdraw, transfer)
but not a private transaction invoking a third-party contract — confirmed
directly by the STRK20 team. The anonymizer's `privacy_invoke` is exactly
that kind of call, so a **relayer** (a separate backend account holding its
own shielded reserve) submits it on your behalf.

**You fund your own settlement.** The withdraw in step 5 sends the relayer
real STRK — the owed amount plus a fee buffer — and the relayer spends
that, not its own money, to pay the pool's protocol fee and gas. The only
thing the relayer contributes from its own funds is a small escrow buffer
(one usage unit's worth, topped up once via step 4) required by how
`privacy_invoke` moves value.

One fact worth stating plainly: `/api/relay-settle` verifies the voucher's
signature, channel and rate commitment, but does not check that a
corresponding funding withdrawal has landed. A validly-signed voucher can
reach settlement without the browser's funding step having run first — the
relayer's own reserve absorbs that case rather than the request failing.
Binding a specific funding transaction to a specific settle request is real
future work, not yet built.

The fee buffer is a flat, conservative estimate, not metered to the
relayer's actual cost. Any surplus accumulates in the relayer's own balance
rather than being refunded. The real fix is batching: the contract already
accepts a `Span<ProviderClaim>`, so a relayer holding several visitors'
claims could settle them all in one `privacy_invoke` and split one protocol
fee across many visitors instead of each paying a full buffer — the same
amortization argument this whole project makes about metering, applied to
the relayer itself. The console currently submits one claim per settlement.

Each started block of 100 prompt characters adds one usage unit, priced at
**0.0001 STRK**. Three short prompts accrue three units worth **0.0003
STRK**, before fees. Both `/api/terms` and the 402 response publish
`rate: "100000000000000"` (raw STRK units per usage unit);
`pricing.unitsPerBlock` controls the separate metering count.

Settlement is contract-enforced: the anonymizer verifies your voucher's
signature and rate commitment on-chain before paying anyone, the same
mechanism the mainnet run recorded in `strk20.json` demonstrates. Deposits
and withdrawals reveal the address, token and amount publicly; open-note
amounts from the anonymizer are public too, with identities hidden. The
provider sees your prompts and vouchers directly, since metering runs over
plain HTTP — private settlement doesn't make the conversation itself
private from the provider.

## Relayer configuration

Provide these as server-side environment variables, never `NEXT_PUBLIC_*`:

| Network | Required settlement variables |
| --- | --- |
| Mainnet | `MAINNET_PROVIDER_ACCOUNT_ADDRESS`, `MAINNET_PROVIDER_ACCOUNT_PRIVATE_KEY`, `MAINNET_PROVIDER_VIEWING_KEY`, `MAINNET_RPC_URL` |
| Sepolia | `PROVIDER_ACCOUNT_ADDRESS`, `PROVIDER_ACCOUNT_PRIVATE_KEY`, `PROVIDER_VIEWING_KEY`, `PROVING_SERVICE_URL`; `INDEXER_URL` is optional |

On mainnet, the relayer's Starkscan prover key is extracted from the final
path segment of `MAINNET_RPC_URL` (an `mzk_live_key_...` value) — the same
key the SDK demo scripts use via `STARKSCAN_PROVER_KEY`, read here from a
different place for convenience.

The configured relayer address should match `PROVIDER_ADDRESS` in
`lib/protocol.ts`, hold a registered viewing key, mature shielded STRK
covering the escrow (topped up via the console's own "Top up relayer's
reserve" action), public STRK for fees and gas, and pool allowance approved
ahead of time — approving inside the settle request itself would add a
~10-block wait to every visitor's settle, so it's done once, out of band:

```ts
account.execute({ contractAddress: TOKEN, entrypoint: "approve", calldata: [POOL, amount, "0"] })
```

## Verify and build

The selfcheck verifies metering boundaries, advertised rate against its
commitment, exact STRK formatting, settlement amounts, and Wallet API FELT
encoding, including addresses.

```bash
pnpm --filter @strkret/web run selfcheck
pnpm --filter @strkret/web exec tsc --noEmit
pnpm --filter @strkret/web run build
```

## Docker deployment

Build from the repository root. Set `GH_PACKAGES_TOKEN` in your shell to a
GitHub Packages token with `read:packages`; BuildKit mounts it as a secret,
never a build argument or an image layer.

```bash
docker build --secret id=gh_packages_token,env=GH_PACKAGES_TOKEN -t strkret:submission .
```

Set the inference and mainnet relayer variables in your shell, then:

```bash
docker run --rm -p 3100:3100 \
  --env OPENAI_API_KEY --env OPENAI_MODEL \
  --env MAINNET_PROVIDER_ACCOUNT_ADDRESS \
  --env MAINNET_PROVIDER_ACCOUNT_PRIVATE_KEY \
  --env MAINNET_PROVIDER_VIEWING_KEY --env MAINNET_RPC_URL \
  strkret:submission
```

For a hosted container, provide these variables as runtime secrets and
expose `PORT` (default 3100). The visitor's wallet keeps its own keys; the
backend holds only the relayer's account and viewing keys. The provider
keeps cumulative claim counters in memory, scoped to a single process.
