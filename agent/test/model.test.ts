// Configuration and model resolution.
//
// Everything here runs offline except the round trip, which needs a model that
// is free to call: it runs only for a configured endpoint that answers, so a
// machine pointed at a hosted provider skips it rather than spending money in
// a test.
import { describe, expect, test } from "bun:test";
import { rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfig, type ModelConfig, repoRoot } from "../src/config.ts";
import { resolveModel } from "../src/model.ts";

const config = loadConfig();

const ENDPOINT_URL = "http://127.0.0.1:1/v1";
const ENDPOINT: ModelConfig = {
  provider: "local",
  id: "some-model",
  baseUrl: ENDPOINT_URL,
};

async function endpointAnswers(model: ModelConfig): Promise<boolean> {
  if (!model.baseUrl) return false;
  try {
    const response = await fetch(`${model.baseUrl}/models`, {
      signal: AbortSignal.timeout(2000),
    });
    return response.ok;
  } catch {
    return false;
  }
}

const live = await endpointAnswers(config.model);

describe("loadConfig", () => {
  test("reads the model section", () => {
    expect(config.model.provider).not.toBe("");
    expect(config.model.id).not.toBe("");
    expect(config.source).toMatch(/config(\.example)?\.jsonc$/);
  });

  test("rejects a file it cannot use", () => {
    expect(() => loadConfig("/nonexistent/config.jsonc")).toThrow(/no configuration/);
  });

  test("reads the example, whose commented options stay off", () => {
    const example = loadConfig(join(repoRoot(), "config.example.jsonc"));
    expect(example.model.provider).toBe("anthropic");
    expect(example.model.baseUrl).toBeUndefined();
    expect(example.model.apiKeyEnv).toBeUndefined();
    expect(example.model.thinkingLevel).toBeUndefined();
  });

  test("reports where a file stops parsing", () => {
    const broken = join(tmpdir(), `alive-next-broken-${process.pid}.jsonc`);
    writeFileSync(broken, '{ "model": { "provider": "x", }\n');
    try {
      expect(() => loadConfig(broken)).toThrow(/does not parse/);
    } finally {
      rmSync(broken);
    }
  });
});

describe("resolveModel", () => {
  test("describes an endpoint the configuration gives", () => {
    const { model } = resolveModel(ENDPOINT);
    expect(model.id).toBe(ENDPOINT.id);
    expect(model.provider).toBe(ENDPOINT.provider);
    expect(model.baseUrl).toBe(ENDPOINT_URL);
    expect(model.api).toBe("openai-completions");
  });

  test("takes a known provider from the catalogue", () => {
    const { model } = resolveModel({ provider: "anthropic", id: "claude-sonnet-4-6" });
    expect(model.provider).toBe("anthropic");
    expect(model.contextWindow).toBeGreaterThan(0);
  });

  test("names what it knows when the model is not there", () => {
    expect(() => resolveModel({ provider: "anthropic", id: "no-such-model" })).toThrow(
      /known ids for anthropic/,
    );
    expect(() => resolveModel({ provider: "nowhere", id: "x" })).toThrow(/model\.base_url/);
  });

  test("resolves whatever this machine is configured for", () => {
    const { model } = resolveModel(config.model);
    expect(model.id).toBe(config.model.id);
  });
});

describe.skipIf(!live)("the configured endpoint", () => {
  test("answers a prompt", async () => {
    const { models, model } = resolveModel(config.model);
    const reply = await models.complete(model, {
      systemPrompt: "Answer with one word.",
      messages: [{ role: "user", content: "Say the word ready.", timestamp: Date.now() }],
    });
    expect(reply.role).toBe("assistant");
    expect(reply.errorMessage).toBeUndefined();
    const text = reply.content
      .filter((part) => part.type === "text")
      .map((part) => part.text)
      .join("");
    expect(text.length).toBeGreaterThan(0);
  }, 120_000);
});
