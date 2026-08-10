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
import { resolveModel } from "../agent/model.ts";
import { loadConfig, type ModelConfig, repoRoot } from "../core/config.ts";

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

  /**
   * The environment wins over the file, and make sets it, so a test about
   * what the file says has to say the environment is silent.
   */
  function withoutEnv<T>(body: () => T): T {
    const saved = process.env.TOOLCHAIN;
    delete process.env.TOOLCHAIN;
    try {
      return body();
    } finally {
      if (saved !== undefined) process.env.TOOLCHAIN = saved;
    }
  }

  test("reads where the toolchain was built", () => {
    const file = join(tmpdir(), `alive-next-toolchain-${process.pid}.jsonc`);
    writeFileSync(
      file,
      `{ // a machine that keeps one toolchain for several checkouts
         "model": { "provider": "p", "id": "m" },
         "toolchain": "/zdata/llvms" }`,
    );
    try {
      expect(withoutEnv(() => loadConfig(file).toolchain)).toBe("/zdata/llvms");
    } finally {
      rmSync(file);
    }
  });

  test("reads a relative toolchain as relative to the repository", () => {
    const file = join(tmpdir(), `alive-next-relative-${process.pid}.jsonc`);
    writeFileSync(file, '{ "model": { "provider": "p", "id": "m" }, "toolchain": "./deps" }');
    try {
      // Otherwise the same configuration would name a different directory
      // depending on where the process was started.
      expect(withoutEnv(() => loadConfig(file).toolchain)).toBe(join(repoRoot(), "deps"));
    } finally {
      rmSync(file);
    }
  });

  test("falls back to deps in the repository", () => {
    const file = join(tmpdir(), `alive-next-default-${process.pid}.jsonc`);
    writeFileSync(file, '{ "model": { "provider": "p", "id": "m" } }');
    try {
      expect(withoutEnv(() => loadConfig(file).toolchain)).toBe(join(repoRoot(), "deps"));
    } finally {
      rmSync(file);
    }
  });

  test("lets the environment name a toolchain for one run", () => {
    const file = join(tmpdir(), `alive-next-env-${process.pid}.jsonc`);
    writeFileSync(file, '{ "model": { "provider": "p", "id": "m" }, "toolchain": "/from/file" }');
    const saved = process.env.TOOLCHAIN;
    process.env.TOOLCHAIN = "/from/env";
    try {
      expect(loadConfig(file).toolchain).toBe("/from/env");
    } finally {
      if (saved === undefined) delete process.env.TOOLCHAIN;
      else process.env.TOOLCHAIN = saved;
      rmSync(file);
    }
  });

  test("says so when a configuration still names binaries", () => {
    // The old shape was a path per binary, which could name three builds that
    // do not agree; the message points at what replaced it.
    const file = join(tmpdir(), `alive-next-old-${process.pid}.jsonc`);
    writeFileSync(
      file,
      '{ "model": { "provider": "p", "id": "m" }, "binaries": { "llops": { "path": "x" } } }',
    );
    try {
      expect(() => loadConfig(file)).toThrow(/"binaries" is no longer read/);
    } finally {
      rmSync(file);
    }
  });

  test("refuses a toolchain that is not a path", () => {
    const file = join(tmpdir(), `alive-next-badtool-${process.pid}.jsonc`);
    writeFileSync(file, '{ "model": { "provider": "p", "id": "m" }, "toolchain": 7 }');
    try {
      expect(() => loadConfig(file)).toThrow(/toolchain must be a non-empty path/);
    } finally {
      rmSync(file);
    }
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
