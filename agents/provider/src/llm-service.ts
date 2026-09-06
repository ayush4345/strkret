import { config as loadEnv } from "dotenv";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import OpenAI from "openai";
import { priceOf, type Service } from "@strkret/agent-core";

// Load the monorepo-root .env regardless of where this is run from, matching
// the consumer's env.ts. .env is gitignored, so the key stays out of git.
loadEnv({ path: resolve(dirname(fileURLToPath(import.meta.url)), "../../../.env") });

export interface LlmRequest {
  prompt: string;
}

export interface LlmResult {
  completion: string;
  cost: bigint;
  /** Reported for observability, not billing — see the note on pricing below. */
  usage?: { promptTokens: number; completionTokens: number };
}

/**
 * A provider agent that sells real inference: the consumer sends a prompt and
 * pays for the answer. This is what the settlement machinery exists to pay
 * for — an echo service made the plumbing demonstrable but left "agent
 * commerce" doing no work.
 *
 * ## Why it prices on input size rather than tokens
 *
 * Tokens are the natural unit and are deliberately not used here.
 * `Service.price()` is synchronous and runs *before* `handle()`, because the
 * consumer signs a voucher for that amount up front — and the settlement
 * contract pays whatever the signed voucher says. Token counts are only known
 * after the call, so pricing on them would mean either signing a ceiling and
 * overpaying the difference, or signing after the fact.
 *
 * Signing after the fact is the right design — it is how payment channels
 * usually work, with the provider carrying exactly one call of risk — but it
 * inverts the current flow, so it is named as the next step rather than
 * smuggled in here. Input size is deterministic, known synchronously, and
 * varies genuinely per request, which is enough for the metering to be real.
 *
 * Actual token usage still comes back on the result, so the gap between what
 * was charged and what was consumed stays visible instead of hidden.
 */
export class LlmService implements Service<LlmRequest, LlmResult> {
  readonly name = "llm-inference";
  readonly #model: string;
  #client: OpenAI | undefined;
  #provided: OpenAI | undefined;

  constructor(
    /** Units charged per started block of `charsPerUnit` prompt characters. */
    private readonly unitsPerBlock: bigint = 10n,
    private readonly charsPerUnit = 100,
    client?: OpenAI,
  ) {
    if (unitsPerBlock <= 0n) throw new Error("unitsPerBlock must be positive");
    // Model is configurable because model availability differs per account —
    // a hardcoded name that the key cannot reach fails at the first paid call,
    // which is the worst possible moment to discover it.
    this.#model = process.env.OPENAI_MODEL ?? "gpt-5.4-mini";
    this.#provided = client;
  }

  /**
   * Built on first use, not in the constructor. Pricing and terms need no
   * credentials, and the OpenAI client throws on construction when the key is
   * missing — so an eager client would make this service impossible to price,
   * advertise or test without a paid key it may never call.
   */
  #openai(): OpenAI {
    this.#client ??= this.#provided ?? new OpenAI(); // reads OPENAI_API_KEY
    return this.#client;
  }

  /** The pricing rule, in the shape the 402's terms advertise. */
  get pricing(): { unitsPerBlock: string; charsPerBlock: number } {
    return { unitsPerBlock: this.unitsPerBlock.toString(), charsPerBlock: this.charsPerUnit };
  }

  /**
   * Goes through the same `priceOf` the consumer uses, off the same terms this
   * service advertises. Reimplementing the formula here would be two copies of
   * one rule, free to drift — and they would only be caught disagreeing at the
   * gate, on a call the consumer had already paid to make.
   */
  price(req: LlmRequest): bigint {
    return priceOf({ rate: this.unitsPerBlock.toString(), pricing: this.pricing }, req.prompt);
  }

  async handle(req: LlmRequest): Promise<LlmResult> {
    const response = await this.#openai().chat.completions.create({
      model: this.#model,
      // `max_tokens` is rejected by the gpt-5 family — it wants
      // `max_completion_tokens`. The older name fails at the first paid call
      // rather than at startup, which is the worst place to find out.
      max_completion_tokens: 1024,
      messages: [
        {
          role: "system",
          content:
            "You are a metered inference service billed per request. Answer in at most three sentences. " +
            "Be direct and concrete. If the question cannot be answered as asked, say so plainly rather than guessing.",
        },
        { role: "user", content: req.prompt },
      ],
    });

    const choice = response.choices[0];
    const completion = choice?.message?.content?.trim();
    if (!completion) {
      // A filtered or empty completion still consumed the consumer's call, so
      // fail loudly rather than billing for an empty string.
      throw new Error(`inference returned no content (finish_reason: ${choice?.finish_reason ?? "unknown"})`);
    }

    return {
      completion,
      cost: this.price(req),
      usage: response.usage
        ? { promptTokens: response.usage.prompt_tokens, completionTokens: response.usage.completion_tokens }
        : undefined,
    };
  }
}
