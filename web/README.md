# @strkret/web

A visitor console defaulting to mainnet: connect a privacy-enabled Starknet
wallet, shield funds, buy metered inference, then fund a backend relayer and
request anonymizer settlement. The funding withdrawal and contract settlement
are separate transactions. Funding integration remains incomplete; see below.

## Run locally

After installing the workspace dependencies, set `OPENAI_API_KEY` in the
repo-root `.env`. `OPENAI_MODEL` is optional. The console requires a working
inference key; it does not fall back to an echo service. Settlement also needs
the relayer configuration below.

```bash
pnpm --filter @strkret/agent-core run build
pnpm --filter @strkret/agent-provider run build
pnpm --filter @strkret/web run dev
```

Open http://localhost:3100. Next.js serves both the UI and the provider's API
routes; the standalone devnet session server is not needed.

To test locally on Sepolia, prefix the dev or build command with
`NEXT_PUBLIC_STRK20_NETWORK=sepolia`. Network selection is compiled into the
browser bundle, so changing it for a production server requires rebuilding.
The supplied Sepolia RPC uses HTTP and will be blocked as mixed content by
an HTTPS-hosted browser app. The supplied Dockerfile builds for mainnet.

## Wallet flow

1. Connect Ready with STRK20 support (Wallet API >= 0.10.3).
2. Choose **Shield funds** — deposits 10 STRK on mainnet or 6 STRK on Sepolia,
   equal to the hardcoded `RELAYER_FEE_BUFFER`. Review any token approval and
   deposit fees. The deposit reveals your address, token and amount publicly.
   This amount excludes usage and wallet operation fees, so it does not fully
   fund settlement from an empty private balance. Wait for spendable notes
   and ensure the wallet has enough funds before settling.
3. Ask a few prompts. Each request carries a signed cumulative usage voucher.
   Watch accrued units and calls served increase without transactions.
4. Choose **Settle now**. The wallet withdraws usage value plus the fee buffer
   to the relayer's public address. The page waits for its receipt and ten
   additional blocks, then posts the signed voucher and refund address to
   `/api/relay-settle`. The backend submits `privacy_invoke` from an existing
   shielded reserve. The withdrawal does not create a relayer pool note, so
   that wait does not convert the public funds into spendable private funds.
   Follow the returned explorer link to inspect the settlement receipt.

If the funding withdrawal's wallet prompt hangs with no popup and no error,
Ready may have completed it anyway without telling this page — a "continue"
option appears after a few seconds. It waits 150 seconds and attempts the
backend call without checking a funding receipt. Use it only after checking
the withdrawal in the wallet; the elapsed timer is not proof of funding.

## Whose money actually moves

Ready can relay its own native STRK20 actions (deposit, withdraw, transfer)
but not a private transaction invoking a third-party contract — confirmed
directly by the STRK20 team. The anonymizer's `privacy_invoke` is exactly
that kind of call, so a **relayer** (a separate backend account holding its
own small pre-shielded reserve) submits it on your behalf.

The visitor sends usage value plus a fee buffer to the relayer's **public**
balance. Separately, the backend withdraws `totalUnits × RATE + RATE` from
the relayer's **shielded** balance into the anonymizer. On a fresh channel,
the provider/relayer receives `totalUnits × RATE` in an open note and the
visitor receives the extra `RATE` (0.0001 STRK) in a refund note. Protocol
fees and gas are paid from the relayer's public balance.

**The funding integration is incomplete.** There is no deposit that moves
visitor funding into the relayer's shielded reserve. The backend also does
not receive or verify a funding transaction, bind payment to a voucher, or
check that the API actually served those units. A valid self-signed voucher
can reach settlement without the browser's funding step. This endpoint must
not be described as a funded payment gate or as having no operator exposure.

Funding and settlement are not atomic: a failed backend call does not refund
the visitor's withdrawal. Retrying **Settle now** requests another funding
withdrawal. The current server has no reconciliation or automatic refund
path for this case.

The fee buffer is a fixed estimate, not a quote from the pool or a
measurement of what the relayer spends. You pay the full buffer
regardless of the relayer's real cost, and any surplus is not refunded —
it accumulates in the relayer's own balance rather than coming back to you.
The contract already accepts a `Span<ProviderClaim>`, so a
relayer holding several visitors' claims could settle them all in one
`privacy_invoke` and split one protocol fee across many visitors instead of
each paying a full buffer. That also needs funding verification, fee
accounting and correct per-visitor refunds; batching alone does not supply
them. The console currently submits one claim per settlement.

Each started block of 100 prompt characters, measured by JavaScript
`prompt.length`, adds one usage unit, priced at
**0.0001 STRK**. Three short prompts accrue three units worth **0.0003
STRK**, before fees. Both `/api/terms` and the 402 response publish
`rate: "100000000000000"` (raw STRK units per usage unit);
`pricing.unitsPerBlock` controls the separate metering count. The UI
displays the rate and accrued value in STRK.

The anonymizer enforces signed units and rate arithmetic. The voucher does
not lock funds, authorize wallet debits, or bind a recipient note or token.
The server chooses the payout and refund notes. The recorded SDK mainnet
run in `strk20.json` demonstrates the contract mechanism, not this newer
browser funding flow.

Deposits reveal the depositor, token and amount; withdrawals reveal the
recipient, token and amount. Open-note tokens and amounts and this helper's
voucher calldata are public. The provider sees prompts and vouchers, and the
relayer receives the refund wallet address. Encrypted transfers inside the
pool have different privacy properties from these public edges; see the
[pool source](https://github.com/starkware-libs/starknet-privacy/blob/980da8affafb9f8350975ca93c03b2299a31ac9b/packages/privacy/src/privacy.cairo).

## Relayer configuration

Provide these as server-side environment variables, never `NEXT_PUBLIC_*`:

| Network | Required settlement variables |
| --- | --- |
| Mainnet | `MAINNET_PROVIDER_ACCOUNT_ADDRESS`, `MAINNET_PROVIDER_ACCOUNT_PRIVATE_KEY`, `MAINNET_PROVIDER_VIEWING_KEY`, `MAINNET_RPC_URL` |
| Sepolia | `PROVIDER_ACCOUNT_ADDRESS`, `PROVIDER_ACCOUNT_PRIVATE_KEY`, `PROVIDER_VIEWING_KEY`, `PROVING_SERVICE_URL`; `INDEXER_URL` is optional |

The current mainnet implementation extracts its Starkscan prover key from
the final path segment of `MAINNET_RPC_URL`, requiring an `mzk_live_key_`
prefix. It uses the RPC endpoint in `lib/protocol.ts` for transaction
submission and the fixed Starkscan REST URL in `lib/relayer.ts` for proving.
This differs from the SDK demo's `STARKSCAN_PROVER_KEY` variable.

The configured relayer address must match the provider address advertised in
`lib/protocol.ts`. It needs a registered viewing key, mature shielded STRK
covering the escrow, public STRK for fees and gas, and a sufficient pool
allowance visible at the proving block. The recipient wallet must be
registered to receive its refund. None of this is created by setting an
inference key or by the browser's public funding withdrawal.

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

Set the inference and mainnet relayer variables in your shell, then:

```bash
docker run --rm -p 3100:3100 \
  --env OPENAI_API_KEY --env OPENAI_MODEL \
  --env MAINNET_PROVIDER_ACCOUNT_ADDRESS \
  --env MAINNET_PROVIDER_ACCOUNT_PRIVATE_KEY \
  --env MAINNET_PROVIDER_VIEWING_KEY --env MAINNET_RPC_URL \
  strkret:submission
```

For a hosted container, provide these variables as runtime secrets and expose
`PORT` (default 3100). The visitor wallet retains its keys; the backend holds
the relayer's account and viewing keys. `/api/terms` checks HTTP availability,
not inference, funding, allowance or prover readiness. The `.dockerignore`
excludes local credentials and build artifacts.

The provider keeps cumulative claim counters in memory; a restart clears
them. Use one process/replica for this demo. This is a demonstration endpoint
with provider-funded inference, not a production payment gate.
