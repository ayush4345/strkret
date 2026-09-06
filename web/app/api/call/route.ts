import { NextResponse } from "next/server";

// The session server owns the devnet, the provider process and the channel;
// this is only a proxy, so the browser never talks to it directly and the
// URL stays configurable for a deployed demo.
const SESSION_URL = process.env.SESSION_URL ?? "http://localhost:4022";

export const dynamic = "force-dynamic";

export async function POST(req: Request) {
  try {
    const body = "POST" === "POST" ? await req.text() : undefined;
    const res = await fetch(`${SESSION_URL}/call`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body,
      cache: "no-store",
    });
    return NextResponse.json(await res.json(), { status: res.status });
  } catch {
    return NextResponse.json(
      { ok: false, error: "session server unreachable — run: pnpm --filter @strkret/agent-consumer run serve" },
      { status: 503 },
    );
  }
}
