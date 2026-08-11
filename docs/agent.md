# The agent: alive-next on Pi

The agent is the untrusted half of alive-next. It decides where to cut, which rewrite to try, and which counterexample to chase, and every one of those decisions passes through a certifying check before it counts, as [design.md](./design.md) sets out. Pi runs the loop, and alive-next supplies the tools that reach the goal tree.

Pi's coding agent is the harness, through its SDK: `createAgentSessionRuntime` from `@earendil-works/pi-coding-agent`. What that buys is everything a long search needs and none of it verification-critical: context compaction, session branching, the interactive and RPC front ends, provider and model resolution, and a shell tool with the truncation and timeout behaviour already worked out.

A runtime rather than a bare session, because a runtime is what Pi's run modes take. `engine/agent/agent.ts` builds one and draws nothing itself, so how a run is watched is the caller's choice.

## The tool set

`createAgentSessionFromServices` takes the tools as data, so the surface the model sees is stated in one call rather than assembled by what happens to be installed. Our tools arrive as `customTools`, and `tools` is the allowlist of everything active, so a built-in that is not named is not there.

Active are `bash`, `read`, `write`, `edit`, `grep`, `ls` and `find`, the tools of the counterexample search's scratch computation, which [design.md](./design.md) defines. They are ours, in `tools/sandbox.ts`, because each one is confined to the run's scratch directory.

Ours also include the rest of design.md's catalog, declared with `defineTool` and TypeBox parameters, under names that carry the prefix of what the move acts on: `run_` the run as a whole (`run_status`, `run_report_cex`, `run_give_up`), `goal_` one goal (`goal_show`, `goal_analyze`, `goal_check`, `goal_revert`), `tx_` the open transaction (`tx_begin`, `tx_edit`, `tx_commit`, `tx_abort`), `tree_` the shape of the goal tree (`tree_split`, `tree_unsplit`, `tree_strengthen`). Two things follow. No name of ours can collide with one of Pi's, today or when Pi grows a tool, so the surface stays stated rather than negotiated. And a model reaching for the `edit` it has been trained on in every other harness does not land on the tool that rewrites IR under a transaction, which is `tx_edit` and answers to nothing else.

The prefixes stop at this layer. The session's moves keep design.md's bare names and so does the trajectory, since a record of what a proof did should read the same whether a model or a script drove it.

The eleven edit operations are one `tx_edit` tool taking an `op` field rather than eleven tools, so they do not crowd out the tools that move a proof forward. llops validates the op and its arguments, so the tool passes them through. The op union is declared with a top-level `type: "object"` beside it: every branch is an object already, but a provider that validates a tool's schema reads the top level and refuses a bare `anyOf` before the run has said anything.

A tool that fails throws, and Pi reports a thrown error to the model as a tool error, so a failure carries the diagnostic the agent needs to try something else. A rejected commit, a failed check and a refused edit are ordinary results, not errors: they say what happened and the run continues.

A tool result is the whole of what the agent knows, since there is no state it can see between calls. Two rules follow, and they are the same rule about what a result is worth carrying.

A result carries the text of a program exactly when the agent is about to name values inside it: opening a transaction, an edit that applied, and an edit that was refused. Every other result names programs by their id, and the agent that wants one asks for it with `goal_show`. Whole modules in every result would fill the context window long before a thousand-line program was cut into pieces.

A result opens with SUCCESS or FAILURE, which says whether the move did what it was asked to do rather than whether the framework worked: a refused edit, a rejected commit and a check that did not prove are all failures to advance, and what follows each of them says why.

A result carries the goal tree exactly when the move changed it, which is what the effects the move recorded say. A read, a refusal and every move inside a transaction change nothing and repeat nothing; a cut, a step, a discharge and a revert answer with the tree they left behind, since the goal to work on next is chosen from it.

Tools run sequentially, because they share one store and one goal tree, and two calls in a parallel batch would race on the state the second one reads.

## The session

Everything the framework can do to a proof goes through one object, `Session` in `engine/core/session.ts`: it owns the session directory, appends the `tool_call` and `tool_result` lines, and rebuilds the goal tree by replaying the log after every move.

The agent does not appear in it: a scripted scenario and a model driving Pi's loop make the same moves through the same door, which is how [implementation.md](./implementation.md)'s end-to-end pairs are proved with no model in front of the framework.

Pi's own session object is a different thing, held by `engine/agent/agent.ts`, which is where the tools and the loop are wired up. One agent drives one `Session`.

## The wrapper

The tool lifecycle hooks the session exposes are where the framework holds the pen: the `tool_call` line goes to `trajectory.jsonl` before a tool runs and the `tool_result` line after it returns, both synchronously, so the record cannot be skipped or reordered by anything the agent does.

Certified steps are cross-checked inside the tool that made them rather than in a hook, because the outcome belongs to the result the agent reads: a commit that opens a proved goal says so in the same breath.

A verdict ends the run. The tool that discharges the root goal, or that certifies a counterexample, returns `terminate: true`, and the stop is repeated from `shouldStopAfterTurn`, because Pi honours the hint only when every result in a batch carries it.

`shouldStopAfterTurn` also carries the budget, in steps and in seconds, and stops the loop when either is spent. The verdict is then "unknown", which is one of the three outputs and not a failure of the run. A budget is a per-run choice, so `--max-steps` and `--max-seconds` set it and a run is unbounded without them.

## The system prompt

The prompt is replaced rather than extended, through the resource loader's `systemPrompt`, because Pi's default prompt describes a coding assistant and this agent is not one.

It states the rules of the game: what a goal is, what a certified step is, that the framework owns the direction of every check, and that a local counterexample is a hint until execution confirms it.

It does not describe the tools. Pi sends each tool's description and schema with every request, so a second copy in the prompt is a copy that drifts.

## Sessions

`trajectory.jsonl` is the source of truth, the goal tree is derived from it, and a resumed run replays the trajectory, which is the rule [implementation.md](./implementation.md) states for state on disk. Pi's session manager holds the message history for the run in memory and compaction rewrites it, which the framework records as an `auto` event, so the trajectory keeps the messages the model actually saw.

## Watching a run

`engine/agent/main.ts` draws a run one way: Pi's `InteractiveMode`, its TUI, which takes the session runtime and brings the transcript, the model picker and `/login` with it. What a watcher sees there is in the trajectory too, so a run that was not watched loses nothing.

A caller that wants the loop without a screen has `createAgent`, whose `prove` works until the run settles and says how it went. `agent.ts` builds a session runtime and draws nothing, so drawing stays the entry point's business.

A run sends its opening turn as it opens, which is what makes it a run. `--pause` puts that turn in the editor unsent instead, so the screen where a model is picked and a thinking level is set is reached before anything is spent. It is written there from the `session_start` handler, since Pi fires that once its screen is up, which is the first moment there is an editor to write to.

A certificate is earned the moment the goal tree settles, which under the TUI is long before the process ends. The run is therefore concluded from the callback the loop fires when it stops, and the summary is held until the terminal belongs to the shell again.

A run with no model to talk to is assembled all the same, because the TUI is where a machine without one is set up: `/login` stores a key and `/model` picks what to prove with. What that costs is the first turn, which fails saying so.

## Configuration

Nothing about a model is configured here. Pi has a machine layer and a project layer already, and the engine uses both rather than adding a third.

- `~/.pi/agent/` is the machine: `auth.json` for credentials, an API key per provider and OAuth tokens for the providers that use them, which `/login` writes and Pi keeps `0600`; `models.json` for providers the machine can reach; `settings.json` for personal defaults.
- `.pi/` in the repository is the project: `extensions/` for providers this checkout proves with, `settings.json` for which of them is the default. Pi reads it for `pi` run in this repository, and the engine names the same paths, so one declaration serves either. It is gitignored, because which models a machine can reach is a fact about that machine.
- `--model`, `--provider` and `--thinking` choose for one run, over both. They resolve through Pi's own `resolveCliModel`, so `provider/id`, a bare id and a `:level` suffix mean here what they mean in `pi`, ambiguity errors included.

A local server, Ollama or vLLM or llama.cpp, is a provider like any other. For a machine it goes in `~/.pi/agent/models.json`, which is what Pi's [models guide](../engine/node_modules/@earendil-works/pi-coding-agent/docs/models.md) documents. For one checkout it goes in `.pi/extensions/`, because Pi reads models from one file per machine and has no project counterpart, so a project declares a provider as an extension instead:

```typescript
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

export default function (pi: ExtensionAPI) {
  pi.registerProvider("ollama", {
    baseUrl: "http://127.0.0.1:11434/v1",
    api: "openai-completions",
    apiKey: "ollama", // a local server ignores it, and Pi sends nothing without one
    models: [{ id: "qwen3:0.6b", name: "qwen3:0.6b", reasoning: false, input: ["text"],
               cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
               contextWindow: 32768, maxTokens: 4096 }],
  });
}
```

[Pi's custom-provider guide](../engine/node_modules/@earendil-works/pi-coding-agent/docs/custom-provider.md) is the reference for the rest of that shape.

The project layer is read from the repository rather than from the session `cwd` Pi would find it beside, because that `cwd` is the run's scratch directory. `noExtensions` drops everything discovered on the machine and keeps what a caller names, so a run loads this repository's extensions and nothing else.

Pi's services are built once per command, in `createServices`, because a project's providers are known only once its extensions have loaded and a model has to be chosen before a run starts. The runtime a model is chosen from is therefore the one that streams it.

Credentials stay out of the repository entirely, for the reason the shell section gives: a key is per person and lasts, a model choice is per checkout and does not.

`config.jsonc` holds the toolchain and the timeouts, which describe the machine and change rarely. What changes per run is named on the command line.

Which model produced a run is on every assistant message the trajectory records, so nothing states it a second time. The TUI can switch models mid-run, and a single record of the model would go stale the moment it did.
