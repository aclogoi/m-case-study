import type { Action, ActionType } from "../api/types";
import { signedPct } from "./format";

export const TYPE_LABEL: Record<ActionType, string> = { move: "Move", rate: "Rate", fee: "Drop fee", incentive: "Return incentive" };
export const MODE_LABEL = { staff: "Staff drive", hauler: "Hauler" } as const;

/** The tier or count an action sets, as short text. */
export function quantityText(a: Action): string {
  switch (a.type) {
    case "move":
      return `${a.count ?? 0} truck${a.count === 1 ? "" : "s"}`;
    case "rate":
      return `${signedPct(a.tier_pct ?? 0)} rate`;
    case "fee":
      return `+$${a.fee ?? 0} fee`;
    case "incentive":
      return `$${a.amount ?? 0} per return`;
  }
}

/** What an action costs to carry out, in the words of the person approving it. */
export function costParts(a: Action, changeCost: number): { total: number; note: string } {
  switch (a.type) {
    case "move":
      return { total: a.cost, note: a.mode === "hauler" ? "hauler fee" : "driver time and mileage" };
    case "incentive":
      return { total: a.cost + changeCost, note: `about $${Math.round(a.cost)} in payments + $${Math.round(changeCost)} change cost` };
    default:
      return { total: changeCost, note: "one-off change cost" };
  }
}

/** What refusing an action closes off, stated for the card. */
export function refusalEffect(
  a: Action,
  branchName: (id: string | null) => string,
  className: (id: string | null, n?: number) => string,
  /** Moves already approved on the same lane and class: a rejection does not take them back. */
  approvedOnLane = 0,
): string {
  switch (a.type) {
    case "move":
      return approvedOnLane > 0
        ? `Rejecting rules out any further ${className(a.class_id, 2)} going ${branchName(a.origin)} to ${branchName(a.dest)} this week, by staff drive or hauler. The ${approvedOnLane === 1 ? "move" : `${approvedOnLane} moves`} you already approved on that lane ${approvedOnLane === 1 ? "stays" : "stay"}.`
        : `Rejecting closes the ${branchName(a.origin)} to ${branchName(a.dest)} lane for ${className(a.class_id, 2)} this week, by staff drive or hauler.`;
    case "rate":
      return `Rejecting holds ${className(a.class_id)} rates at ${branchName(a.branch_id)} at today's level this week.`;
    case "fee":
      return `Rejecting keeps the drop fee into ${branchName(a.branch_id)} at $0 this week.`;
    case "incentive":
      return `Rejecting means no return incentive is offered at ${branchName(a.branch_id)} this week.`;
  }
}

/** The order decisions fall due: pricing changes (effective today), then moves by dispatch day. */
export function dueOrder(actions: Action[]): Action[] {
  const pricing = actions.filter((a) => a.type !== "move");
  const moves = actions.filter((a) => a.type === "move").sort((a, b) => (a.dispatch_day ?? 1) - (b.dispatch_day ?? 1));
  return [...pricing, ...moves];
}

/** Two moves share a lane when a rejection of one closes it for the other: same origin, destination and class. */
export function sameLane(a: Action, b: Action): boolean {
  return a.type === "move" && b.type === "move" && a.origin === b.origin && a.dest === b.dest && a.class_id === b.class_id;
}

/**
 * A close call: refusing would lose something, but little, either in absolute terms or
 * against what the action costs to carry out.
 */
export function isCloseCall(reduction: number, costToCarryOut: number): boolean {
  return reduction > 0.5 && reduction <= Math.max(50, 0.1 * costToCarryOut);
}
