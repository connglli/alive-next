// Choosing the model a run talks to.
//
// Pi owns the models and the credentials, in the files it already keeps them
// in, so there is nothing here that reads or writes either. What is here is
// the choosing: the command line for one run, over whatever Pi would pick for
// itself.
import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import type { ThinkingLevel } from "@earendil-works/pi-agent-core";
import type { Api, Model } from "@earendil-works/pi-ai";
import {
  createAgentSessionServices,
  getAgentDir,
  type InlineExtension,
  type ModelRuntime,
  resolveCliModel,
} from "@earendil-works/pi-coding-agent";
import { repoRoot } from "../core/config.ts";

export const THINKING_LEVELS: ThinkingLevel[] = [
  "off",
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
];

/**
 * The project's own extensions, which is where a provider it declares lives.
 * Named rather than discovered: Pi looks for them beside the shell's working
 * directory, which for a run is the scratch directory, and `noExtensions`
 * drops what is found on the machine while keeping what a caller names. Naming
 * them means listing them, which is the layout Pi documents for a project,
 * `.pi/extensions/<name>.ts` and `.pi/extensions/<name>/index.ts`.
 */
export function findProjectExtensions(project: string): string[] {
  const dir = join(project, ".pi", "extensions");
  if (!existsSync(dir)) return [];
  const found: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.isFile() && entry.name.endsWith(".ts")) found.push(join(dir, entry.name));
    if (entry.isDirectory()) {
      const index = join(dir, entry.name, "index.ts");
      if (existsSync(index)) found.push(index);
    }
  }
  return found.sort();
}

/** What a run loads from the machine, which is the prompt and nothing else. */
export function createResourceOptions(
  project: string,
  systemPrompt?: string,
  extensionFactories: InlineExtension[] = [],
) {
  return {
    systemPrompt,
    extensionFactories,
    additionalExtensionPaths: findProjectExtensions(project),
    noExtensions: true,
    noSkills: true,
    noPromptTemplates: true,
    noThemes: true,
    noContextFiles: true,
  };
}

/**
 * Pi's models and credentials, from the files Pi keeps them in, plus whatever
 * this project's extensions declare. A provider of one's own, a local Ollama
 * or a vLLM among them, is declared to Pi rather than to us: to a machine in
 * `~/.pi/agent/models.json`, to a project in `.pi/extensions/`. Both are what
 * `pi` itself reads, so one declaration serves it and this engine alike.
 *
 * Building it through Pi's own services is what applies those declarations, so
 * the runtime a model is chosen from is the one that will stream it.
 */
export async function modelRuntime(project: string = repoRoot()): Promise<ModelRuntime> {
  const services = await createAgentSessionServices({
    cwd: project,
    agentDir: getAgentDir(),
    resourceLoaderOptions: createResourceOptions(project),
  });
  return services.modelRuntime;
}

/** What one run asked for, all optional, all from the command line. */
export interface AskedModel {
  /** `provider/id`, a bare id, or either with a `:level` suffix. */
  model?: string;
  /** Which provider a bare id meant, when more than one offers it. */
  provider?: string;
  thinking?: ThinkingLevel;
}

export interface ChosenModel {
  /** Nothing when the run asked for nothing, which leaves it to the settings. */
  model?: Model<Api>;
  thinkingLevel?: ThinkingLevel;
}

/**
 * The model a run asked for. Throws when this machine cannot reach it, naming
 * what it could have meant, because that mistake should surface before a run
 * starts rather than as a confusing error on the first turn.
 */
export function chooseModel(runtime: ModelRuntime, asked: AskedModel): ChosenModel {
  if (!asked.model && !asked.provider) return { thinkingLevel: asked.thinking };

  const chosen = resolveCliModel({
    cliModel: asked.model,
    cliProvider: asked.provider,
    cliThinking: asked.thinking,
    modelRuntime: runtime,
  });
  if (chosen.error || !chosen.model) {
    throw new Error(chosen.error ?? `no model matches ${asked.model}`);
  }
  return { model: chosen.model, thinkingLevel: chosen.thinkingLevel ?? asked.thinking };
}

/**
 * Every model this machine can reach, as lines. Availability needs the
 * credentials, so a provider with no key of any kind is absent rather than
 * listed and unusable.
 */
export async function listAvailableModels(runtime: ModelRuntime): Promise<string[]> {
  const available = await runtime.getAvailable();
  return available.map((model) => `${model.provider}/${model.id}`).sort();
}
