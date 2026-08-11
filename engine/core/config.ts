// Reading the configuration that describes the machine.
//
// `config.jsonc` at the repository root holds it, and `config.example.jsonc`
// stands in when there is none, so a fresh clone runs without setup and the
// example is the file a machine-local config is copied from. Nothing here has
// a built-in default for the toolchain: it differs on every machine, which is
// what makes it configuration.
//
// The dialect is JSONC, JSON with comments and trailing commas, so the example
// can say what each option means beside it. Nothing else reads these files:
// what a run records is the resolved configuration, as plain JSON.
import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { type ParseError, parse, printParseErrorCode } from "jsonc-parser";

/** Milliseconds a run allows the checkers, all optional in the file. */
export interface TimeoutConfig {
  checkDefaultMs?: number;
  checkCapMs?: number;
  eagerCheckMs?: number;
  alive2Ms?: number;
  llubiMs?: number;
}

export interface Config {
  timeouts: TimeoutConfig;
  /**
   * Where LLVM, alive2, llubi and llops were built, absolute. One directory
   * rather than a path per binary, because they are not four choices: they
   * have to be one build against one LLVM, which is what a toolchain is.
   */
  toolchain: string;
  /** The file this came from, for the run_start snapshot. */
  source: string;
}

/** Every section a configuration carries. */
const SECTIONS = ["toolchain", "timeouts"];

/** The repository root, found from this file rather than the caller's cwd. */
export function repoRoot(): string {
  return resolve(dirname(new URL(import.meta.url).pathname), "..", "..");
}

/**
 * Reject a section this file does not carry, because a setting that is read by
 * nothing is worse than an error.
 */
function checkSections(raw: unknown, source: string): void {
  for (const key of Object.keys((raw as Record<string, unknown> | undefined) ?? {})) {
    if (SECTIONS.includes(key)) continue;
    throw new Error(
      `${source}: "${key}" is not a section; this file carries ${SECTIONS.join(", ")}`,
    );
  }
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
    checkSections(raw, candidate);
    return {
      toolchain: readToolchain(raw, candidate),
      timeouts: readTimeouts(raw, candidate),
      source: candidate,
    };
  }
  throw new Error(`no configuration found, looked at: ${candidates.join(", ")}`);
}

/**
 * Where the toolchain is: the TOOLCHAIN environment variable, which is also
 * what the build takes, then the configuration, then deps/ in the repository,
 * which is where the build puts it when nobody says otherwise. A relative path
 * is relative to the repository, so one configuration means one directory
 * whichever directory a process starts in.
 */
function readToolchain(raw: unknown, source: string): string {
  const configured = (raw as Record<string, unknown> | undefined)?.toolchain;
  if (configured !== undefined && (typeof configured !== "string" || configured === "")) {
    throw new Error(`${source}: toolchain must be a non-empty path`);
  }
  const chosen = process.env.TOOLCHAIN || (configured as string | undefined) || "deps";
  return resolve(repoRoot(), chosen);
}

const TIMEOUT_KEYS: Record<string, keyof TimeoutConfig> = {
  check_default_ms: "checkDefaultMs",
  check_cap_ms: "checkCapMs",
  eager_check_ms: "eagerCheckMs",
  alive2_ms: "alive2Ms",
  llubi_ms: "llubiMs",
};

function readTimeouts(raw: unknown, source: string): TimeoutConfig {
  const section = (raw as Record<string, unknown> | undefined)?.timeouts;
  if (section === undefined) return {};
  if (typeof section !== "object" || section === null) {
    throw new Error(`${source}: timeouts must be an object`);
  }
  const timeouts: TimeoutConfig = {};
  for (const [key, value] of Object.entries(section as Record<string, unknown>)) {
    const name = TIMEOUT_KEYS[key];
    if (!name) throw new Error(`${source}: timeouts.${key} is not a timeout`);
    if (typeof value !== "number" || !Number.isInteger(value) || value <= 0) {
      throw new Error(`${source}: timeouts.${key} must be a positive whole number of ms`);
    }
    timeouts[name] = value;
  }
  return timeouts;
}
