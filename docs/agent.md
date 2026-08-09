# The agent: alive-next on Pi

The agent is the untrusted half of alive-next. It decides where to cut, which rewrite to try, and which counterexample to chase, and every one of those decisions passes through a certifying check before it counts, as [design.md](./design.md) sets out. Pi runs the loop, and alive-next supplies the tools that reach the goal tree.

Pi's coding agent is the harness, through its SDK: `createAgentSession` from `@earendil-works/pi-coding-agent`. What that buys is everything a long search needs and none of it verification-critical: context compaction, session branching, the interactive and RPC front ends, provider and model resolution, and a shell tool with the truncation and timeout behaviour already worked out.

## The tool set

`createAgentSession` takes the tools as data, so the surface the model sees is stated in one call rather than assembled by what happens to be installed. Our tools arrive as `customTools`, and `tools` is the allowlist of everything active, so a built-in that is not named is not there.

Active from Pi are `bash`, `read`, `write` and `grep`, which serve the scratch computation design.md's counterexample search asks for. Pi builds them for the `cwd` the session is created with, which is the run's scratch directory, so the shell starts where the agent is meant to work.

Inactive are Pi's `edit`, `ls` and `find`. `edit` would collide with the edit tool in design.md's catalog, whose ops rewrite IR inside a transaction, and a model that has both will eventually reach for the wrong one; `ls` and `find` are `bash` with more steps.

Ours are the rest of design.md's catalog, with the names it gives, declared with `defineTool` and TypeBox parameters. The eleven edit operations are one `edit` tool taking an `op` field rather than eleven tools, so they do not crowd out the tools that move a proof forward. llops validates the op and its arguments, so the tool passes them through.

A tool that fails throws, and Pi reports a thrown error to the model as a tool error, so a failure carries the diagnostic the agent needs to try something else. A rejected commit, a failed check and a refused edit are ordinary results, not errors: they say what happened and the run continues.

A tool result names what changed rather than reproducing it. A program a step created is named by its id with a summary of the diff, and the agent that wants the text asks for it with `show`. Whole modules in tool results would fill the context window long before a thousand-line program was cut into pieces.

Tools run sequentially, because they share one store and one goal tree, and two calls in a parallel batch would race on the state the second one reads.

## Why a shell is safe here

The agent can reach the session directory with `bash`, and that is not what protects a verdict. Programs are stored under the hash of their content and the trajectory is a hash chain, so tampering is evident on the next load; more to the point, a certificate is checked by replaying every step through alive-tv, so a record the agent has bent produces a package that fails replay rather than a wrong answer.

Isolation is hygiene rather than the soundness boundary. The session `cwd` is the scratch directory and the store lives outside it, so an agent that writes files writes them where it is supposed to.

## The session

Everything the framework can do to a proof goes through one object, `Session` in `src/session.ts`: it owns the session directory, appends the `tool_call` and `tool_result` lines, and rebuilds the goal tree by replaying the log after every move.

The agent does not appear in it: a scripted scenario and a model driving Pi's loop make the same moves through the same door, which is how [implementation.md](./implementation.md)'s end-to-end pairs are proved with no model in front of the framework.

Pi's own session object is a different thing, held by `src/agent.ts`, which is where the tools and the loop are wired up. One agent drives one `Session`.

## The wrapper

The tool lifecycle hooks the session exposes are where the framework holds the pen: the `tool_call` line goes to `trajectory.jsonl` before a tool runs and the `tool_result` line after it returns, both synchronously, so the record cannot be skipped or reordered by anything the agent does.

Certified steps are cross-checked inside the tool that made them rather than in a hook, because the outcome belongs to the result the agent reads: a commit that opens a proved goal says so in the same breath.

A verdict ends the run. The tool that discharges the root goal, or that certifies a counterexample, returns `terminate: true`, and the stop is repeated from `shouldStopAfterTurn`, because Pi honours the hint only when every result in a batch carries it.

`shouldStopAfterTurn` also carries the budget from the configuration, in steps and in seconds, and stops the loop when either is spent. The verdict is then "unknown", which is one of the three outputs and not a failure of the run.

## The system prompt

The prompt is replaced rather than extended, through the resource loader's `systemPromptOverride`, because Pi's default prompt describes a coding assistant and this agent is not one.

It states the rules of the game: what a goal is, what a certified step is, that the framework owns the direction of every check, and that a local counterexample is a hint until execution confirms it.

It does not describe the tools. Pi sends each tool's description and schema with every request, so a second copy in the prompt is a copy that drifts.

## Sessions

`trajectory.jsonl` is the source of truth, the goal tree is derived from it, and a resumed run replays the trajectory, which is the rule [implementation.md](./implementation.md) states for state on disk. Pi's session manager holds the message history for the run in memory and compaction rewrites it, which the framework records as an `auto` event, so the trajectory keeps the messages the model actually saw.

## Configuration

The model, the thinking level and the budget come from the resolved configuration, which `run_start` snapshots, so a trajectory says which model produced it. The provider key comes from the environment and never from the configuration file, so it cannot leak into the trajectory.
