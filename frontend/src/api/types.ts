// TypeScript mirror of backend/app/schemas.py. Field names are the Python names.
// Change this file only together with schemas.py and docs/API_CONTRACT.md.

export type BranchId = string; // "NYC" | "BOS" | "HFD" | "NHV" | "PWM"
export type ClassId = string; // "box16" | "mov26"
export type StrategyId = "none" | "moves" | "pricing" | "joint";
export type SolverStatus = "optimal" | "time_limit" | "infeasible";
export type ScenarioId = "low" | "base" | "high";
export type RentalKind = "local" | "oneway";
export type Mode = "staff" | "hauler";
export type ActionType = "move" | "rate" | "fee" | "incentive";

// ---------------------------------------------------------------- Parameters

export interface DemandScenario {
  id: ScenarioId;
  label: string;
  scale: number;
  weight: number;
}

export interface Params {
  horizon_days: number;
  dispatch_days: number;
  local_duration_days: number;
  oneway_duration_days: number;
  variable_cost_pct: number;

  hauler_load_fee: number;
  hauler_per_mile: number;
  hauler_transit_days: number;
  staff_hourly: number;
  staff_per_mile: number;
  staff_speed_mph: number;
  staff_max_miles: number;
  staff_max_per_branch_day: number;
  staff_transit_days: number;

  rate_tiers: number[];
  elasticity_default: number;
  elasticity_by_branch: Record<BranchId, number>;
  fee_tiers: number[];
  fee_deterrence: number[];
  fee_divert_share: number;
  incentive_tiers: number[];
  incentive_uptake: number[];
  change_cost: number;
  broken_commitment_penalty: number;

  scenarios: DemandScenario[];

  elasticity_scale: number;
  fee_deterrence_scale: number;
  incentive_uptake_scale: number;
  move_cost_multiplier: number;

  time_limit_s: number;
}

/** Any subset of Params. Unset fields fall back to the case's defaults. */
export interface ParamOverrides {
  elasticity_scale?: number | null;
  fee_deterrence_scale?: number | null;
  incentive_uptake_scale?: number | null;
  move_cost_multiplier?: number | null;
  change_cost?: number | null;
  broken_commitment_penalty?: number | null;
  time_limit_s?: number | null;
}

// ------------------------------------------------------------------ Scenario

export interface Branch {
  id: BranchId;
  name: string;
  short_name: string;
  lat: number;
  lon: number;
  nearest_branch_id: BranchId;
  role: string;
}

export interface VehicleClass {
  id: ClassId;
  name: string;
  short_name: string;
  daily_rate: number;
}

export interface Lane {
  origin: BranchId;
  dest: BranchId;
  miles: number;
  staff_allowed: boolean;
  staff_cost: number | null;
  hauler_cost: number;
}

export interface FleetRow {
  branch_id: BranchId;
  class_id: ClassId;
  start_inventory: number;
  assigned_fleet: number;
}

export interface InProgressReturn {
  id: string;
  branch_id: BranchId;
  origin: BranchId;
  class_id: ClassId;
  return_day: number;
  count: number;
  kind: RentalKind;
}

export interface Booking {
  id: string;
  origin: BranchId;
  dest: BranchId;
  class_id: ClassId;
  start_day: number;
  duration_days: number;
  count: number;
  kind: RentalKind;
  daily_price: number;
  source: "seed" | "reported";
}

export interface DemandCohort {
  id: string;
  origin: BranchId;
  dest: BranchId;
  class_id: ClassId;
  start_day: number;
  duration_days: number;
  kind: RentalKind;
  base_demand: number;
}

export interface CaseInfo {
  id: string;
  label: string;
  description: string;
}

export interface Scenario {
  case: CaseInfo;
  seed: number;
  start_date: string;
  params: Params;
  branches: Branch[];
  classes: VehicleClass[];
  lanes: Lane[];
  fleet: FleetRow[];
  in_progress_returns: InProgressReturn[];
  bookings: Booking[];
  demand: DemandCohort[];
}

// --------------------------------------------------------------------- Solve

export interface ReportedBooking {
  branch_id: BranchId;
  class_id: ClassId;
  start_day: number; // 1..14
  duration_days: number; // 1..7
  dest_branch_id: BranchId;
  count: number; // 1..10
}

/** An approved action, held fixed in every later solve. Carries the quantity the id does not. */
export interface ApprovedAction {
  id: string;
  count?: number | null;
  tier_pct?: number | null;
  fee?: number | null;
  amount?: number | null;
}

/** The service is stateless: every request carries all five inputs. */
export interface SolveRequest {
  case_id: string;
  params: ParamOverrides;
  added_bookings: ReportedBooking[];
  approved: ApprovedAction[];
  rejected_action_ids: string[];
}

/** Expected (scenario-weighted) dollars. All non-negative magnitudes. */
export interface Components {
  rental_revenue: number;
  fee_revenue: number;
  variable_cost: number;
  incentive_payments: number;
  transport_cost: number;
  change_cost: number;
}

export interface ScenarioOutcome {
  scenario_id: ScenarioId;
  label: string;
  weight: number;
  contribution: number;
  broken_commitments: number;
}

export interface StrategyResult {
  id: StrategyId;
  label: string;
  expected_contribution: number;
  expected_broken_commitments: number;
  expected_penalty: number;
  objective: number;
  week1: number;
  week2: number;
  components: Components;
  by_scenario: ScenarioOutcome[];
  status: SolverStatus;
  gap: number | null;
  solve_ms: number;
  action_count: number;
}

/** On the wire every Action carries all fields; those not relevant to `type` are null. */
export interface Action {
  id: string;
  type: ActionType;
  /** "approved" when it was sent in SolveRequest.approved. */
  decision: "proposed" | "approved";
  label: string;
  why: string;
  affected_branches: BranchId[];
  cost: number;

  origin: BranchId | null;
  dest: BranchId | null;
  mode: Mode | null;
  dispatch_day: number | null;
  arrival_day: number | null;
  count: number | null;

  branch_id: BranchId | null;
  class_id: ClassId | null;
  tier_pct: number | null;
  fee: number | null;
  amount: number | null;
  from_branch_id: BranchId | null;
  expected_redirects: number | null;
}

export interface BrokenCommitment {
  booking_id: string;
  origin: BranchId;
  class_id: ClassId;
  start_day: number;
  expected_count: number;
}

export type BridgeKey =
  | "rental_revenue"
  | "fee_revenue"
  | "variable_cost"
  | "incentive_payments"
  | "transport_cost"
  | "change_cost";

export interface BridgeStep {
  key: BridgeKey;
  label: string;
  delta: number;
}

export interface Bridge {
  start: number;
  steps: BridgeStep[];
  end: number;
}

export interface DownsideRow {
  scenario_id: ScenarioId;
  label: string;
  weight: number;
  plan: number;
  do_nothing: number;
}

export interface ScorecardNumbers {
  revenue: number;
  rented_truck_days: number;
  assigned_fleet_days: number;
  utilization: number;
}

export interface AdjustedScorecard {
  actual_revenue: number;
  credit: number;
  revenue: number;
  rented_truck_days: number;
  assigned_fleet_days: number;
  utilization: number;
}

export interface ScorecardDelta {
  revenue: number;
  rented_truck_days: number;
  utilization: number; // fraction: 0.02 = +2 pts
}

export interface BranchScorecard {
  branch_id: BranchId;
  baseline: ScorecardNumbers;
  actual: ScorecardNumbers;
  delta: ScorecardDelta;
  adjusted: AdjustedScorecard;
  action_ids: string[];
}

export interface CentralAccount {
  total_credits: number;
  transit_fleet_days: number;
  credits_by_branch: Record<BranchId, number>;
}

export interface InventoryRow {
  branch_id: BranchId;
  class_id: ClassId;
  day: number;
  available_none: number;
  available_plan: number;
  unmet_none: number;
  unmet_plan: number;
  /** In-horizon rental revenue the rentals turned away that day would have earned. */
  unmet_revenue_none: number;
  unmet_revenue_plan: number;
  /** Trucks still on the lot after the day's rentals and dispatches left. */
  idle_none: number;
  idle_plan: number;
}

export interface SituationTotals {
  unserved_rentals: number;
  unserved_revenue: number;
  idle_truck_days: number;
}

export interface Situation {
  do_nothing: SituationTotals;
  plan: SituationTotals;
}

/** Expected contribution of four reference plans, on the same inputs. */
export interface DecisionSummary {
  do_nothing: number;
  best_possible: number;
  current_plan: number;
  approved_only: number;
  /** Expected broken commitments and penalty of the approved-only plan; `approved_only` leaves the penalty out. */
  approved_only_broken?: number;
  approved_only_penalty?: number;
  cost_of_rejections: number;
  approved_count: number;
  rejected_action_ids: string[];
}

export interface Plan {
  strategy_id: StrategyId;
  actions: Action[];
  broken_commitments: BrokenCommitment[];
}

export interface SolveResponse {
  request_key: string;
  case_id: string;
  params: Params;
  added_bookings: Booking[];
  /** Evidence only: the four strategies with no decisions applied. */
  strategies: StrategyResult[];
  /** Everything below describes the current plan: joint under the decisions sent. */
  plan: Plan;
  plan_result: StrategyResult;
  decision: DecisionSummary;
  situation: Situation;
  bridge: Bridge;
  downside: DownsideRow[];
  scorecards: BranchScorecard[];
  central_account: CentralAccount;
  inventory: InventoryRow[];
  total_solve_ms: number;
  cached: boolean;
}

// ------------------------------------------------------ Action counterfactual

export interface ExplainRequest extends SolveRequest {
  action_id: string;
}

export interface AltMode {
  mode: Mode;
  allowed: boolean;
  arrival_day: number | null;
  cost: number | null;
  arrives_in_time: boolean | null;
}

export interface TransferDetail {
  donor_branch_id: BranchId;
  receiver_branch_id: BranchId;
  class_id: ClassId;
  count: number;
  mode: Mode;
  dispatch_day: number;
  arrival_day: number;
  cost: number;
  shortage_day: number | null;
  donor_rentals_lost: number;
  receiver_rentals_gained: number;
  alt_mode: AltMode;
}

export interface LeverDetail {
  rentals_delta: number;
  revenue_delta: number;
  cost_delta: number;
}

export interface ExplainResponse {
  action: Action;
  forbidden: string;
  plan_value: number;
  replanned_value: number;
  reduction: number;
  status: SolverStatus;
  gap: number | null;
  replanned_actions: Action[];
  transfer_detail: TransferDetail | null;
  lever_detail: LeverDetail | null;
  affected_scorecards: BranchScorecard[];
  solve_ms: number;
}

// --------------------------------------------- Cost of refusing, every action

export interface ExplainBatchRequest extends SolveRequest {
  action_ids?: string[] | null;
}

export interface ActionValue {
  action_id: string;
  cost: number;
  /** Current-plan value lost if this action is refused, after replanning. */
  reduction: number;
  status: SolverStatus;
  gap: number | null;
}

export interface ExplainBatchResponse {
  items: ActionValue[];
  solve_ms: number;
}

// ------------------------------------------------------------------ Stretch
// POST /api/conditional has no shape in the contract yet. This is the frontend's
// provisional reading of the planning doc ("haul now" against "incentive first");
// client.ts validates it at runtime and hides the card on any mismatch.

export interface ConditionalPolicy {
  label: string;
  expected_value: number;
  note?: string | null;
}

export interface ConditionalResponse {
  haul_now: ConditionalPolicy;
  incentive_first: ConditionalPolicy;
  uptake_probability?: number | null;
}
