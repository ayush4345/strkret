import { NextResponse } from "next/server";
import { LlmService } from "@strkret/agent-provider";
import { buildTerms, UNITS_PER_BLOCK } from "../../../lib/protocol";

const service = new LlmService(UNITS_PER_BLOCK);

export const dynamic = "force-dynamic";

/** The channel-open terms a wallet-connected visitor pays against, mirroring
 * the standalone agent provider's `GET /terms` — see `server.ts`. */
export async function GET() {
  return NextResponse.json(buildTerms(service.pricing));
}
