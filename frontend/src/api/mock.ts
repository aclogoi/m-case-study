// Hand-written mock of the backend, used when VITE_USE_MOCK=1.
//
// It is a toy, not the optimizer: a handful of fixed opportunities (shortages at New
// Haven and Boston, idle moving trucks at Portland, scarce box trucks in New York,
// one-way drain into Portland, returns due at Hartford) are each priced with the
// contract's formulas, and an action is proposed when its net effect is positive.
// Decisions work as in the contract: an approved action is held exactly as approved,
// a rejected one is forbidden and the rest of the plan is rebuilt around it.
// Every reported number is derived from the chosen effects, so the responses are
// internally consistent by construction: bridge start + deltas = end, week 1 + week 2
// = total, branch revenues sum to network revenue, situation totals are the sums of
// the inventory columns.

import type {
  Action,
  ActionValue,
  ApprovedAction,
  Booking,
  Branch,
  BranchScorecard,
  BridgeKey,
  CaseInfo,
  Components,
  ExplainBatchRequest,
  ExplainBatchResponse,
  ExplainRequest,
  ExplainResponse,
  InventoryRow,
  Lane,
  ParamOverrides,
  Params,
  ReportedBooking,
  Scenario,
  ScenarioId,
  SituationTotals,
  SolveRequest,
  SolveResponse,
  StrategyId,
  StrategyResult,
  VehicleClass,
} from "./types";

const r2 = (n: number) => Math.round(n * 100) / 100;
const r4 = (n: number) => Math.round(n * 10000) / 10000;
const sleep = (ms: number) => new Promise((res) => setTimeout(res, ms));

// ------------------------------------------------------------- static data

const START_DATE = "2026-11-23";
const DAY_NAMES = ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday"];
const dayName = (d: number) => DAY_NAMES[(d - 1) % 7];

const BRANCHES: Branch[] = [
  { id: "NYC", name: "New York City, NY", short_name: "New York", lat: 40.71, lon: -74.01, nearest_branch_id: "NHV", role: "Largest demand; one-way moving trucks drain outward" },
  { id: "BOS", name: "Boston, MA", short_name: "Boston", lat: 42.36, lon: -71.06, nearest_branch_id: "HFD", role: "High demand; drains toward Portland" },
  { id: "HFD", name: "Hartford, CT", short_name: "Hartford", lat: 41.77, lon: -72.67, nearest_branch_id: "NHV", role: "Idle box trucks accumulate" },
  { id: "NHV", name: "New Haven, CT", short_name: "New Haven", lat: 41.31, lon: -72.92, nearest_branch_id: "HFD", role: "Short of box trucks midweek; about 40 miles from Hartford" },
  { id: "PWM", name: "Portland, ME", short_name: "Portland", lat: 43.66, lon: -70.26, nearest_branch_id: "BOS", role: "Accumulates moving trucks; low local demand; far from New York" },
];
const BR: Record<string, Branch> = Object.fromEntries(BRANCHES.map((b) => [b.id, b]));

const CLASSES: VehicleClass[] = [
  { id: "box16", name: "16 ft box truck", short_name: "box truck", daily_rate: 110 },
  { id: "mov26", name: "26 ft moving truck", short_name: "moving truck", daily_rate: 160 },
];
const CL: Record<string, VehicleClass> = Object.fromEntries(CLASSES.map((c) => [c.id, c]));

const MILES: Record<string, number> = {
  "NYC-BOS": 228, "NYC-HFD": 120, "NYC-NHV": 84, "NYC-PWM": 334, "BOS-HFD": 110,
  "BOS-NHV": 144, "BOS-PWM": 122, "HFD-NHV": 41, "HFD-PWM": 228, "NHV-PWM": 262,
};
const miles = (a: string, b: string) => MILES[`${a}-${b}`] ?? MILES[`${b}-${a}`];

const DEFAULT_PARAMS: Params = {
  horizon_days: 14,
  dispatch_days: 5,
  local_duration_days: 2,
  oneway_duration_days: 3,
  variable_cost_pct: 0.15,
  hauler_load_fee: 150,
  hauler_per_mile: 2.5,
  hauler_transit_days: 2,
  staff_hourly: 35,
  staff_per_mile: 0.8,
  staff_speed_mph: 45,
  staff_max_miles: 150,
  staff_max_per_branch_day: 2,
  staff_transit_days: 1,
  rate_tiers: [-0.2, -0.1, 0, 0.1],
  elasticity_default: -1.2,
  elasticity_by_branch: { PWM: -1.8 },
  fee_tiers: [0, 50, 100],
  fee_deterrence: [0, 0.15, 0.3],
  fee_divert_share: 0.4,
  incentive_tiers: [0, 40, 80],
  incentive_uptake: [0, 0.25, 0.5],
  change_cost: 50,
  broken_commitment_penalty: 1000,
  scenarios: [
    { id: "low", label: "Low demand", scale: 0.8, weight: 0.25 },
    { id: "base", label: "Base demand", scale: 1.0, weight: 0.5 },
    { id: "high", label: "High demand", scale: 1.2, weight: 0.25 },
  ],
  elasticity_scale: 1,
  fee_deterrence_scale: 1,
  incentive_uptake_scale: 1,
  move_cost_multiplier: 1,
  time_limit_s: 5,
};

const staffCost = (m: number, p: Params) => (2 * m) / p.staff_speed_mph * p.staff_hourly + 2 * m * p.staff_per_mile;
const haulerCost = (m: number, p: Params) => p.hauler_load_fee + m * p.hauler_per_mile;

const LANES: Lane[] = BRANCHES.flatMap((a) =>
  BRANCHES.filter((b) => b.id !== a.id).map((b) => {
    const m = miles(a.id, b.id);
    const allowed = m <= DEFAULT_PARAMS.staff_max_miles;
    return {
      origin: a.id,
      dest: b.id,
      miles: m,
      staff_allowed: allowed,
      staff_cost: allowed ? r2(staffCost(m, DEFAULT_PARAMS)) : null,
      hauler_cost: r2(haulerCost(m, DEFAULT_PARAMS)),
    };
  }),
);

/** `pricing: false` means the case's data leaves no pricing opportunity worth its change cost. */
const CASES: (CaseInfo & { moveMult: number; pricing: boolean })[] = [
  { id: "default", label: "Default network", description: "Hartford to New Haven is fixed by a short staff drive; Portland is fixed by pricing because hauling back is expensive.", moveMult: 1, pricing: true },
  { id: "high_move_cost", label: "High move cost", description: "Every intervention costs more than it creates, so the plan has no actions.", moveMult: 8, pricing: false },
  { id: "joint_equals_moves", label: "Pricing adds nothing", description: "Pricing is made unattractive, so the tool recommends moving trucks and leaves prices alone: using both levers earns no more than moves on their own.", moveMult: 1, pricing: false },
];

function caseOf(id: string) {
  const c = CASES.find((x) => x.id === id);
  if (!c) throw new MockHttpError(404, `Unknown case '${id}'`);
  return c;
}

export class MockHttpError extends Error {
  constructor(public status: number, message: string) {
    super(message);
  }
}

function caseParams(caseId: string): Params {
  return { ...DEFAULT_PARAMS, move_cost_multiplier: caseOf(caseId).moveMult };
}

function effectiveParams(caseId: string, o: ParamOverrides): Params {
  const p = caseParams(caseId);
  for (const [k, v] of Object.entries(o)) {
    if (v !== null && v !== undefined) (p as unknown as Record<string, number>)[k] = v;
  }
  return p;
}

// Do-nothing position per branch before any reported booking: revenue and rented
// truck-days over the horizon, and assigned fleet (both classes).
const BASE: Record<string, { revenue: number; days: number; fleet: number }> = {
  NYC: { revenue: 58400, days: 448, fleet: 40 },
  BOS: { revenue: 41300, days: 315, fleet: 30 },
  HFD: { revenue: 16900, days: 121, fleet: 16 },
  NHV: { revenue: 17200, days: 131, fleet: 12 },
  PWM: { revenue: 14400, days: 90, fleet: 14 },
};

// ------------------------------------------------------------------ effects

/** A change to the daily position of one branch and class under the plan. */
interface InvAdj {
  b: string;
  c: string;
  on: (day: number) => boolean;
  unmet?: number; // added to rentals turned away (negative = fewer)
  unmetScale?: number;
  idle?: number;
}

interface Effect {
  action: Action;
  family: "move" | "pricing";
  /** Change in each component's magnitude (a cost that rises is positive). */
  comp: Components;
  branch: Record<string, { revenue: number; days: number }>;
  rentals: number;
  /** Share of the net effect that lands in week 1. */
  w1: number;
  /** Low / base / high multipliers on the net effect; weighted 25/50/25 they average 1. */
  scen: [number, number, number];
  inv: InvAdj[];
  move?: { need: Need; gained: number; lost: number };
}

const zeroComp = (): Components => ({ rental_revenue: 0, fee_revenue: 0, variable_cost: 0, incentive_payments: 0, transport_cost: 0, change_cost: 0 });
const netOf = (c: Components) => c.rental_revenue + c.fee_revenue - c.variable_cost - c.incentive_payments - c.transport_cost - c.change_cost;

const nullAction = {
  decision: "proposed" as const,
  origin: null, dest: null, mode: null, dispatch_day: null, arrival_day: null, count: null,
  branch_id: null, class_id: null, tier_pct: null, fee: null, amount: null, from_branch_id: null, expected_redirects: null,
};

const usd0 = (n: number) => `$${Math.round(n).toLocaleString("en-US")}`;
const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`;

interface Ctx {
  caseId: string;
  p: Params;
  added: ReportedBooking[];
  approved: Map<string, ApprovedAction>;
  rejected: Set<string>;
  /** One more action refused, for explain: un-fixed if it was approved, and forbidden. */
  forbid?: string;
}

const refused = (ctx: Ctx) => (ctx.forbid ? [...ctx.rejected, ctx.forbid] : [...ctx.rejected]);
const approvedOf = (ctx: Ctx, id: string) => (ctx.forbid === id ? undefined : ctx.approved.get(id));
const held = (ctx: Ctx, id: string) => ctx.rejected.has(id) || ctx.forbid === id;
/** A refused move closes its lane and class for both modes and every dispatch day. */
const laneClosed = (ctx: Ctx, origin: string, dest: string, cls: string) => refused(ctx).some((id) => id.startsWith(`move:${origin}>${dest}:${cls}:`));

const reportedAt = (added: ReportedBooking[], branch: string, cls: string) =>
  added.filter((b) => b.branch_id === branch && b.class_id === cls).reduce((s, b) => s + b.count, 0);

// ---- moves

/** A shortage a move can cover: `gain` rentals per truck delivered, up to `trucks`. */
interface Need {
  dest: string;
  cls: string;
  trucks: number;
  gain: number;
  dispatch: number;
  shortageDays: number[];
  /** Donors in order of preference, with the rentals each donated truck costs them. */
  sources: { origin: string; lost: number }[];
}

const NEEDS: Need[] = [
  { dest: "BOS", cls: "mov26", trucks: 2, gain: 3, dispatch: 1, shortageDays: [2, 3, 4], sources: [{ origin: "PWM", lost: 0.5 }] },
  { dest: "NHV", cls: "box16", trucks: 2, gain: 5, dispatch: 2, shortageDays: [3, 4, 5, 10, 11], sources: [{ origin: "HFD", lost: 1 }, { origin: "NYC", lost: 1.5 }] },
];

const moveId = (need: Need, origin: string) => `move:${origin}>${need.dest}:${need.cls}:staff:d${need.dispatch}`;

/** Hartford has two spare box trucks; a booking reported there claims them. */
const hfdSpare = (ctx: Ctx) => Math.max(0, 2 - reportedAt(ctx.added, "HFD", "box16"));

/** Staff drive of `count` trucks, of which `useful` still meet demand at the receiver. */
function moveEffect(need: Need, src: Need["sources"][number], count: number, useful: number, ctx: Ctx): Effect {
  const p = ctx.p;
  const cls = CL[need.cls];
  const rate = cls.daily_rate;
  const m = miles(src.origin, need.dest);
  // A truck Hartford no longer has spare takes six rentals with it, not one.
  const spare = src.origin === "HFD" ? hfdSpare(ctx) : count;
  const lost = Math.min(count, spare) * src.lost + Math.max(0, count - spare) * 6;
  const gained = need.gain * useful;
  const gainDays = gained * 2;
  const lostDays = lost * 2;
  const cost = r2(staffCost(m, p) * p.move_cost_multiplier * count);
  const arrival = need.dispatch + p.staff_transit_days;
  const o = BR[src.origin].short_name;
  const d = BR[need.dest].short_name;
  const comp = zeroComp();
  comp.rental_revenue = (gainDays - lostDays) * rate;
  comp.variable_cost = (gainDays - lostDays) * rate * p.variable_cost_pct;
  comp.transport_cost = cost;
  const trucks = plural(count, cls.short_name);
  const action: Action = {
    ...nullAction,
    id: moveId(need, src.origin),
    type: "move",
    label: `Drive ${trucks} ${o} → ${d}`,
    why:
      useful > 0
        ? `Arrives ${dayName(arrival)}, in time for ${dayName(need.shortageDays[0])}'s shortage (about ${Math.round(gained)} rentals ${d} would otherwise turn away), and a hauler would arrive ${dayName(need.dispatch + p.hauler_transit_days)}, too late.`
        : `${d}'s shortage is already covered, so ${count === 1 ? "this truck adds" : "these trucks add"} no rentals there.`,
    affected_branches: [src.origin, need.dest],
    cost,
    origin: src.origin,
    dest: need.dest,
    class_id: need.cls,
    mode: "staff",
    dispatch_day: need.dispatch,
    arrival_day: arrival,
    count,
  };
  return {
    action,
    family: "move",
    comp,
    branch: { [src.origin]: { revenue: -lostDays * rate, days: -lostDays }, [need.dest]: { revenue: gainDays * rate, days: gainDays } },
    rentals: gained - lost,
    w1: need.shortageDays.some((x) => x > 7) ? 0.35 : 0.9,
    scen: [0.55, 1.05, 1.35],
    inv: [
      { b: need.dest, c: need.cls, on: (day) => need.shortageDays.includes(day), unmet: -useful },
      { b: src.origin, c: need.cls, on: (day) => day >= need.dispatch, idle: -count },
    ],
    move: { need, gained, lost },
  };
}

// ---- pricing levers

interface Lever {
  id: string;
  /** Non-base tier values the solver may pick. */
  tiers: (p: Params) => number[];
  /** The tier value an approval carries for this lever. */
  approvedValue: (a: ApprovedAction) => number | null | undefined;
  build: (tier: number, ctx: Ctx) => Effect;
  /** False when the data leaves this lever nothing to do, whatever the tier. */
  available: (ctx: Ctx) => boolean;
}

/**
 * Rate tier on new local rentals. `demandDays` truck-days are asked for at the base
 * price; the branch can serve at most `capDays` of them.
 */
function rateLever(branch: string, clsId: string, demandDays: number, capDays: number): Lever {
  const id = `rate:${branch}:${clsId}`;
  return {
    id,
    tiers: (p) => p.rate_tiers.filter((t) => t !== 0),
    approvedValue: (a) => a.tier_pct,
    available: () => true,
    build: (t, ctx) => {
      const p = ctx.p;
      const cls = CL[clsId];
      const rate = cls.daily_rate;
      const e = (p.elasticity_by_branch[branch] ?? p.elasticity_default) * p.elasticity_scale;
      const served0 = Math.min(capDays, demandDays);
      const asked = demandDays * Math.pow(1 + t, e);
      const served = Math.min(capDays, asked);
      const dDays = served - served0;
      const comp = zeroComp();
      comp.rental_revenue = served * rate * (1 + t) - served0 * rate;
      comp.variable_cost = dDays * rate * p.variable_cost_pct;
      comp.change_cost = p.change_cost;
      const pct = Math.round(Math.abs(t) * 100);
      const name = BR[branch].short_name;
      const haul = haulerCost(miles(branch, "NYC") ?? 0, p) * p.move_cost_multiplier;
      const turnedAway = Math.max(0, Math.round((demandDays - capDays) / p.local_duration_days));
      const action: Action = {
        ...nullAction,
        id,
        type: "rate",
        label: `${t < 0 ? "Discount" : "Raise"} ${cls.short_name} rates at ${name} by ${pct}%`,
        why:
          t < 0
            ? `Local demand there is price-sensitive and the trucks sit idle, so about ${Math.max(1, Math.round(dDays / p.local_duration_days))} more rentals go out, while hauling a truck back to New York would cost ${usd0(haul)}.`
            : `Every ${cls.short_name} there is already rented and about ${turnedAway} rentals are being turned away, so the higher rate earns more on the same trucks.`,
        affected_branches: [branch],
        cost: 0,
        branch_id: branch,
        class_id: clsId,
        tier_pct: t,
      };
      const perDay = Math.round(dDays / p.horizon_days);
      const inv: InvAdj[] =
        capDays < demandDays
          ? [{ b: branch, c: clsId, on: () => true, unmetScale: Math.max(0, (asked - served) / (demandDays - capDays)) }]
          : [{ b: branch, c: clsId, on: () => true, idle: -perDay }];
      return { action, family: "pricing", comp, branch: { [branch]: { revenue: comp.rental_revenue, days: dDays } }, rentals: dDays / p.local_duration_days, w1: 0.5, scen: [0.9, 1.0, 1.1], inv };
    },
  };
}

/**
 * Drop fee on the 14 new one-way moving-truck rentals from New York into Portland.
 * A customer the fee puts off who does not drop elsewhere rents locally for a day less.
 */
const FEE_PWM: Lever = {
  id: "fee:PWM",
  tiers: (p) => p.fee_tiers.filter((f) => f !== 0),
  approvedValue: (a) => a.fee,
  available: () => true,
  build: (fee, ctx) => {
    const p = ctx.p;
    const rate = CL.mov26.daily_rate;
    const n = 14;
    const i = Math.max(0, p.fee_tiers.indexOf(fee));
    const d = Math.min(1, (p.fee_deterrence[i] ?? 0) * p.fee_deterrence_scale);
    const lostRentals = n * d * (1 - p.fee_divert_share);
    const lostDays = lostRentals;
    const comp = zeroComp();
    comp.fee_revenue = n * (1 - d) * fee;
    comp.rental_revenue = -lostDays * rate;
    comp.variable_cost = -lostDays * rate * p.variable_cost_pct;
    comp.change_cost = p.change_cost;
    const action: Action = {
      ...nullAction,
      id: "fee:PWM",
      type: "fee",
      label: `Add a $${fee} drop fee into Portland`,
      why: `About ${Math.round(d * 100)}% of new one-way rentals into Portland are put off, ${Math.round(p.fee_divert_share * 100)}% of those drop at Boston instead, and fewer trucks pile up where local demand is low.`,
      affected_branches: ["PWM", "BOS", "NYC"],
      cost: 0,
      branch_id: "PWM",
      fee,
    };
    return {
      action, family: "pricing", comp,
      branch: { PWM: { revenue: comp.fee_revenue, days: 0 }, NYC: { revenue: comp.rental_revenue, days: -lostDays } },
      rentals: -lostRentals, w1: 0.5, scen: [0.9, 1.0, 1.1],
      inv: [{ b: "PWM", c: "mov26", on: (day) => day >= 8, idle: -1 }],
    };
  },
};

/** Return incentive at New Haven for the 6 confirmed one-way returns due at Hartford. */
const INCENTIVE_NHV: Lever = {
  id: "incentive:NHV",
  tiers: (p) => p.incentive_tiers.filter((a) => a !== 0),
  approvedValue: (a) => a.amount,
  // A booking reported at Hartford means Hartford needs its own returns back.
  available: (ctx) => reportedAt(ctx.added, "HFD", "box16") === 0,
  build: (amount, ctx) => {
    const p = ctx.p;
    const rate = CL.box16.daily_rate;
    const eligible = 6;
    const i = Math.max(0, p.incentive_tiers.indexOf(amount));
    const u = Math.min(1, (p.incentive_uptake[i] ?? 0) * p.incentive_uptake_scale);
    const redirects = eligible * u;
    const hfdNeedsThem = reportedAt(ctx.added, "HFD", "box16") > 0;
    const useful = hfdNeedsThem ? 0 : Math.min(redirects, 2); // New Haven can rent out two more
    const days = useful * p.local_duration_days;
    const comp = zeroComp();
    // Returns Hartford needed for its own booking are rentals Hartford loses.
    const hfdLostDays = hfdNeedsThem ? Math.min(redirects, 2) * p.local_duration_days : 0;
    comp.rental_revenue = (days - hfdLostDays) * rate;
    comp.variable_cost = (days - hfdLostDays) * rate * p.variable_cost_pct;
    comp.incentive_payments = redirects * amount;
    comp.change_cost = p.change_cost;
    const n = Math.max(1, Math.round(redirects));
    const action: Action = {
      ...nullAction,
      id: "incentive:NHV",
      type: "incentive",
      label: `Offer $${amount} to return at New Haven instead of Hartford`,
      why: hfdNeedsThem
        ? `Hartford now needs those trucks for its own booking, so this pulls them the wrong way.`
        : `About ${n} of the ${eligible} customers due back at Hartford are likely to accept, which puts trucks where Thursday's and Friday's demand is without a drive.`,
      affected_branches: ["NHV", "HFD"],
      cost: r2(comp.incentive_payments),
      branch_id: "NHV",
      amount,
      from_branch_id: "HFD",
      expected_redirects: r2(redirects),
    };
    return {
      action, family: "pricing", comp,
      branch: { NHV: { revenue: days * rate, days }, HFD: { revenue: -hfdLostDays * rate, days: -hfdLostDays } },
      rentals: useful - hfdLostDays / p.local_duration_days, w1: 0.3, scen: [0.9, 1.0, 1.1],
      inv: [
        { b: "NHV", c: "box16", on: (day) => day === 4 || day === 5, unmet: -useful / 2 },
        { b: "HFD", c: "box16", on: (day) => day >= 4, idle: -Math.round(redirects) },
      ],
    };
  },
};

const LEVERS: Lever[] = [
  rateLever("NYC", "box16", 60, 50), // scarce: more asked for than New York can serve
  rateLever("PWM", "mov26", 60, Infinity), // idle: Portland can serve whatever a discount brings
  FEE_PWM,
  INCENTIVE_NHV,
];

const ORDER: Record<string, number> = { move: 0, rate: 1, fee: 2, incentive: 3 };

/**
 * The plan under the decisions in `ctx`. Approved actions are built exactly as approved,
 * whatever they are worth; refused ones are skipped; the rest is proposed when it pays.
 */
function chooseEffects(ctx: Ctx, onlyApproved = false): Effect[] {
  const out: Effect[] = [];

  for (const need of NEEDS) {
    let remaining = need.trucks;
    for (const src of need.sources) {
      const ap = approvedOf(ctx, moveId(need, src.origin));
      if (!ap) continue;
      const count = Math.max(1, ap.count ?? 1);
      const useful = Math.min(count, remaining);
      const e = moveEffect(need, src, count, useful, ctx);
      e.action.decision = "approved";
      out.push(e);
      remaining -= useful;
    }
    if (onlyApproved) continue;
    for (const src of need.sources) {
      if (remaining <= 0) break;
      if (approvedOf(ctx, moveId(need, src.origin)) || laneClosed(ctx, src.origin, need.dest, need.cls)) continue;
      const cap = src.origin === "HFD" ? hfdSpare(ctx) : need.trucks;
      const count = Math.min(remaining, cap);
      if (count <= 0) continue;
      const e = moveEffect(need, src, count, count, ctx);
      if (netOf(e.comp) > 0) {
        out.push(e);
        remaining -= count;
      }
    }
  }

  for (const lever of LEVERS) {
    const ap = approvedOf(ctx, lever.id);
    if (ap) {
      const e = lever.build(lever.approvedValue(ap) ?? lever.tiers(ctx.p)[0], ctx);
      e.action.decision = "approved";
      out.push(e);
      continue;
    }
    if (onlyApproved || held(ctx, lever.id) || !caseOf(ctx.caseId).pricing || !lever.available(ctx)) continue;
    let best: Effect | null = null;
    for (const t of lever.tiers(ctx.p)) {
      const e = lever.build(t, ctx);
      if (netOf(e.comp) > 0 && (!best || netOf(e.comp) > netOf(best.comp))) best = e;
    }
    if (best) out.push(best);
  }

  return out.sort(
    (a, b) => ORDER[a.action.type] - ORDER[b.action.type] || (a.action.dispatch_day ?? 0) - (b.action.dispatch_day ?? 0) || a.action.id.localeCompare(b.action.id),
  );
}

// -------------------------------------------------------------------- solve

interface BaseState {
  branch: Record<string, { revenue: number; days: number; fleet: number }>;
  comp: Components;
  broken: number;
  bookings: Booking[];
}

function baseState(ctx: Ctx): BaseState {
  const branch: BaseState["branch"] = {};
  for (const [k, v] of Object.entries(BASE)) branch[k] = { ...v };
  let varCost = Object.values(BASE).reduce((s, b) => s + b.revenue, 0) * ctx.p.variable_cost_pct;
  const bookings: Booking[] = ctx.added.map((b, i) => {
    const rate = CL[b.class_id]?.daily_rate ?? 110;
    const days = Math.max(0, Math.min(b.duration_days, ctx.p.horizon_days - b.start_day + 1)) * b.count;
    if (branch[b.branch_id]) {
      branch[b.branch_id].revenue += days * rate;
      branch[b.branch_id].days += days;
    }
    varCost += days * rate * ctx.p.variable_cost_pct;
    return {
      id: `reported-${i + 1}`,
      origin: b.branch_id,
      dest: b.dest_branch_id,
      class_id: b.class_id,
      start_day: b.start_day,
      duration_days: b.duration_days,
      count: b.count,
      kind: b.dest_branch_id === b.branch_id ? "local" : "oneway",
      daily_price: rate,
      source: "reported",
    };
  });
  const comp = zeroComp();
  comp.rental_revenue = Object.values(branch).reduce((s, b) => s + b.revenue, 0);
  comp.variable_cost = varCost;
  // Hartford cannot cover more than four extra box-truck bookings by any plan.
  const broken = Math.max(0, reportedAt(ctx.added, "HFD", "box16") - 4);
  return { branch, comp, broken, bookings };
}

const SCEN_BASE: [number, number, number] = [0.86, 1.02, 1.1];
const STRATEGY_LABEL: Record<StrategyId, string> = { none: "Do nothing", moves: "Moves only", pricing: "Pricing only", joint: "Joint" };
const COMP_KEYS: BridgeKey[] = ["rental_revenue", "fee_revenue", "variable_cost", "incentive_payments", "transport_cost", "change_cost"];
const BRIDGE_LABEL: Record<BridgeKey, string> = {
  rental_revenue: "Rental revenue",
  fee_revenue: "Fee revenue",
  variable_cost: "Variable cost",
  incentive_payments: "Incentive payments",
  transport_cost: "Transport cost",
  change_cost: "Change costs",
};

function strategy(id: StrategyId, base: BaseState, effects: Effect[], p: Params, label = STRATEGY_LABEL[id]): StrategyResult {
  const comp = { ...base.comp };
  for (const e of effects) for (const k of COMP_KEYS) comp[k] += e.comp[k];
  for (const k of COMP_KEYS) comp[k] = r2(comp[k]);
  const contribution = r2(netOf(comp));
  const baseNet = netOf(base.comp);
  const week1 = r2(baseNet * 0.52 + effects.reduce((s, e) => s + netOf(e.comp) * e.w1, 0));
  const penalty = base.broken * p.broken_commitment_penalty;
  return {
    id,
    label,
    expected_contribution: contribution,
    expected_broken_commitments: base.broken,
    expected_penalty: penalty,
    objective: r2(contribution - penalty),
    week1,
    week2: r2(contribution - week1),
    components: comp,
    by_scenario: p.scenarios.map((s, i) => ({
      scenario_id: s.id as ScenarioId,
      label: s.label,
      weight: s.weight,
      contribution: r2(baseNet * SCEN_BASE[i] + effects.reduce((sum, e) => sum + netOf(e.comp) * e.scen[i], 0)),
      broken_commitments: base.broken,
    })),
    status: "optimal",
    gap: 0,
    solve_ms: id === "none" ? 38 : id === "joint" ? 412 : 180,
    action_count: effects.length,
  };
}

function scorecards(base: BaseState, effects: Effect[], p: Params): { cards: BranchScorecard[]; transit: number } {
  let transit = 0;
  const fleetAdj: Record<string, number> = {};
  for (const e of effects) {
    const a = e.action;
    if (a.type !== "move" || !a.origin || !a.dest || !a.count || !a.dispatch_day || !a.arrival_day) continue;
    fleetAdj[a.origin] = (fleetAdj[a.origin] ?? 0) - a.count * (p.horizon_days - a.dispatch_day + 1);
    fleetAdj[a.dest] = (fleetAdj[a.dest] ?? 0) + a.count * (p.horizon_days - a.arrival_day + 1);
    transit += a.count * (a.arrival_day - a.dispatch_day);
  }
  const cards = BRANCHES.map((b) => {
    const s = base.branch[b.id];
    const assigned = s.fleet * p.horizon_days;
    let rev = s.revenue;
    let days = s.days;
    for (const e of effects) {
      rev += e.branch[b.id]?.revenue ?? 0;
      days += e.branch[b.id]?.days ?? 0;
    }
    rev = r2(rev);
    days = r2(days);
    const credit = r2(Math.max(0, s.revenue - rev));
    const adjAssigned = assigned + (fleetAdj[b.id] ?? 0);
    const card: BranchScorecard = {
      branch_id: b.id,
      baseline: { revenue: r2(s.revenue), rented_truck_days: r2(s.days), assigned_fleet_days: assigned, utilization: r4(s.days / assigned) },
      actual: { revenue: rev, rented_truck_days: days, assigned_fleet_days: assigned, utilization: r4(days / assigned) },
      delta: { revenue: r2(rev - s.revenue), rented_truck_days: r2(days - s.days), utilization: r4(days / assigned - s.days / assigned) },
      adjusted: { actual_revenue: rev, credit, revenue: r2(rev + credit), rented_truck_days: days, assigned_fleet_days: adjAssigned, utilization: r4(days / adjAssigned) },
      action_ids: effects.filter((e) => e.action.affected_branches.includes(b.id)).map((e) => e.action.id),
    };
    return card;
  });
  return { cards, transit };
}

// The do-nothing daily position: [idle trucks, rentals turned away] by branch, class and day.
function basePosition(b: string, c: string, day: number): [number, number] {
  const k = `${b}:${c}`;
  const weekend = day % 7 === 6 || day % 7 === 0;
  switch (k) {
    case "HFD:box16":
      return [weekend ? 3 : 4, 0];
    case "HFD:mov26":
      return [1, 0];
    case "NHV:box16":
      return [3, 4, 5].includes(day) ? [0, [3, 4, 3][day - 3]] : [10, 11].includes(day) ? [0, 2] : [weekend ? 1 : 0, 0];
    case "NHV:mov26":
      return [1, 0];
    case "PWM:mov26":
      return [[4, 4, 5, 5, 5, 6, 6, 6, 6, 7, 7, 7, 7, 7][day - 1], 0];
    case "PWM:box16":
      return [2, 0];
    case "BOS:mov26":
      return [2, 3, 4].includes(day) ? [0, 2] : [day > 9 ? 1 : 0, 0];
    case "BOS:box16":
      return day === 9 ? [0, 1] : [1, 0];
    case "NYC:box16":
      return weekend ? [0, 0] : [0, 1];
    case "NYC:mov26":
      return day === 4 || day === 5 ? [0, 1] : [1, 0];
    default:
      return [0, 0];
  }
}

function inventory(ctx: Ctx, effects: Effect[], approvedEffects: Effect[]): InventoryRow[] {
  const rows: InventoryRow[] = [];
  const p = ctx.p;
  for (const b of BRANCHES) {
    for (const c of CLASSES) {
      for (let day = 1; day <= p.horizon_days; day++) {
        let [idleNone, unmetNone] = basePosition(b.id, c.id, day);
        // A reported booking takes trucks off the lot for its days, in every plan.
        for (const bk of ctx.added) {
          if (bk.branch_id === b.id && bk.class_id === c.id && day >= bk.start_day && day < bk.start_day + bk.duration_days) idleNone = Math.max(0, idleNone - bk.count);
        }
        const under = (list: Effect[]): [number, number] => {
          let idle = idleNone;
          let unmet = unmetNone;
          for (const e of list) {
            for (const a of e.inv) {
              if (a.b !== b.id || a.c !== c.id || !a.on(day)) continue;
              if (a.unmetScale !== undefined) unmet *= a.unmetScale;
              unmet += a.unmet ?? 0;
              idle += a.idle ?? 0;
            }
          }
          return [Math.max(0, idle), Math.max(0, r2(unmet))];
        };
        const [idlePlan, unmetPlan] = under(effects);
        const [idleApproved, unmetApproved] = under(approvedEffects);
        const revDays = Math.min(p.local_duration_days, p.horizon_days - day + 1);
        rows.push({
          branch_id: b.id,
          class_id: c.id,
          day,
          available_none: idleNone + 1,
          available_plan: idlePlan + 1,
          available_approved: idleApproved + 1,
          unmet_none: unmetNone,
          unmet_plan: unmetPlan,
          unmet_approved: unmetApproved,
          unmet_revenue_none: r2(unmetNone * revDays * c.daily_rate),
          unmet_revenue_plan: r2(unmetPlan * revDays * c.daily_rate),
          unmet_revenue_approved: r2(unmetApproved * revDays * c.daily_rate),
          idle_none: idleNone,
          idle_plan: idlePlan,
          idle_approved: idleApproved,
        });
      }
    }
  }
  return rows;
}

function totals(rows: InventoryRow[], which: "none" | "plan" | "approved"): SituationTotals {
  return {
    unserved_rentals: r2(rows.reduce((s, r) => s + r[`unmet_${which}`], 0)),
    unserved_revenue: r2(rows.reduce((s, r) => s + r[`unmet_revenue_${which}`], 0)),
    idle_truck_days: r2(rows.reduce((s, r) => s + r[`idle_${which}`], 0)),
  };
}

interface Solved {
  response: SolveResponse;
  effects: Effect[];
  base: BaseState;
}

function solveInternal(ctx: Ctx): Solved {
  const base = baseState(ctx);
  // Evidence: the four strategies with no decisions applied.
  const free = chooseEffects({ ...ctx, approved: new Map(), rejected: new Set(), forbid: undefined });
  const strategies = [
    strategy("none", base, [], ctx.p),
    strategy("moves", base, free.filter((e) => e.family === "move"), ctx.p),
    strategy("pricing", base, free.filter((e) => e.family === "pricing"), ctx.p),
    strategy("joint", base, free, ctx.p),
  ];
  const none = strategies[0];

  // The current plan: joint under the decisions sent.
  const effects = chooseEffects(ctx);
  const current = strategy("joint", base, effects, ctx.p, "Current plan");
  const approvedEffects = chooseEffects(ctx, true);
  const approvedOnly = strategy("joint", base, approvedEffects, ctx.p);

  const sign: Record<BridgeKey, number> = { rental_revenue: 1, fee_revenue: 1, variable_cost: -1, incentive_payments: -1, transport_cost: -1, change_cost: -1 };
  const steps = COMP_KEYS.map((key) => ({ key, label: BRIDGE_LABEL[key], delta: r2(sign[key] * (current.components[key] - none.components[key])) }));
  // Rounding: keep the identity exact by putting any cent of drift on the first step.
  const drift = r2(current.expected_contribution - none.expected_contribution - steps.reduce((s, x) => s + x.delta, 0));
  steps[0].delta = r2(steps[0].delta + drift);

  const { cards, transit } = scorecards(base, effects, ctx.p);
  const credits: Record<string, number> = {};
  for (const c of cards) if (c.adjusted.credit > 0) credits[c.branch_id] = c.adjusted.credit;
  const inv = inventory(ctx, effects, approvedEffects);
  const key = hash(JSON.stringify([ctx.caseId, ctx.p, ctx.added, [...ctx.approved.values()], [...ctx.rejected], ctx.forbid ?? null]));

  const response: SolveResponse = {
    request_key: `mock:${ctx.caseId}:${key}`,
    case_id: ctx.caseId,
    params: ctx.p,
    added_bookings: base.bookings,
    strategies,
    plan: {
      strategy_id: "joint",
      actions: effects.map((e) => e.action),
      broken_commitments:
        base.broken > 0
          ? [{ booking_id: base.bookings.filter((b) => b.origin === "HFD" && b.class_id === "box16").slice(-1)[0]?.id ?? "reported-1", origin: "HFD", class_id: "box16", start_day: ctx.added.filter((b) => b.branch_id === "HFD").slice(-1)[0]?.start_day ?? 3, expected_count: base.broken }]
          : [],
    },
    plan_result: current,
    decision: {
      do_nothing: none.expected_contribution,
      best_possible: strategies[3].expected_contribution,
      current_plan: current.expected_contribution,
      approved_only: approvedOnly.expected_contribution,
      approved_only_broken: approvedOnly.expected_broken_commitments,
      approved_only_penalty: approvedOnly.expected_penalty,
      cost_of_rejections: r2(strategies[3].expected_contribution - current.expected_contribution),
      approved_count: ctx.approved.size,
      rejected_action_ids: [...ctx.rejected],
    },
    situation: { do_nothing: totals(inv, "none"), plan: totals(inv, "plan"), approved: totals(inv, "approved") },
    bridge: { start: none.expected_contribution, steps, end: current.expected_contribution },
    downside: current.by_scenario.map((s, i) => ({ scenario_id: s.scenario_id, label: s.label, weight: s.weight, plan: s.contribution, do_nothing: none.by_scenario[i].contribution })),
    scorecards: cards,
    central_account: { total_credits: r2(Object.values(credits).reduce((s, x) => s + x, 0)), transit_fleet_days: transit, credits_by_branch: credits },
    inventory: inv,
    total_solve_ms: strategies.reduce((s, x) => s + x.solve_ms, 0),
    cached: false,
  };
  return { response, effects, base };
}

function hash(s: string): string {
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (Math.imul(h, 31) + s.charCodeAt(i)) | 0;
  return (h >>> 0).toString(16);
}

const ID_SHAPE = /^(move:[A-Z]+>[A-Z]+:\w+:(staff|hauler):d\d+|rate:[A-Z]+:\w+|fee:[A-Z]+|incentive:[A-Z]+)$/;

function ctxOf(req: SolveRequest): Ctx {
  const approved = new Map((req.approved ?? []).map((a) => [a.id, a]));
  const rejected = new Set(req.rejected_action_ids ?? []);
  for (const id of [...approved.keys(), ...rejected]) {
    if (!ID_SHAPE.test(id)) throw new MockHttpError(422, `Malformed action id '${id}'`);
  }
  for (const id of rejected) {
    if (approved.has(id)) throw new MockHttpError(422, `Action '${id}' is both approved and rejected`);
  }
  return { caseId: req.case_id, p: effectiveParams(req.case_id, req.params ?? {}), added: req.added_bookings ?? [], approved, rejected };
}

/** Value of the plan, penalties included, without building the whole response. */
function objectiveOf(ctx: Ctx): number {
  const base = baseState(ctx);
  return strategy("joint", base, chooseEffects(ctx), ctx.p).objective;
}
// ------------------------------------------------------------ public mock API

export async function mockCases(): Promise<CaseInfo[]> {
  await sleep(80);
  return CASES.map(({ id, label, description }) => ({ id, label, description }));
}

export async function mockScenario(caseId: string): Promise<Scenario> {
  await sleep(120);
  const c = caseOf(caseId);
  return {
    case: { id: c.id, label: c.label, description: c.description },
    seed: 7,
    start_date: START_DATE,
    params: caseParams(caseId),
    branches: BRANCHES,
    classes: CLASSES,
    lanes: LANES,
    fleet: BRANCHES.flatMap((b) => {
      const box = Math.round(BASE[b.id].fleet * 0.55);
      const mov = BASE[b.id].fleet - box;
      return [
        { branch_id: b.id, class_id: "box16", start_inventory: Math.round(box * 0.4), assigned_fleet: box },
        { branch_id: b.id, class_id: "mov26", start_inventory: Math.round(mov * 0.4), assigned_fleet: mov },
      ];
    }),
    in_progress_returns: [
      { id: "ipr-1", branch_id: "HFD", origin: "NYC", class_id: "box16", return_day: 2, count: 2, kind: "oneway" },
      { id: "ipr-2", branch_id: "PWM", origin: "BOS", class_id: "mov26", return_day: 1, count: 3, kind: "oneway" },
      { id: "ipr-3", branch_id: "NHV", origin: "NHV", class_id: "box16", return_day: 5, count: 2, kind: "local" },
    ],
    bookings: [
      { id: "bk-1", origin: "NHV", dest: "NHV", class_id: "box16", start_day: 3, duration_days: 2, count: 4, kind: "local", daily_price: 110, source: "seed" },
      { id: "bk-2", origin: "NYC", dest: "HFD", class_id: "box16", start_day: 2, duration_days: 3, count: 4, kind: "oneway", daily_price: 110, source: "seed" },
      { id: "bk-3", origin: "BOS", dest: "PWM", class_id: "mov26", start_day: 1, duration_days: 3, count: 3, kind: "oneway", daily_price: 160, source: "seed" },
      { id: "bk-4", origin: "NYC", dest: "PWM", class_id: "mov26", start_day: 4, duration_days: 3, count: 2, kind: "oneway", daily_price: 160, source: "seed" },
    ],
    demand: [
      { id: "dm-1", origin: "NHV", dest: "NHV", class_id: "box16", start_day: 3, duration_days: 2, kind: "local", base_demand: 3 },
      { id: "dm-2", origin: "NHV", dest: "NHV", class_id: "box16", start_day: 4, duration_days: 2, kind: "local", base_demand: 3 },
      { id: "dm-3", origin: "PWM", dest: "PWM", class_id: "mov26", start_day: 2, duration_days: 2, kind: "local", base_demand: 2.5 },
      { id: "dm-4", origin: "NYC", dest: "PWM", class_id: "mov26", start_day: 5, duration_days: 3, kind: "oneway", base_demand: 2 },
      { id: "dm-5", origin: "HFD", dest: "HFD", class_id: "box16", start_day: 6, duration_days: 2, kind: "local", base_demand: 1 },
    ],
  };
}


export async function mockSolve(req: SolveRequest): Promise<SolveResponse> {
  await sleep(450);
  return solveInternal(ctxOf(req)).response;
}

export async function mockSuggestedBooking(): Promise<ReportedBooking> {
  await sleep(100);
  return { branch_id: "HFD", class_id: "box16", start_day: 3, duration_days: 2, dest_branch_id: "HFD", count: 1 };
}

/** Cost of refusing each action in the current plan: one re-solve per action. */
export async function mockExplainBatch(req: ExplainBatchRequest): Promise<ExplainBatchResponse> {
  const ctx = ctxOf(req);
  const full = solveInternal(ctx);
  const ids = req.action_ids ?? full.effects.map((e) => e.action.id);
  await sleep(500 + 120 * ids.length);
  const planValue = full.response.plan_result.objective;
  const items: ActionValue[] = ids.map((id) => {
    const e = full.effects.find((x) => x.action.id === id);
    if (!e) throw new MockHttpError(404, `Action '${id}' is not in the current plan for these inputs`);
    return { action_id: id, cost: e.action.cost, reduction: r2(planValue - objectiveOf({ ...ctx, forbid: id })), status: "optimal", gap: 0 };
  });
  return { items, solve_ms: 120 * ids.length };
}

export async function mockExplain(req: ExplainRequest): Promise<ExplainResponse> {
  await sleep(700);
  const ctx = ctxOf(req);
  const full = solveInternal(ctx);
  const eff = full.effects.find((e) => e.action.id === req.action_id);
  if (!eff) throw new MockHttpError(404, `Action '${req.action_id}' is not in the current plan for these inputs`);
  const a = eff.action;
  const cls = a.class_id ? CL[a.class_id] : null;
  const bn = (id: string | null) => (id ? BR[id]?.short_name ?? id : "");

  let forbidden = "";
  if (a.type === "move") {
    forbidden = `The ${bn(a.origin)} to ${bn(a.dest)} lane was closed for ${cls?.name ?? a.class_id}s: both modes, every dispatch day (days 1 to ${ctx.p.dispatch_days}).`;
  } else if (a.type === "rate") {
    forbidden = `The ${cls?.name ?? a.class_id} rate at ${bn(a.branch_id)} was held at the base rate.`;
  } else if (a.type === "fee") {
    forbidden = `The drop fee into ${bn(a.branch_id)} was held at $0.`;
  } else {
    forbidden = `The return incentive at ${bn(a.branch_id)} was held at $0.`;
  }

  const alt = solveInternal({ ...ctx, forbid: a.id });
  const pj = full.response.plan_result;
  const aj = alt.response.plan_result;

  let transfer: ExplainResponse["transfer_detail"] = null;
  let lever: ExplainResponse["lever_detail"] = null;
  if (a.type === "move" && eff.move && a.origin && a.dest && a.count && a.dispatch_day && a.arrival_day) {
    const m = miles(a.origin, a.dest);
    const haulArrive = a.dispatch_day + ctx.p.hauler_transit_days;
    const shortage = eff.move.need.shortageDays[0];
    transfer = {
      donor_branch_id: a.origin,
      receiver_branch_id: a.dest,
      class_id: a.class_id ?? "box16",
      count: a.count,
      mode: "staff",
      dispatch_day: a.dispatch_day,
      arrival_day: a.arrival_day,
      cost: a.cost,
      shortage_day: shortage,
      donor_rentals_lost: r2(eff.move.lost),
      receiver_rentals_gained: r2(eff.move.gained),
      alt_mode: { mode: "hauler", allowed: true, arrival_day: haulArrive, cost: r2(haulerCost(m, ctx.p) * ctx.p.move_cost_multiplier * a.count), arrives_in_time: haulArrive <= shortage },
    };
  } else {
    const rev = (c: Components) => c.rental_revenue + c.fee_revenue;
    const cost = (c: Components) => c.variable_cost + c.incentive_payments + c.transport_cost + c.change_cost;
    const rentals = (es: Effect[]) => es.reduce((s, e) => s + e.rentals, 0);
    lever = {
      rentals_delta: r2(rentals(full.effects) - rentals(alt.effects)),
      revenue_delta: r2(rev(pj.components) - rev(aj.components)),
      cost_delta: r2(cost(pj.components) - cost(aj.components)),
    };
  }

  return {
    action: a,
    forbidden,
    plan_value: pj.objective,
    replanned_value: aj.objective,
    reduction: r2(pj.objective - aj.objective),
    status: "optimal",
    gap: 0,
    replanned_actions: alt.response.plan.actions,
    transfer_detail: transfer,
    lever_detail: lever,
    affected_scorecards: full.response.scorecards.filter((s) => a.affected_branches.includes(s.branch_id)),
    solve_ms: 268,
  };
}
