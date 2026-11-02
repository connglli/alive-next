// Adapt the engine's replay to the data consumed by scripts/visualize_ui.js.
// The engine owns goal transitions; this module records their display history.
import { unifiedDiff } from "difflib";
import { applyEffect, derive, head, type Tree, verdict } from "../../engine/core/state/goals.ts";
import { type Effect, type Entry, parse } from "../../engine/core/state/trajectory.ts";
import type { ReportSource } from "./protocol.ts";

interface Version {
  id: string;
  gid: string;
  parent: string | null;
  src: string;
  tgt: string;
  at: number;
  tool: string;
  side: "src" | "tgt" | "both" | null;
  note: string | null;
}

function rows(entries: Entry[]) {
  const result: Entry[][] = [];
  for (let i = 0; i < entries.length; i++) {
    const entry = entries[i] as Entry;
    const next = entries[i + 1];
    if (entry.kind === "tool_call" && next?.kind === "tool_result" && next.id === entry.id) {
      result.push([entry, next]);
      i++;
    } else result.push([entry]);
  }
  return result;
}

function effects(entry: Entry): Effect[] {
  return "effects" in entry ? (entry.effects ?? []) : [];
}

function mentioned(entry: Entry) {
  const last = effects(entry).at(-1);
  if (last) return last.gid;
  const args = entry.kind === "tool_call" ? entry.args : undefined;
  return args && typeof args === "object" && "gid" in args && typeof args.gid === "string"
    ? args.gid
    : undefined;
}

function attributeNote(effect: Extract<Effect, { effect: "strengthen" }>) {
  const names = new Map<string, string[]>();
  for (const [param, attrs] of Object.entries(effect.param_attrs ?? {}).sort()) {
    for (const [name, value] of Object.entries(attrs).sort()) {
      if (value !== true) continue;
      names.set(name, [...(names.get(name) ?? []), `%${param}`]);
    }
  }
  return (
    [...names]
      .sort()
      .map(([name, params]) => `+${name} ${params.join(" ")}`)
      .join(" ") || null
  );
}

function label(row: Entry[]) {
  const entry = row[0] as Entry;
  const effectText = (event: Entry) =>
    effects(event)
      .map((e) => `${e.effect} ${e.gid}`)
      .join(", ");
  if (entry.kind === "verdict") return `verdict ${entry.outcome}`;
  if (entry.kind === "framework") {
    const change = effectText(entry);
    return `framework ${entry.action}${change ? ` -> ${change}` : ""}`;
  }
  if (entry.kind !== "tool_call") return entry.kind;
  // The native timeline uses Python's ASCII-escaped compact JSON for arguments.
  const args =
    entry.args == null || JSON.stringify(entry.args) === "{}"
      ? ""
      : JSON.stringify(entry.args).replace(
          /[\u007f-\uffff]/g,
          (char) => `\\u${char.charCodeAt(0).toString(16).padStart(4, "0")}`,
        );
  const call = `${entry.tool}(${args.length > 60 ? `${args.slice(0, 59)}…` : args})`;
  return row[1] ? `${call} -> ${effectText(row[1]) || "no change"}` : `${call} ...`;
}

function lines(text: string) {
  // Match Python splitlines for the canonical LLVM text, omitting the final terminator.
  return text ? text.replace(/\r\n/g, "\n").replace(/\n$/, "").split("\n") : [];
}

export function visualizerData(source: ReportSource) {
  const grouped = rows(parse(source.trajectory.join("")));
  if (!grouped.length) throw new Error("The session has no recorded events yet");
  let tree: Tree | undefined;
  const nodes: Version[] = [];
  const current = new Map<string, string>();
  const proofs: { gid: string; hash: string; fn: string }[] = [];
  const snapshots: Record<
    string,
    { status: string; node: string; role: string | null; parent: string | null }
  >[] = [];
  const focus: (string | null)[] = [];
  let about: string | undefined;

  const version = (
    gid: string,
    parent: string | null,
    at: number,
    tool: string,
    side: Version["side"] = null,
    note: string | null = null,
  ) => {
    const goal = tree?.goals.get(gid);
    if (!goal) throw new Error(`Missing goal ${gid}`);
    const id = `n${nodes.length}`;
    nodes.push({
      id,
      gid,
      parent,
      src: head(goal, "src"),
      tgt: head(goal, "tgt"),
      at,
      tool,
      side,
      note,
    });
    current.set(gid, id);
  };

  for (const [at, row] of grouped.entries()) {
    const before = nodes.length;
    for (const entry of row) {
      if (entry.kind === "start") {
        if (tree) throw new Error("The trajectory contains a second start");
        tree = derive([entry]);
        version(tree.root, null, at, "start");
      }
      for (const effect of effects(entry)) {
        if (!tree) throw new Error("A goal changed before the session started");
        const parent = current.get(effect.gid) ?? null;
        applyEffect(tree, effect);
        const tool = "tool" in entry ? entry.tool : entry.kind;
        switch (effect.effect) {
          case "step":
            version(
              effect.gid,
              parent,
              at,
              tool,
              effect.side,
              effect.rules?.length
                ? effect.rules.join(",")
                : effect.by === "alive2"
                  ? null
                  : (effect.by ?? null),
            );
            break;
          case "revert":
            version(effect.gid, parent, at, "revert", effect.side);
            break;
          case "strengthen": {
            version(effect.gid, parent, at, "strengthen", "both", attributeNote(effect));
            const goal = tree.goals.get(effect.gid);
            if (goal?.role === "callee") {
              for (const link of effect.by ?? []) {
                const fn = link.gid === goal.id ? goal.detach?.hypothesis : goal.callee;
                if (fn) proofs.push({ ...link, fn });
              }
            }
            break;
          }
          case "cut":
          case "case":
          case "interpose":
            for (const id of tree.goals.get(effect.gid)?.children ?? []) {
              const goal = tree.goals.get(id);
              const kind =
                effect.effect === "cut"
                  ? `cut(${effect.detach ? "detach" : "outline"})`
                  : effect.effect;
              const note =
                goal?.role === "callee" && goal.detach?.hypothesis
                  ? `hypothesis @${goal.detach.hypothesis}`
                  : null;
              version(id, parent, at, `${kind} ${goal?.role}`, null, note);
            }
            break;
        }
      }
      about = mentioned(entry) ?? about;
    }
    const snapshot = Object.fromEntries(
      [...(tree?.goals.values() ?? [])].map((goal) => [
        goal.id,
        {
          status: goal.status,
          node: current.get(goal.id) as string,
          role: goal.role ?? null,
          parent: goal.parent ?? null,
        },
      ]),
    );
    snapshots.push(snapshot);
    focus.push(
      nodes.length > before
        ? (nodes.at(-1)?.id ?? null)
        : (about && snapshot[about]?.node) || focus.at(-1) || null,
    );
  }
  if (!tree) throw new Error("The session has no start event");

  for (const proof of proofs) {
    const node = nodes.find(
      (node) => node.gid === proof.gid && node.side === "src" && node.src === proof.hash,
    );
    if (node) node.note = `contract before @${proof.fn}`;
  }
  const recorded = grouped.flat().findLast((entry) => entry.kind === "verdict");
  const outcome = verdict(tree);
  if (recorded?.kind === "verdict" && recorded.outcome !== outcome)
    throw new Error("The recorded verdict disagrees with the replayed goal tree");

  const programs: Record<string, string> = {};
  for (const node of nodes)
    for (const hash of [node.src, node.tgt]) {
      const text = source.programs[hash];
      if (text === undefined) throw new Error(`Missing program ${hash}`);
      programs[hash] = text;
    }
  const byId = new Map(nodes.map((node) => [node.id, node]));
  const diffs = Object.fromEntries(
    nodes.map((node) => {
      const parent = node.parent ? byId.get(node.parent) : undefined;
      const pair = Object.fromEntries(
        (["src", "tgt"] as const).map((side) => {
          const birth = !parent || parent.gid !== node.gid;
          const changed = birth || parent[side] !== node[side];
          const diff =
            birth || !changed
              ? []
              : unifiedDiff(
                  lines(programs[parent[side]] as string),
                  lines(programs[node[side]] as string),
                  { n: 3, lineterm: "" },
                ).slice(2);
          return [
            side,
            {
              changed,
              ...(birth ? { birth: true } : {}),
              lines: diff,
              adds: diff.filter((line) => line.startsWith("+")).length,
              dels: diff.filter((line) => line.startsWith("-")).length,
            },
          ];
        }),
      );
      return [node.id, pair];
    }),
  );

  return {
    verdict: outcome,
    error: null,
    nodes,
    snapshots,
    pnames: Object.fromEntries(tree.programs),
    programs,
    diffs,
    events: grouped.map((row, at) => {
      const first = row[0] as Entry;
      const last = row.at(-1) as Entry;
      return {
        kind: first.kind === "tool_call" ? first.tool : first.kind,
        label: label(row),
        ...("ms" in last ? { ms: last.ms } : {}),
        focus: focus[at],
        entries: row,
      };
    }),
  };
}
