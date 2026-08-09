// Reading the configuration that describes the machine.
//
// `config.jsonc` at the repository root holds it, and `config.example.jsonc`
// stands in when there is none, so a fresh clone runs without setup and the
// example is the file a machine-local config is copied from. Nothing here has
// a built-in default for a model or an endpoint: those differ on every
// machine, which is what makes them configuration.
//
// The dialect is JSONC, JSON with comments and trailing commas, so the example
// can say what each option means beside it. Nothing else reads these files:
// what a run records is the resolved configuration, as plain JSON.
import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { type ParseError, parse, printParseErrorCode } from "jsonc-parser";

/**
 * The model a run talks to. Two cases, told apart by `baseUrl`: without it the
 * provider is one Pi knows, which carries the catalogue and the credentials;
 * with it the provider is an OpenAI-compatible endpoint we describe ourselves,
 * which is how a local server or a proxy is reached.
 */
export interface ModelConfig {
  /** Provider id, `anthropic` or `openai` for a provider Pi knows. */
  provider: string;
  /** Model id as the provider names it. */
  id: string;
  /** Root of an OpenAI-compatible API, including the version segment. */
  baseUrl?: string;
  /** Environment variable holding the key for an endpoint we describe. */
  apiKeyEnv?: string;
  /** How much the model should think, when it can. */
  thinkingLevel?: ThinkingLevel;
  contextWindow?: number;
  maxTokens?: number;
}

const THINKING_LEVELS = ["minimal", "low", "medium", "high", "xhigh", "max"] as const;
export type ThinkingLevel = (typeof THINKING_LEVELS)[number];

/** A program a run spawns, and where to find it. */
export interface BinaryConfig {
  path: string;
  version?: string;
}

export interface Config {
  model: ModelConfig;
  /** Path overrides, keyed by binary name; anything absent is on PATH. */
  binaries: Record<string, BinaryConfig>;
  /** The file this came from, for the run_start snapshot. */
  source: string;
}

/** The repository root, found from this file rather than the caller's cwd. */
export function repoRoot(): string {
  return resolve(dirname(new URL(import.meta.url).pathname), "..", "..");
}

function readModel(raw: unknown, source: string): ModelConfig {
  const config = raw as Record<string, unknown> | undefined;
  const model = config?.model as Record<string, unknown> | undefined;
  if (!model) throw new Error(`${source} has no "model" section`);

  const text = (key: string, required: boolean): string | undefined => {
    const value = model[key];
    if (value === undefined) {
      if (required) throw new Error(`${source}: model.${key} is missing`);
      return undefined;
    }
    if (typeof value !== "string" || value === "") {
      throw new Error(`${source}: model.${key} must be a non-empty string`);
    }
    return value;
  };
  const count = (key: string): number | undefined => {
    const value = model[key];
    if (value === undefined) return undefined;
    if (typeof value !== "number" || !Number.isInteger(value) || value <= 0) {
      throw new Error(`${source}: model.${key} must be a positive integer`);
    }
    return value;
  };

  const baseUrl = text("base_url", false);
  if (baseUrl !== undefined) {
    try {
      new URL(baseUrl);
    } catch {
      throw new Error(`${source}: model.base_url is not a URL: ${baseUrl}`);
    }
  }

  const thinking = text("thinking_level", false);
  if (thinking !== undefined && !THINKING_LEVELS.includes(thinking as ThinkingLevel)) {
    throw new Error(`${source}: model.thinking_level must be one of ${THINKING_LEVELS.join(", ")}`);
  }

  return {
    provider: text("provider", true) as string,
    id: text("id", true) as string,
    baseUrl,
    apiKeyEnv: text("api_key_env", false),
    thinkingLevel: thinking as ThinkingLevel | undefined,
    contextWindow: count("context_window"),
    maxTokens: count("max_tokens"),
  };
}

/**
 * Load the configuration, from `path` when given, otherwise `config.jsonc` and
 * then `config.example.jsonc`. Throws with the offending field named, because a
 * configuration mistake should fail before a run starts rather than as a
 * confusing error on the first turn.
 */
export function loadConfig(path?: string): Config {
  const candidates = path
    ? [path]
    : [join(repoRoot(), "config.jsonc"), join(repoRoot(), "config.example.jsonc")];

  for (const candidate of candidates) {
    let text: string;
    try {
      text = readFileSync(candidate, "utf8");
    } catch {
      continue;
    }
    const errors: ParseError[] = [];
    const raw: unknown = parse(text, errors, { allowTrailingComma: true });
    if (errors.length) {
      const first = errors[0] as ParseError;
      throw new Error(
        `${candidate} does not parse: ${printParseErrorCode(first.error)} at offset ${first.offset}`,
      );
    }
    return {
      model: readModel(raw, candidate),
      binaries: readBinaries(raw, candidate),
      source: candidate,
    };
  }
  throw new Error(`no configuration found, looked at: ${candidates.join(", ")}`);
}

function readBinaries(raw: unknown, source: string): Record<string, BinaryConfig> {
  const section = (raw as Record<string, unknown> | undefined)?.binaries;
  if (section === undefined) return {};
  if (typeof section !== "object" || section === null) {
    throw new Error(`${source}: binaries must be an object`);
  }
  const binaries: Record<string, BinaryConfig> = {};
  for (const [name, value] of Object.entries(section as Record<string, unknown>)) {
    const entry = value as Record<string, unknown> | null;
    if (typeof entry !== "object" || entry === null || typeof entry.path !== "string") {
      throw new Error(`${source}: binaries.${name} needs a path`);
    }
    binaries[name] = {
      path: entry.path,
      version: typeof entry.version === "string" ? entry.version : undefined,
    };
  }
  return binaries;
}

/** Where to find a program a run spawns, or its name for a PATH lookup. */
export function binaryPath(config: Config, name: string): string {
  return config.binaries[name]?.path ?? name;
}

/**
 * The key for an endpoint we describe, from the environment variable the
 * config names. A provider Pi knows resolves its own credentials, so this
 * returns nothing for those.
 */
export function apiKeyFor(model: ModelConfig): string | undefined {
  return model.apiKeyEnv ? process.env[model.apiKeyEnv] : undefined;
}
