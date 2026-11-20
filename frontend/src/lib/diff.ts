import type { Action } from "../api/types";

/** The quantity that can change while an action keeps its id (see API_CONTRACT "Action ids"). */
export function quantity(a: Action): number | null {
  switch (a.type) {
    case "move":
      return a.count;
    case "rate":
      return a.tier_pct;
    case "fee":
      return a.fee;
    case "incentive":
      return a.amount;
  }
}

export interface PlanDiff {
  added: Action[];
  removed: Action[];
  changed: { before: Action; after: Action }[];
  unchanged: Action[];
  /** True when the two plans are identical action for action. */
  same: boolean;
}

/** Diff two joint plans by action id. Computed in the browser; the backend is stateless. */
export function diffPlans(before: Action[], after: Action[]): PlanDiff {
  const prev = new Map(before.map((a) => [a.id, a]));
  const next = new Map(after.map((a) => [a.id, a]));
  const added = after.filter((a) => !prev.has(a.id));
  const removed = before.filter((a) => !next.has(a.id));
  const changed: PlanDiff["changed"] = [];
  const unchanged: Action[] = [];
  for (const a of after) {
    const b = prev.get(a.id);
    if (!b) continue;
    if (quantity(a) !== quantity(b)) changed.push({ before: b, after: a });
    else unchanged.push(a);
  }
  return { added, removed, changed, unchanged, same: added.length + removed.length + changed.length === 0 };
}
