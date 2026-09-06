# @strkret/web

A browser console for a live metered session — for presenting the flow rather
than reading a script's output.

## Running it

Two processes, in this order:

```bash
# 1. the session server: boots a devnet, spawns the provider, opens the
#    channel and deposits escrow (~30s)
pnpm --filter @strkret/agent-consumer run serve

# 2. the UI
pnpm --filter @strkret/web run dev     # http://localhost:3100
```

Set `OPENAI_API_KEY` in the repo-root `.env` and the provider answers with a
real model; leave it empty and it echoes. Everything else is identical.

## Why devnet

Devnet is the real privacy-pool contract with real proofs, but it mines on
demand. On Sepolia every settlement waits ~10 blocks for note maturity, which
would stall a demo for twenty minutes mid-sentence — the session server hand-
cranks blocks instead. Nothing here is simulated; only the chain is local.

## What to point at while presenting

- The **402** panel: terms the provider advertised, including the rate
  commitment every voucher is signed over.
- **Owed vs settled**: owed climbs on every call with no chain contact;
  settled only moves when a settlement fires.
- The **settlement entry**: one private transfer, amount and both parties
  hidden, for several calls at once. That is the whole argument — the pool
  charges a flat fee per settlement, so the batch is the only lever.
