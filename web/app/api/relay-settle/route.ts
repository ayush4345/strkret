import { NextResponse } from "next/server";
import type { VoucherWire } from "@strkret/agent-core/voucher";
import { relaySettle } from "../../../lib/relayer";

export const dynamic = "force-dynamic";

/**
 * Settles a visitor's real signed voucher through the anonymizer contract,
 * via our own relayer account — see lib/relayer.ts for why this exists.
 * Sepolia only; will throw plainly if pointed at mainnet without a funded
 * escrow and provider key configured for it.
 */
export async function POST(req: Request) {
  try {
    const { voucher, refundAddress } = (await req.json()) as { voucher: VoucherWire; refundAddress: string };
    if (!voucher || !refundAddress) {
      return NextResponse.json({ error: "voucher and refundAddress are required" }, { status: 400 });
    }
    const result = await relaySettle(voucher, refundAddress);
    return NextResponse.json(result);
  } catch (err) {
    return NextResponse.json({ error: err instanceof Error ? err.message : String(err) }, { status: 400 });
  }
}
