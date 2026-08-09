// Turning the configured model into the one Pi runs on.
//
// Two paths, chosen by whether the configuration gives a base URL. A provider
// Pi knows, anthropic or openai among others, comes from its built-in
// catalogue, which already holds the context window, the pricing and the
// credential resolution. An endpoint we are given instead is described here as
// an OpenAI-compatible provider, which is how a local server or a proxy is
// reached. The rest of the agent sees the same pair either way.
import { type Api, createProvider, type Model, type Models } from "@earendil-works/pi-ai";
import { openAICompletionsApi } from "@earendil-works/pi-ai/api/openai-completions.lazy";
import { builtinModels } from "@earendil-works/pi-ai/providers/all";
import { apiKeyFor, type ModelConfig } from "./config.ts";

export interface ResolvedModel {
  models: Models;
  model: Model<Api>;
}

function describe(config: ModelConfig, baseUrl: string): Model<"openai-completions"> {
  return {
    id: config.id,
    name: `${config.id} (${config.provider})`,
    api: "openai-completions",
    provider: config.provider,
    baseUrl,
    reasoning: false,
    input: ["text"],
    // An endpoint we describe is in nobody's price list, and a local one bills
    // nothing; a provider Pi knows brings its own costs.
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: config.contextWindow ?? 32768,
    maxTokens: config.maxTokens ?? 4096,
  };
}

function take(models: Models, config: ModelConfig): ResolvedModel {
  const model = models.getModel(config.provider, config.id);
  if (!model) {
    // getModels is the synchronous read; getAvailable would need credentials
    // and a network round trip to say the same thing.
    const known = models.getModels(config.provider).map((candidate) => candidate.id);
    const hint = known.length
      ? `known ids for ${config.provider}: ${known.slice(0, 8).join(", ")}`
      : `no provider named ${config.provider}; set model.base_url to describe your own`;
    throw new Error(`model ${config.provider}/${config.id} not found, ${hint}`);
  }
  return { models, model };
}

/**
 * Resolve the configured model. Throws when neither the catalogue nor the
 * configuration accounts for the provider and id, naming what it does know,
 * because that mistake should surface before a run starts.
 */
export function resolveModel(config: ModelConfig): ResolvedModel {
  const models = builtinModels();
  if (!config.baseUrl) return take(models, config);

  const baseUrl = config.baseUrl;
  models.setProvider(
    createProvider({
      id: config.provider,
      name: config.provider,
      baseUrl,
      auth: {
        apiKey: {
          name: config.provider,
          // A local server ignores the key, but the OpenAI-compatible client
          // refuses to send a request without one, so an endpoint with no key
          // gets a placeholder rather than nothing.
          resolve: async () => ({ auth: { apiKey: apiKeyFor(config) ?? "unused" } }),
        },
      },
      models: [describe(config, baseUrl)],
      api: openAICompletionsApi(),
    }),
  );
  return take(models, config);
}
