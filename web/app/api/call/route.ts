import { NextResponse } from "next/server";
import {
  starkKeyOf,
  verifyVoucher,
  voucherFromWire,
  priceOf,
  type Voucher,
  type VoucherWire,
} from "@strkret/agent-core";
import { LlmService } from "@strkret/agent-provider";
import { buildTerms, UNITS_PER_BLOCK, RATE_COMMITMENT, CHANNEL_ID } from "../../../lib/protocol";

const service = new LlmService(UNITS_PER_BLOCK);
const terms = buildTerms(service.pricing, service.price({ prompt: "" }));
const paymentRequired = () => ({ x402Version: 1 as const, accepts: [terms] });

/**
 * Highest cumulative units seen per (pubkey, channel) — the same in-memory
 * high-water mark `server.ts` keeps, moved here because the demo now runs
 * as this route instead of a standalone process. In-memory on purpose: this
 * is a claim cache, not the authoritative mark — that lives on-chain in
 * `settled_units`, so a restart loses the cache, not any money.
 */
declare global {
  // eslint-disable-next-line no-var
  var __strkretClaims: Map<string, bigint> | undefined;
}
const claims = globalThis.__strkretClaims ?? (globalThis.__strkretClaims = new Map());
const claimKey = (v: Voucher): string => `${starkKeyOf(v.pubkey)}:${v.channelId}`;

export const dynamic = "force-dynamic";

export async function POST(req: Request) {
  try {
    const { prompt, voucher: wire } = (await req.json()) as { prompt: string; voucher?: VoucherWire };
    const price = priceOf(terms, prompt);

    if (!wire) {
      return NextResponse.json(paymentRequired(), { status: 402 });
    }
    const voucher = voucherFromWire(wire);
    if (!verifyVoucher(voucher)) {
      return NextResponse.json({ error: "voucher signature did not verify", ...paymentRequired() }, { status: 402 });
    }
    if (voucher.channelId !== CHANNEL_ID) {
      return NextResponse.json({ error: `unknown channel ${voucher.channelId}`, ...paymentRequired() }, { status: 402 });
    }
    if (BigInt(voucher.rateCommitment) !== BigInt(RATE_COMMITMENT)) {
      return NextResponse.json(
        { error: "voucher is signed against a different rate", ...paymentRequired() },
        { status: 402 },
      );
    }

    const previous = claims.get(claimKey(voucher)) ?? 0n;
    if (voucher.totalUnits < previous + price) {
      return NextResponse.json(
        {
          error: `voucher must cover at least ${previous + price} units, got ${voucher.totalUnits}`,
          requiredUnits: (previous + price).toString(),
          ...paymentRequired(),
        },
        { status: 402 },
      );
    }

    const result = await service.handle({ prompt });
    claims.set(claimKey(voucher), voucher.totalUnits);

    return NextResponse.json({
      completion: result.completion,
      cost: result.cost.toString(),
      claimedUnits: voucher.totalUnits.toString(),
    });
  } catch (err) {
    return NextResponse.json({ error: err instanceof Error ? err.message : String(err) }, { status: 400 });
  }
}
