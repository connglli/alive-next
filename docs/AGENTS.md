# AGENTS.md — the documentation standard

How to write the prose that stays: the documents under `docs/`, the header comments that explain a design, the notes under [.agents/notes/](../.agents/notes/), and the commit messages that record a change. [AGENTS.md](../AGENTS.md) owns the engineering rules; this file owns the writing.

## Where a fact belongs

One fact, one home. A second copy is how the two drift apart.

* [docs/design.md](./design.md) holds the conceptual model and semantic mechanisms: what a program, goal, step, transaction, and certificate are; the core principle that the untrusted agent proposes while sound checkers certify; decomposition via outlining and step narrowing; interface strengthening; and argument assumptions.
* [docs/implementation.md](./implementation.md) holds the physical architecture and execution details: the TypeScript/C++ language split; toolchain layout and external checkers (alive-tv, llubi); state on disk under `sessions/<id>/` and `trajectory.jsonl`; the certificate package format and replay algorithm in `check.py`; the visualizer; configuration precedence; and build targets in Makefile.
* [docs/llops.md](./llops.md) holds the contract for the native C++ LLVM binary: the JSON-over-stdin/stdout protocol, exit codes, supported straightline program shape, value reference syntax (`%slot`, `%name`, `#index`), and every subcommand (`validate`, `canon`, `analyze`, `outline`, `inline`, `harness`, `edit`, `opt`).
* [docs/agent.md](./agent.md) holds the Pi agent wiring and runtime: custom tool registration and name prefixes (`run_`, `goal_`, `tx_`, `tree_`), sandbox confinement, execution model, session lifecycle, budget enforcement, system prompt, and provider or model configuration.
* [config.example.jsonc](../config.example.jsonc) holds the template for machine-local settings: toolchain locations, timeouts, and solver options.
* [.agents/notes/](../.agents/notes/) holds ephemeral rationale and design explorations: trade-off analyses in `designs/`, implementation plans in `implementations/`, and change records in `commits/` that do not belong in durable documentation.
* Source files and tests hold the live implementation, type definitions, and invariants: code comments explain why rather than what, and test suites define executable contracts for components.

## Writing rules

Write for a compiler engineer who has not read the code. Prefer plain English to metaphor. For the specification, it needs to be precise and complete.

Document the current state, not the change history. Avoid "previously", "now" and "no longer", and avoid citing commits, branches or review threads in durable prose; name the live mechanism instead. Change stories go in the commit that made them, and their reasoning in a note.

State the contract: what holds, under which conditions, and what happens when they do not.

One rule per paragraph. Emphasis marks the clause that changes behaviour and nothing else. Numbers carry their provenance, so "about 70% of seeds solve over the full type lattice" is a claim and "yields are good" is not.

## Use natural writing

Use [natural writing](https://github.com/flutter/flutter/blob/fdf8a01bd014798113aa59ac5b4fd3c30573d9eb/.agents/agents/reidbaker-agent/skills/natural-writing/SKILL.md). For example, avoid:

- Puffery ("a testament to", "a pivotal moment").
- Dangling commentary ("highlighting", "reflecting", "showcasing").
- Promotional verbs ("boasts", "features", "leverages", "ensures").
- Copula inflation ("serves as" where "is" is meant).
- Negative parallelism ("not only X but also Y").
- Three adjectives chosen for rhythm.
- False ranges, where "from X to Y" spans nothing.
- Elegant variation: repeat the name instead of finding a synonym.
- Weasel attribution ("it is generally accepted").
- A closing paragraph that speculates about future work; end on the last fact.
- Overused punctuation (curly/smart quotes and en- and em-dashes).

## Formatting

One physical line per paragraph. Use editor soft-wrap. Code blocks, tables, and list structure keep their formatting; code comments stay under the linter's column limit.

Sentence case headers. Plain `*` bullets, no emoji (unless in the top-level README.md). Straight quotes and apostrophes. Em dashes sparingly, since two on a page is already many; commas and parentheses do the same work.

No `* **Header:** description` lists. Tables only where the data is tabular: two facts are a sentence.

Code blocks carry LLVM IR, JSON payloads, a shell invocation, or a pipeline sketch, and have to be true. An IR snippet is something a reader will paste into `llops` or `alive-tv`.

Link with relative paths that resolve, as [docs/design.md](./design.md), never a bare filename.

## The slop checklist

Hunt these in any document you touch. Four are mechanical, so grep first: the temporal words ("now", "currently", "previously", "no longer", "used to"), a distinctive phrase from any rule you stated, `**` runs beyond a term's first mention, and a number with no measurement behind it.

* The same rule stated in two homes. Keep one, link the other.
* Narrated history in durable prose: "previously", "was renamed", a commit or branch cited as if it were a fact about the code.
* A war story told inline where one sentence of rule and a link to an implementation note would do.
* Status annotations in prose or diagrams: "implemented", "planned", "future work". Status rots; the repo layout and the spec's roadmap carry it.
* A hand-maintained inventory of rules, tests, options, or files that the tree already carries. Name where it lives instead.
* Reasoning transcripts: derivations, alternatives weighed, proof of the obvious branch, a walkthrough of a test. Keep the contract, move the rationale to a design note.
* The same rationale repeated beside each of several sibling functions. State it once, at the thing they share.
* Paragraph walls: one paragraph carrying several rules and a parenthetical aside. Split it, or demote the detail to the document that owns it.
* Emphasis inflation. Bold, CAPS and "critically" everywhere mean nothing stands out.
* A table built for two rows, or a bulleted list of one.
* Numbers with no provenance, and percentages whose denominator is not stated.

Two failures survive every grep, so read the diff for them: a paragraph that grew a second subject, and a passage explaining how you got there rather than what holds.

## Length

Relocate first, condense second, accept the length third. Review is the check; there is no budget script.
