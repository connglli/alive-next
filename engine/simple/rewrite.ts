// Moves that bring a goal's two sides closer, chosen by the diff: a move is
// tried off the session and certified only if it lowers the distance, the
// number of instructions where the two sides differ. The verified rules
// certify a src step by their own proofs, so trying them asks alive2 nothing.
import type { Llops } from "../core/drivers/llops.ts";
import type { Session } from "../core/session.ts";
import { distance } from "./regions.ts";
import { sameBody, withoutLoopIds } from "./windows.ts";

/** Steps the src of goal `gid` by the verified rules, if together they bring it closer. */
export async function stepRules(session: Session, llops: Llops, gid: string) {
  // A session without a rewriter has no rules to offer, and the move is only a help.
  const rules = (await session.rules().catch(() => [])).map((rule) => rule.name);
  if (rules.length === 0) return false;
  const preview = await session.rewritePreview(gid, "src", rules);
  if (preview.kind !== "preview") return false;
  // The session keeps canonical text, so the preview is measured as it would land.
  const canon = await llops.canon(preview.program);
  if (!canon.ok) return false;
  const { src, tgt } = await session.show(gid);
  const now = await measured(llops, src.text, tgt.text);
  if ((await measured(llops, canon.module, tgt.text)) >= now) return false;
  return (await session.rewrite(gid, "src", rules)).kind === "certified";
}

/**
 * The pipeline whose stages the src steps toward: the first function passes of
 * `default<O3>`, then `default<O3>`. It gives declared functions their attributes
 * before those passes promote private storage, so one of its stages can ask alive2
 * about both changes at once; run ahead of it, the passes promote storage under the
 * src's declarations.
 */
const STAGES =
  "function(lower-expect,simplifycfg,sroa<modify-cfg>,early-cse,callsite-splitting),default<O3>";

/**
 * Proposes canonical stages without removable body attributes, so later cuts
 * can outline them. Keeps body changes through the last stage closest to `tgt`.
 */
export async function stagesToward(llops: Llops, src: string, tgt: string) {
  const run = await llops.pipelineStages(src, STAGES);
  const stages: string[] = [];
  let [best, end] = [await measured(llops, src, tgt), 0];
  for (const stage of run.ok ? run.stages : []) {
    const clean = await llops.edit(stage.module, { op: "drop_attrs" });
    if (!clean.ok) continue;
    const canon = await llops.canon(withoutLoopIds(clean.module));
    const module = canon.ok ? canon.module : "";
    if (!canon.ok || sameBody(module, stages.at(-1) ?? src)) continue;
    stages.push(module);
    const far = await measured(llops, module, tgt);
    if (far <= best) [best, end] = [far, stages.length];
  }
  return stages.slice(0, end);
}

/** The distance between two programs' bodies, or Infinity when either cannot be read. */
async function measured(llops: Llops, src: string, tgt: string): Promise<number> {
  const [a, b] = await Promise.all([llops.number(src), llops.number(tgt)]);
  return a.ok && b.ok ? distance(a.body, b.body) : Number.POSITIVE_INFINITY;
}
