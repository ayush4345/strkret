/**
 * Runs the provider as its own HTTP process — the consumer talks to this
 * over the network instead of calling EchoService in-process. Two routes,
 * matching the "provider advertises terms, consumer negotiates" pattern:
 * GET /terms tells the consumer the rate up front (once), POST /call serves
 * one metered request. No auth, no payment enforcement here — the provider
 * still prices and serves independently; it just doesn't verify payment
 * itself, because that's what the STRK20 settlement step is for.
 */
import { createServer } from "node:http";
import { EchoService, type EchoRequest } from "./echo-service.js";

const PORT = Number(process.env.PORT ?? 4021);
const service = new EchoService(10n);

const server = createServer((req, res) => {
  if (req.method === "GET" && req.url === "/terms") {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ rate: service.price().toString() }));
    return;
  }

  if (req.method === "POST" && req.url === "/call") {
    let body = "";
    req.on("data", (chunk) => (body += chunk));
    req.on("end", async () => {
      try {
        const request = JSON.parse(body) as EchoRequest;
        const result = await service.handle(request);
        res.writeHead(200, { "content-type": "application/json" });
        // JSON.stringify throws on bigint — cost travels as a string.
        res.end(JSON.stringify({ completion: result.completion, cost: result.cost.toString() }));
      } catch (err) {
        if (res.headersSent) {
          console.error("error after response started:", err);
          return;
        }
        res.writeHead(400, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: err instanceof Error ? err.message : String(err) }));
      }
    });
    return;
  }

  res.writeHead(404);
  res.end();
});

server.listen(PORT, () => {
  console.log(`provider serving on :${PORT} (rate=${service.price()} per call)`);
});
