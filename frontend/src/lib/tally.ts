import type { SolveResponse } from "../api/types";

/**
 * The running tally's four totals, each net of its broken-commitment penalty.
 *
 * Contribution leaves penalties out, so on contribution alone the approved actions can
 * look better than the best possible plan while leaving a confirmed booking unserved.
 * Net of penalties is what the solver maximises, so here approved <= current <= best.
 */
export interface Tally {
  doNothing: number;
  best: number;
  current: number;
  approved: number;
  /** Gains against doing nothing. */
  bestGain: number;
  currentGain: number;
  approvedGain: number;
  /** Best possible minus the current plan: what the decisions so far are costing. */
  decisionsCost: number;
  /** Penalties already taken out of `current` and `approved`. */
  currentPenalty: number;
  approvedPenalty: number;
  /** Confirmed bookings the approved actions leave unserved on their own. */
  approvedBroken: number;
}

export function tallyOf(result: SolveResponse): Tally {
  const d = result.decision;
  const penaltyOf = (id: string) => result.strategies.find((s) => s.id === id)?.expected_penalty ?? 0;
  const currentPenalty = result.plan_result.expected_penalty;
  const approvedPenalty = d.approved_only_penalty ?? 0;
  const doNothing = d.do_nothing - penaltyOf("none");
  const best = d.best_possible - penaltyOf("joint");
  const current = d.current_plan - currentPenalty;
  const approved = d.approved_only - approvedPenalty;
  return {
    doNothing,
    best,
    current,
    approved,
    bestGain: best - doNothing,
    currentGain: current - doNothing,
    approvedGain: approved - doNothing,
    decisionsCost: best - current,
    currentPenalty,
    approvedPenalty,
    approvedBroken: d.approved_only_broken ?? 0,
  };
}
