import { config as loadEnv } from "dotenv";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

// Load the monorepo-root .env regardless of the directory this is run from.
// .env is gitignored, so real keys stay out of git.
const envPath = resolve(dirname(fileURLToPath(import.meta.url)), "../../../.env");
loadEnv({ path: envPath });

/** Empty or unset both count as absent — a blank line in .env is not a value. */
function optional(name: string): string | undefined {
  const value = process.env[name];
  return value && value.trim() ? value.trim() : undefined;
}

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
  /**
   * Optional. Left unset, discovery reads the pool directly and decrypts
   * locally — which is the only option on mainnet, where no hosted indexer
   * exists. Required-ness here used to make a mainnet run impossible before
   * it started.
   */
  indexerUrl: optional("INDEXER_URL"),
  /**
   * Set for mainnet, where the prover is Starkscan's REST relay rather than a
   * JSON-RPC service. `provingServiceUrl` is then read as the relay base URL.
   */
  starkscanProverApiKey: optional("STARKSCAN_PROVER_KEY"),
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
