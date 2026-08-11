// The configuration that describes the machine.
//
// Everything here runs offline, because a configuration file is all it reads.
import { describe, expect, test } from "bun:test";
import { rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfig, repoRoot } from "../core/config.ts";

const config = loadConfig();

/** A configuration file with the given body, for one test. */
function fileWith(name: string, body: string): string {
  const path = join(tmpdir(), `alive-next-${name}-${process.pid}.jsonc`);
  writeFileSync(path, body);
  return path;
}

function withFile<T>(name: string, body: string, use: (path: string) => T): T {
  const path = fileWith(name, body);
  try {
    return use(path);
  } finally {
    rmSync(path);
  }
}

describe("loadConfig", () => {
  test("reads a file this repository ships", () => {
    expect(config.source).toMatch(/config(\.example)?\.jsonc$/);
    expect(config.toolchain).not.toBe("");
  });

  test("rejects a file it cannot use", () => {
    expect(() => loadConfig("/nonexistent/config.jsonc")).toThrow(/no configuration/);
  });

  test("reads the example, whose commented options stay off", () => {
    const example = loadConfig(join(repoRoot(), "config.example.jsonc"));
    expect(example.timeouts).toEqual({});
    expect(example.toolchain).toBe(join(repoRoot(), "deps"));
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
    const body = `{ // a machine that keeps one toolchain for several checkouts
                    "toolchain": "/zdata/llvms" }`;
    withFile("toolchain", body, (path) => {
      expect(withoutEnv(() => loadConfig(path).toolchain)).toBe("/zdata/llvms");
    });
  });

  test("reads a relative toolchain as relative to the repository", () => {
    withFile("relative", '{ "toolchain": "./deps" }', (path) => {
      // Otherwise the same configuration would name a different directory
      // depending on where the process was started.
      expect(withoutEnv(() => loadConfig(path).toolchain)).toBe(join(repoRoot(), "deps"));
    });
  });

  test("falls back to deps in the repository", () => {
    withFile("default", "{}", (path) => {
      expect(withoutEnv(() => loadConfig(path).toolchain)).toBe(join(repoRoot(), "deps"));
    });
  });

  test("lets the environment name a toolchain for one run", () => {
    withFile("env", '{ "toolchain": "/from/file" }', (path) => {
      const saved = process.env.TOOLCHAIN;
      process.env.TOOLCHAIN = "/from/env";
      try {
        expect(loadConfig(path).toolchain).toBe("/from/env");
      } finally {
        if (saved === undefined) delete process.env.TOOLCHAIN;
        else process.env.TOOLCHAIN = saved;
      }
    });
  });

  test("refuses a toolchain that is not a path", () => {
    withFile("badtool", '{ "toolchain": 7 }', (path) => {
      expect(() => loadConfig(path)).toThrow(/toolchain must be a non-empty path/);
    });
  });

  test("reports where a file stops parsing", () => {
    withFile("broken", '{ "toolchain": "deps", \n', (path) => {
      expect(() => loadConfig(path)).toThrow(/does not parse/);
    });
  });
});

describe("a section this file does not carry", () => {
  test("names what it does carry", () => {
    withFile("typo", '{ "timeout": {} }', (path) => {
      expect(() => loadConfig(path)).toThrow(/this file carries toolchain, timeouts/);
    });
  });

  test("refuses one whatever it holds", () => {
    withFile("budget", '{ "budget": { "max_steps": 5 } }', (path) => {
      expect(() => loadConfig(path)).toThrow(/"budget" is not a section/);
    });
  });
});
