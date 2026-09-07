import { writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createPrivacyClient } from "@strkret/privacy-client";
import { runSession } from "@strkret/agent-core";
import { EchoService, type EchoRequest } from "@strkret/agent-provider";
import { env } from "./env.js";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");

async function main() {
  const consumer = await createPrivacyClient({
    rpcUrl: env.rpcUrl,
    accountAddress: env.consumer.address,
    accountPrivateKey: env.consumer.privateKey,
    viewingKey: env.consumer.viewingKey,
    poolAddress: env.poolAddress,
    provingServiceUrl: env.provingServiceUrl,
    indexerUrl: env.indexerUrl,
    starkscanProverApiKey: env.starkscanProverApiKey,
  });

  const provider = await createPrivacyClient({
    rpcUrl: env.rpcUrl,
    accountAddress: env.provider.address,
    accountPrivateKey: env.provider.privateKey,
    viewingKey: env.provider.viewingKey,
    poolAddress: env.poolAddress,
    provingServiceUrl: env.provingServiceUrl,
    indexerUrl: env.indexerUrl,
    starkscanProverApiKey: env.starkscanProverApiKey,
  });

  const service = new EchoService(10n);
  const requests: EchoRequest[] = [{ prompt: "weather" }, { prompt: "translate" }, { prompt: "price" }];

  const { txHashes } = await runSession(consumer, provider, service, requests, {
    tokenAddress: env.tokenAddress,
    poolAddress: env.poolAddress,
    depositAmount: 1_000n, // token's smallest unit — tune for the real run
  });

  writeFileSync(
    resolve(repoRoot, "strk20.json"),
    JSON.stringify(
      { transactions: txHashes, contracts: [env.poolAddress], demo_video: "", demo_url: "" },
      null,
      2,
    ) + "\n",
  );
  console.log(`\nWrote strk20.json with ${txHashes.length} transaction hashes.`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
