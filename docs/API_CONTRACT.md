# Fleet Rebalancing Prototype: API and Model Contract

This is the seam every part of the build works against. The planning doc
(`docs/Fleet Rebalancing Prototype Planning Doc (1).md`) says what to build and why;
this file pins the shapes and the semantics the planning doc leaves open.

- **Types are normative in `backend/app/schemas.py`** (Pydantic). The frontend mirrors
  them in `frontend/src/api/types.ts`. JSON field names are exactly the Python names
  (snake_case).
- If a shape has to change, change `schemas.py` and this file together and say so in
  your final report. Do not drift silently.

## 1. Conventions

| Thing | Rule |
| --- | --- |
| Days | 1-indexed, `1..14`. Day 1 is `start_date`, a Monday (`2026-11-23`) |
| Branch ids | `NYC`, `BOS`, `HFD`, `NHV`, `PWM` |
| Class ids | `box16` (16 ft box truck), `mov26` (26 ft moving truck) |
| Strategy ids | `none`, `moves`, `pricing`, `joint`, always in that order |
| Money | USD floats, rounded to cents in responses |
| Expected values | Scenario-weighted (25/50/25). Counts of rentals can be fractional |
| Contribution | Excludes broken-commitment penalties. `objective = contribution - penalty` |
| Backend | `http://localhost:8010`, all routes under `/api` |
| Frontend | Vite dev server on `5173`, proxying `/api` to `8010` |
| Errors | FastAPI default: `{"detail": ...}` with 404 (unknown case or action) or 422 (validation) |

## 2. Endpoints

| Route | Request | Response |
| --- | --- | --- |
| `GET /api/health` | none | `{"status": "ok"}` |
| `GET /api/cases` | none | `CaseInfo[]` |
| `GET /api/scenario?case_id=default` | query | `Scenario` |
| `GET /api/suggested-booking` | none | `ReportedBooking`: the Hartford correction for the default case, used as a form prefill |
| `POST /api/solve` | `SolveRequest` | `SolveResponse` |
| `POST /api/explain/action` | `ExplainRequest` | `ExplainResponse` |
| `POST /api/explain/batch` | `ExplainBatchRequest` | `ExplainBatchResponse` (section 7) |
| `POST /api/conditional` | stretch | `501` until built; the frontend hides the card on any non-200 |

The service is stateless. Every request carries everything needed to reproduce the
solve: `case_id`, `params` overrides and `added_bookings`. An in-memory cache keyed by
those three makes repeat calls and `/api/explain/action` cheap (explain reuses the cached
joint and do-nothing solves).

### Request examples

```jsonc
// POST /api/solve — every field optional
{
  "case_id": "default",
  "params": { "move_cost_multiplier": 1.5, "elasticity_scale": 1.0 },
  "added_bookings": [
    { "branch_id": "HFD", "class_id": "box16", "start_day": 3,
      "duration_days": 2, "dest_branch_id": "HFD", "count": 2 }
  ]
}

// POST /api/explain/action — same three fields plus the action
{ "case_id": "default", "params": {}, "added_bookings": [],
  "action_id": "move:HFD>NHV:box16:staff:d2" }
```

### Cases

| `case_id` | What it must show |
| --- | --- |
| `default` | Hartford to New Haven short transfer wins by staff drive (a hauler arrives too late); Portland is fixed by pricing because hauling back is expensive |
| `high_move_cost` | Every intervention costs more than it creates; the plan has no actions |
| `joint_equals_moves` | Joint matches moves only |

"Hartford reports a missing booking" is not a case: it is the `default` case plus one
`added_bookings` entry that changes the plan. `data.py` exports the entry that does it
(see section 5) so the UI can offer it as a prefill and a test can assert it.

## 3. Response shapes (TypeScript view of `schemas.py`)

```ts
type StrategyId = "none" | "moves" | "pricing" | "joint";
type SolverStatus = "optimal" | "time_limit" | "infeasible";
type ScenarioId = "low" | "base" | "high";

interface SolveResponse {
  request_key: string;
  case_id: string;
  params: Params;                 // effective, after overrides
  added_bookings: Booking[];
  strategies: StrategyResult[];   // exactly 4: none, moves, pricing, joint
  plan: { strategy_id: "joint"; actions: Action[]; broken_commitments: BrokenCommitment[] };
  bridge: { start: number; steps: BridgeStep[]; end: number };
  downside: { scenario_id: ScenarioId; label: string; weight: number; plan: number; do_nothing: number }[];
  scorecards: BranchScorecard[];  // one per branch
  central_account: { total_credits: number; transit_fleet_days: number; credits_by_branch: Record<string, number> };
  inventory: InventoryRow[];      // branch x class x day
  total_solve_ms: number;
  cached: boolean;
}

interface StrategyResult {
  id: StrategyId; label: string;
  expected_contribution: number; expected_broken_commitments: number;
  expected_penalty: number; objective: number;
  week1: number; week2: number;   // week1 + week2 == expected_contribution
  components: { rental_revenue: number; fee_revenue: number; variable_cost: number;
                incentive_payments: number; transport_cost: number; change_cost: number };
  by_scenario: { scenario_id: ScenarioId; label: string; weight: number;
                 contribution: number; broken_commitments: number }[];
  status: SolverStatus; gap: number | null; solve_ms: number; action_count: number;
}

type Action =
  | (ActionBase & { type: "move"; origin: string; dest: string; class_id: string;
                    mode: "staff" | "hauler"; dispatch_day: number; arrival_day: number; count: number })
  | (ActionBase & { type: "rate"; branch_id: string; class_id: string; tier_pct: number })
  | (ActionBase & { type: "fee"; branch_id: string; fee: number })
  | (ActionBase & { type: "incentive"; branch_id: string; from_branch_id: string;
                    amount: number; expected_redirects: number });
interface ActionBase { id: string; label: string; why: string; affected_branches: string[]; cost: number }
// On the wire every Action carries all fields; the ones not relevant to `type` are null.

interface BridgeStep {
  key: "rental_revenue" | "fee_revenue" | "variable_cost" | "incentive_payments" | "transport_cost" | "change_cost";
  label: string;
  delta: number;                  // signed effect on contribution; start + sum(delta) == end
}

interface BranchScorecard {
  branch_id: string;
  baseline: ScorecardNumbers;     // do nothing, current rules
  actual: ScorecardNumbers;       // joint plan, current rules
  delta: { revenue: number; rented_truck_days: number; utilization: number };
  adjusted: { actual_revenue: number; credit: number; revenue: number;
              rented_truck_days: number; assigned_fleet_days: number; utilization: number };
  action_ids: string[];
}
interface ScorecardNumbers { revenue: number; rented_truck_days: number; assigned_fleet_days: number; utilization: number }

interface InventoryRow { branch_id: string; class_id: string; day: number;
  available_none: number; available_plan: number; unmet_none: number; unmet_plan: number }

interface ExplainResponse {
  action: Action;
  forbidden: string;              // plain sentence: exactly what was forbidden
  plan_value: number; replanned_value: number; reduction: number;
  status: SolverStatus; gap: number | null;
  replanned_actions: Action[];
  transfer_detail: TransferDetail | null;   // moves only
  lever_detail: { rentals_delta: number; revenue_delta: number; cost_delta: number } | null;
  affected_scorecards: BranchScorecard[];
  solve_ms: number;
}

interface TransferDetail {
  donor_branch_id: string; receiver_branch_id: string; class_id: string; count: number;
  mode: "staff" | "hauler"; dispatch_day: number; arrival_day: number; cost: number;
  shortage_day: number | null;
  donor_rentals_lost: number; receiver_rentals_gained: number;
  alt_mode: { mode: "staff" | "hauler"; allowed: boolean; arrival_day: number | null;
              cost: number | null; arrives_in_time: boolean | null };
}
```

`Scenario`, `Params`, `Booking`, `DemandCohort`, `Lane`, `FleetRow`, `InProgressReturn`,
`Branch`, `VehicleClass` and `CaseInfo` are as written in `schemas.py`.

### Action ids

Deterministic, so two plans diff by id in the browser:

| Type | Id | A changed quantity is |
| --- | --- | --- |
| move | `move:{origin}>{dest}:{class_id}:{mode}:d{dispatch_day}` | `count` |
| rate | `rate:{branch_id}:{class_id}` | `tier_pct` |
| fee | `fee:{branch_id}` | `fee` |
| incentive | `incentive:{branch_id}` | `amount` |

Only non-base tiers and moves with `count >= 1` appear as actions. Order: moves by
dispatch day, then rate, fee, incentive.

## 4. Model semantics the planning doc leaves open

These are decisions, made here so that data, model, scorecard and UI agree. Each is a
declared assumption for the write-up.

**Timing**

1. `avail[b,k,d,s]` is trucks on the lot at the start of day `d`.
2. A rental starting day `d` with duration `L` takes a truck from the origin on day `d`,
   occupies days `d..d+L-1`, and the truck is available at the destination from the
   start of day `d+L`. If `d+L > 14` the return falls outside the horizon.
3. A move dispatched on day `d` takes a truck from the origin on day `d` and it is
   available at the destination from day `d+1` (staff) or `d+2` (hauler). `arrival_day`
   means that first available day.
4. Per branch, class, day and scenario: rentals starting plus moves dispatched cannot
   exceed `avail`. Then
   `avail[d+1] = avail[d] - starts[d] - dispatched[d] + rentals ending into d+1 + moves arriving d+1 + in_progress_returns on d+1`.
   `avail[1] = start_inventory + in_progress_returns on day 1`.
5. Conservation: on every day, available + on rent (including in-progress rentals not
   yet back) + in transit equals the total fleet of that class, until a rental's return
   falls past day 14.

**Money**

6. Revenue and variable cost accrue per rented day inside the horizon. A 3-day rental
   starting on day 13 earns 2 days. This is what makes week 1 + week 2 equal the total
   and makes revenue line up with rented truck-days.
7. New-rental daily price is `daily_rate * (1 + tier_pct)` for locals and `daily_rate`
   for one-ways. Confirmed bookings use their own `daily_price`. Variable cost is
   `variable_cost_pct * daily_rate` per rented day regardless of tier.
8. A drop fee is collected once, booked on the rental's start day, at the destination
   branch. Move cost is booked on the dispatch day. An incentive payment is booked on the
   day of the redirected return. Change costs are booked on day 1.
9. In-progress rentals earn nothing in the horizon (their revenue was booked before
   day 1) but do count as rented truck-days at their origin branch for utilization.

**Transport**

10. `staff_cost = 2 * miles / staff_speed_mph * staff_hourly + 2 * miles * staff_per_mile`
    (the driver's return trip is included). `hauler_cost = hauler_load_fee + miles * hauler_per_mile`.
    Both times `move_cost_multiplier`.
11. The staff cap is per origin branch per dispatch day, summed over classes and
    destinations.

**Levers** (each rental is affected by exactly one)

12. *Rate* (per origin branch and class, new local rentals):
    `demand = base_demand * scale_s * (1 + tier_pct) ^ (elasticity_b * elasticity_scale)`.
13. *Fee* (per destination branch `j`, new one-way rentals into `j`):
    `demand = base_demand * scale_s * (1 - d_t)` where
    `d_t = min(1, fee_deterrence[t] * fee_deterrence_scale)`. A diverted cohort of
    `base_demand * scale_s * d_t * fee_divert_share` appears with the same origin, class,
    start day and duration, destination `nearest(j)` (if that is the origin, the next
    nearest), paying no fee. The remainder does not rent.
14. *Incentive* (per branch `b`, confirmed one-way bookings and in-progress one-way
    returns due at `j` where `nearest_branch_id(j) == b`, with the return inside the
    horizon): a share `u_t = min(1, incentive_uptake[t] * incentive_uptake_scale)` of the
    fulfilled rentals returns to `b` instead of `j` on the same day, and each is paid the
    tier amount. This keying makes the lever unique per rental; for Hartford and New
    Haven, which are each other's nearest, it is the same as the planning doc's wording.
15. Change cost: `change_cost` once per (branch, class) rate tier, per branch fee tier and
    per branch incentive tier that is not at base.
16. Strategy flags: `none` fixes every tier at base and allows no moves; `moves` allows
    moves only; `pricing` allows the three tier families only; `joint` allows all.

**Forbidding an action** (`/api/explain/action`)

| Action | What is forbidden | `forbidden` sentence must say |
| --- | --- | --- |
| move | The lane `origin > dest` for that class, both modes, all dispatch days | which lane and class were closed |
| rate | That branch and class held at the base rate | which rate was held |
| fee | That branch's drop fee held at $0 | which fee was held |
| incentive | That branch's return incentive held at $0 | which incentive was held |

**Scorecards**

17. Rental revenue and rented truck-days are booked at the origin branch; drop-fee
    revenue at the destination branch. Incentive payments, transport and change costs
    are HQ costs and appear on no branch. So branch revenues sum to
    `rental_revenue + fee_revenue`.
18. Current rules: `assigned_fleet_days = assigned_fleet * 14` (both classes summed).
19. Adjusted rules: a moved truck leaves the donor's assignment from its dispatch day and
    joins the receiver's from its arrival day; the days between sit in
    `central_account.transit_fleet_days`. `credit = max(0, baseline.revenue - actual.revenue)`.
20. Strategy comparison ranks by `expected_contribution`. The solver maximizes
    `objective`, so the bug check "joint is at least as good" is on `objective`.

## 5. Python seams

`backend/app/data.py` (data agent) exports:

```python
def list_cases() -> list[CaseInfo]: ...
def get_scenario(case_id: str = "default") -> Scenario: ...   # KeyError on unknown id; deterministic
def suggested_missing_booking() -> ReportedBooking: ...       # the Hartford correction for the default case
```

`backend/app/model.py`, `explain.py`, `scorecard.py`, `main.py` (backend agent) consume
only `Scenario` and `Params` from `schemas.py`, so they can be built and tested with
small hand-made scenarios before `data.py` exists.

## 6. Running

```bash
cd backend && uv sync && uv run uvicorn app.main:app --reload --port 8010
cd backend && uv run pytest
cd frontend && npm install && npm run dev      # http://localhost:5173
```

## 7. Decision workflow (added for the decision-first product)

The product is organised around what the HQ ops lead does on Monday morning: see the
situation, approve or reject each recommendation, answer branch pushback, and hand the
approved plan on. The service stays stateless: the browser holds the decisions and sends
them with every request.

### Request additions (`SolveRequest`, inherited by `ExplainRequest` and `ExplainBatchRequest`)

```jsonc
{
  "approved": [ { "id": "move:HFD>NHV:box16:staff:d2", "count": 2 },
                { "id": "rate:PWM:mov26", "tier_pct": -0.2 },
                { "id": "fee:PWM", "fee": 100 },
                { "id": "incentive:NHV", "amount": 40 } ],
  "rejected_action_ids": [ "rate:NYC:box16" ]
}
```

| Decision | Effect on every later solve |
| --- | --- |
| Approved move | That lane, class, mode and dispatch day is fixed at exactly `count` |
| Approved rate, fee, incentive | That tier is fixed at the approved value |
| Rejected move | The lane and class is closed for both modes and all dispatch days, except any approved moves on it |
| Rejected rate, fee, incentive | Held at base (section 4) |
| Same id approved and rejected, unknown id, or a malformed id | 422 |

Approved actions appear in `plan.actions` with `decision: "approved"`; everything else
the solver proposes has `decision: "proposed"`. Rejected actions never appear; the
browser keeps the rejected `Action` objects it had so it can list and restore them.

### Response additions (`SolveResponse`)

| Field | Meaning |
| --- | --- |
| `strategies` | Evidence only: the four strategies with **no** decisions applied |
| `plan`, `bridge`, `downside`, `scorecards`, `central_account`, `inventory` | The **current plan**: joint under the decisions sent. Identical to the joint strategy when there are none |
| `plan_result` | `StrategyResult` for the current plan (id `joint`, label `Current plan`), with status and gap |
| `decision.do_nothing` / `best_possible` / `current_plan` / `approved_only` | Expected contribution of: do nothing; joint with no decisions; the current plan; exactly the approved actions and nothing else (equals `do_nothing` when nothing is approved) |
| `decision.approved_only_broken` / `approved_only_penalty` | Expected broken commitments and penalty of the approved-only plan. Contribution excludes penalties, so `approved_only` can exceed `best_possible` when the approved actions alone leave a confirmed booking unserved; net of the penalty it cannot |
| `decision.cost_of_rejections` | `best_possible - current_plan` |
| `situation.do_nothing` / `situation.plan` | Horizon totals: `unserved_rentals`, `unserved_revenue`, `idle_truck_days` |
| `inventory[].unmet_revenue_none` / `_plan` | In-horizon rental revenue the unserved new demand starting that day would have earned, at the tier in force |
| `inventory[].idle_none` / `_plan` | Trucks still on the lot after that day's rentals and dispatches left |

`situation` totals are the sums of the matching `inventory` columns.

### `POST /api/explain/batch`

Request: `ExplainBatchRequest` (a `SolveRequest` plus optional `action_ids`; default is
every action in the current plan). Response:
`{ items: [{ action_id, cost, reduction, status, gap }], solve_ms }`.

`reduction` is the current plan's objective minus the objective of a re-solve with that
action refused (for an approved action: un-fixed and forbidden), all other decisions
kept. It is the same number `/api/explain/action` returns. Results are cached per
action, so the batch and the single call share work. The UI labels it "Cost of refusing".

### Wording

Why sentences and labels are for an ops lead, not a modeller: whole numbers of trucks
and rentals ("about 27 rentals"), never "expected rentals" or decimals for counts above
1; say "turned away" for unserved demand.
