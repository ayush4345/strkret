import { config as loadEnv } from "dotenv";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

// Load the monorepo-root .env regardless of the directory this is run from.
// .env is gitignored, so real keys stay out of git.
const envPath = resolve(dirname(fileURLToPath(import.meta.url)), "../../../.env");
loadEnv({ path: envPath });

function required(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`missing required env var: ${name} (looked in ${envPath})`);
  return value;
}

export const env = {
  rpcUrl: required("RPC_URL"),
  poolAddress: required("POOL_ADDRESS"),
  tokenAddress: required("TOKEN_ADDRESS"),
  provingServiceUrl: required("PROVING_SERVICE_URL"),
  indexerUrl: required("INDEXER_URL"),
  consumer: {
    address: required("CONSUMER_ACCOUNT_ADDRESS"),
    privateKey: required("CONSUMER_ACCOUNT_PRIVATE_KEY"),
    viewingKey: BigInt(required("CONSUMER_VIEWING_KEY")),
  },
  provider: {
    address: required("PROVIDER_ACCOUNT_ADDRESS"),
    privateKey: required("PROVIDER_ACCOUNT_PRIVATE_KEY"),
    viewingKey: BigInt(required("PROVIDER_VIEWING_KEY")),
  },
};
