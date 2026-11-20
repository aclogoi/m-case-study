"""Shared contract types. Normative for both the HTTP API and the data -> model seam.

Mirrors docs/API_CONTRACT.md. Change the two together, never one alone.
Days are 1-indexed (1..horizon_days). Money is USD, rounded to cents in responses.
"""

from typing import Literal, Optional

from pydantic import BaseModel, Field

BranchId = str  # "NYC" | "BOS" | "HFD" | "NHV" | "PWM"
ClassId = str  # "box16" | "mov26"
StrategyId = Literal["none", "moves", "pricing", "joint"]
SolverStatus = Literal["optimal", "time_limit", "infeasible"]
RentalKind = Literal["local", "oneway"]
Mode = Literal["staff", "hauler"]
ActionType = Literal["move", "rate", "fee", "incentive"]


# --------------------------------------------------------------------------- #
# Parameters
# --------------------------------------------------------------------------- #


class DemandScenario(BaseModel):
    id: Literal["low", "base", "high"]
    label: str
    scale: float
    weight: float


class Params(BaseModel):
    horizon_days: int = 14
    dispatch_days: int = 5  # moves may be dispatched on days 1..dispatch_days
    local_duration_days: int = 2
    oneway_duration_days: int = 3
    variable_cost_pct: float = 0.15  # of base daily rate, per rented day

    # Transport
    hauler_load_fee: float = 150.0
    hauler_per_mile: float = 2.50
    hauler_transit_days: int = 2
    staff_hourly: float = 35.0
    staff_per_mile: float = 0.80
    staff_speed_mph: float = 45.0
    staff_max_miles: float = 150.0
    staff_max_per_branch_day: int = 2
    staff_transit_days: int = 1

    # Levers. Tier index 0.. ; the base tier is the one whose value is 0.
    rate_tiers: list[float] = [-0.20, -0.10, 0.0, 0.10]
    elasticity_default: float = -1.2
    elasticity_by_branch: dict[BranchId, float] = {"PWM": -1.8}
    fee_tiers: list[float] = [0.0, 50.0, 100.0]
    fee_deterrence: list[float] = [0.0, 0.15, 0.30]
    fee_divert_share: float = 0.40
    incentive_tiers: list[float] = [0.0, 40.0, 80.0]
    incentive_uptake: list[float] = [0.0, 0.25, 0.50]
    change_cost: float = 50.0
    broken_commitment_penalty: float = 1000.0

    scenarios: list[DemandScenario] = [
        DemandScenario(id="low", label="Low demand", scale=0.8, weight=0.25),
        DemandScenario(id="base", label="Base demand", scale=1.0, weight=0.50),
        DemandScenario(id="high", label="High demand", scale=1.2, weight=0.25),
    ]

    # The four sensitivity sliders. Each multiplies the corresponding defaults.
    elasticity_scale: float = Field(1.0, ge=0.25, le=2.5)
    fee_deterrence_scale: float = Field(1.0, ge=0.0, le=2.5)
    incentive_uptake_scale: float = Field(1.0, ge=0.0, le=2.0)
    move_cost_multiplier: float = Field(1.0, ge=0.25, le=10.0)

    time_limit_s: float = 5.0


class ParamOverrides(BaseModel):
    """Any subset of Params. Unset fields fall back to the case's defaults."""

    elasticity_scale: Optional[float] = Field(None, ge=0.25, le=2.5)
    fee_deterrence_scale: Optional[float] = Field(None, ge=0.0, le=2.5)
    incentive_uptake_scale: Optional[float] = Field(None, ge=0.0, le=2.0)
    move_cost_multiplier: Optional[float] = Field(None, ge=0.25, le=10.0)
    change_cost: Optional[float] = Field(None, ge=0.0)
    broken_commitment_penalty: Optional[float] = Field(None, ge=0.0)
    time_limit_s: Optional[float] = Field(None, gt=0.0, le=30.0)


# --------------------------------------------------------------------------- #
# Scenario (GET /api/scenario; also the input to model.py)
# --------------------------------------------------------------------------- #


class Branch(BaseModel):
    id: BranchId
    name: str  # "Hartford, CT"
    short_name: str  # "Hartford"
    lat: float
    lon: float
    nearest_branch_id: BranchId  # nearest other branch by lane miles
    role: str  # one-line description of its role in the scenario


class VehicleClass(BaseModel):
    id: ClassId
    name: str  # "16 ft box truck"
    short_name: str  # "box truck"
    daily_rate: float


class Lane(BaseModel):
    """Directed lane. One row per ordered pair of distinct branches."""

    origin: BranchId
    dest: BranchId
    miles: float  # straight-line miles x 1.2 road factor
    staff_allowed: bool  # miles <= staff_max_miles
    staff_cost: Optional[float]  # per truck at default params; null if not allowed
    hauler_cost: float  # per truck at default params


class FleetRow(BaseModel):
    branch_id: BranchId
    class_id: ClassId
    start_inventory: int  # trucks available on the lot at the start of day 1
    assigned_fleet: int  # scorecard denominator; sums over branches to the total fleet


class InProgressReturn(BaseModel):
    """Rentals already out at the start of day 1 that come back inside the horizon."""

    id: str
    branch_id: BranchId  # where the truck is due back
    origin: BranchId  # where it was rented
    class_id: ClassId
    return_day: int  # truck is available at branch_id from the start of this day
    count: int
    kind: RentalKind  # oneway returns are eligible for return incentives


class Booking(BaseModel):
    """Confirmed booking cohort: fixed price, must be served."""

    id: str
    origin: BranchId
    dest: BranchId  # == origin for local rentals
    class_id: ClassId
    start_day: int
    duration_days: int
    count: int
    kind: RentalKind
    daily_price: float  # fixed, per rented day, per rental
    source: Literal["seed", "reported"] = "seed"


class DemandCohort(BaseModel):
    """Forecast new demand for one cohort, at base price and the base scenario."""

    id: str
    origin: BranchId
    dest: BranchId
    class_id: ClassId
    start_day: int
    duration_days: int
    kind: RentalKind
    base_demand: float  # rentals; scaled by DemandScenario.scale


class CaseInfo(BaseModel):
    id: str  # "default" | "high_move_cost" | "joint_equals_moves"
    label: str
    description: str  # what the case is meant to show


class Scenario(BaseModel):
    case: CaseInfo
    seed: int
    start_date: str  # ISO date of day 1, a Monday: "2026-11-23"
    params: Params  # the case's default parameters
    branches: list[Branch]
    classes: list[VehicleClass]
    lanes: list[Lane]
    fleet: list[FleetRow]
    in_progress_returns: list[InProgressReturn]
    bookings: list[Booking]
    demand: list[DemandCohort]


# --------------------------------------------------------------------------- #
# Solve (POST /api/solve)
# --------------------------------------------------------------------------- #


class ReportedBooking(BaseModel):
    """A confirmed booking a branch manager says the forecast is missing."""

    branch_id: BranchId  # origin, the reporting branch
    class_id: ClassId
    start_day: int = Field(ge=1, le=14)
    duration_days: int = Field(ge=1, le=7)
    dest_branch_id: BranchId  # == branch_id for a local rental
    count: int = Field(1, ge=1, le=10)


class ApprovedAction(BaseModel):
    """An action the ops lead has approved. It is held fixed in every later solve.

    Carries the quantity because the id does not: `count` for a move, the tier value
    for a rate (`tier_pct`), fee (`fee`) or incentive (`amount`).
    """

    id: str
    count: Optional[int] = None
    tier_pct: Optional[float] = None
    fee: Optional[float] = None
    amount: Optional[float] = None


class SolveRequest(BaseModel):
    case_id: str = "default"
    params: ParamOverrides = ParamOverrides()
    added_bookings: list[ReportedBooking] = []
    # Decisions. The service is stateless, so the browser sends them on every request.
    approved: list[ApprovedAction] = []  # held exactly as approved
    rejected_action_ids: list[str] = []  # forbidden, contract section 4


class Components(BaseModel):
    """Expected (scenario-weighted) dollars. All non-negative magnitudes."""

    rental_revenue: float
    fee_revenue: float
    variable_cost: float
    incentive_payments: float
    transport_cost: float
    change_cost: float


class ScenarioOutcome(BaseModel):
    scenario_id: Literal["low", "base", "high"]
    label: str
    weight: float
    contribution: float
    broken_commitments: float


class StrategyResult(BaseModel):
    id: StrategyId
    label: str  # "Do nothing" | "Moves only" | "Pricing only" | "Joint"
    expected_contribution: float  # excludes broken-commitment penalties
    expected_broken_commitments: float
    expected_penalty: float
    objective: float  # expected_contribution - expected_penalty
    week1: float  # contribution accrued on days 1-7
    week2: float  # contribution accrued on days 8-14
    components: Components
    by_scenario: list[ScenarioOutcome]
    status: SolverStatus
    gap: Optional[float]  # relative MIP gap, 0.0 when proven optimal; null if infeasible
    solve_ms: float
    action_count: int


class Action(BaseModel):
    """One recommended action. Fields not relevant to `type` are null.

    id is deterministic and stable across solves, so two plans can be diffed by id:
      move:      "move:{origin}>{dest}:{class_id}:{mode}:d{dispatch_day}"
      rate:      "rate:{branch_id}:{class_id}"
      fee:       "fee:{branch_id}"
      incentive: "incentive:{branch_id}"
    """

    id: str
    type: ActionType
    decision: Literal["proposed", "approved"] = "proposed"  # approved = sent in SolveRequest.approved
    label: str  # "Drive 2 box trucks Hartford to New Haven"
    why: str  # one generated sentence
    affected_branches: list[BranchId]
    cost: float  # transport cost (move), expected payments (incentive), else 0; excludes change cost

    # move
    origin: Optional[BranchId] = None
    dest: Optional[BranchId] = None
    mode: Optional[Mode] = None
    dispatch_day: Optional[int] = None
    arrival_day: Optional[int] = None  # first day the truck is available at dest
    count: Optional[int] = None

    # rate / fee / incentive
    branch_id: Optional[BranchId] = None
    class_id: Optional[ClassId] = None  # move and rate
    tier_pct: Optional[float] = None  # rate: -0.2 | -0.1 | 0.1
    fee: Optional[float] = None  # fee: 50 | 100
    amount: Optional[float] = None  # incentive: 40 | 80
    from_branch_id: Optional[BranchId] = None  # incentive: where the returns were due
    expected_redirects: Optional[float] = None  # incentive


class BrokenCommitment(BaseModel):
    booking_id: str
    origin: BranchId
    class_id: ClassId
    start_day: int
    expected_count: float  # scenario-weighted


class BridgeStep(BaseModel):
    key: Literal[
        "rental_revenue",
        "fee_revenue",
        "variable_cost",
        "incentive_payments",
        "transport_cost",
        "change_cost",
    ]
    label: str
    delta: float  # signed effect on contribution (costs that rise are negative)


class Bridge(BaseModel):
    start: float  # do-nothing expected contribution
    steps: list[BridgeStep]  # always all six keys, in the order above
    end: float  # joint expected contribution; start + sum(delta) == end


class DownsideRow(BaseModel):
    scenario_id: Literal["low", "base", "high"]
    label: str
    weight: float
    plan: float
    do_nothing: float


class ScorecardNumbers(BaseModel):
    revenue: float
    rented_truck_days: float
    assigned_fleet_days: float
    utilization: float  # rented_truck_days / assigned_fleet_days, 0..1


class AdjustedScorecard(BaseModel):
    actual_revenue: float
    credit: float  # max(0, baseline revenue - actual revenue)
    revenue: float  # actual_revenue + credit
    rented_truck_days: float
    assigned_fleet_days: float  # follows the truck
    utilization: float


class ScorecardDelta(BaseModel):
    revenue: float
    rented_truck_days: float
    utilization: float  # percentage-point change expressed as a fraction (0.02 = +2 pts)


class BranchScorecard(BaseModel):
    branch_id: BranchId
    baseline: ScorecardNumbers  # do nothing, current rules
    actual: ScorecardNumbers  # joint plan, current rules
    delta: ScorecardDelta  # actual - baseline
    adjusted: AdjustedScorecard  # joint plan, illustrative hold-harmless rules
    action_ids: list[str]  # plan actions that touch this branch


class CentralAccount(BaseModel):
    total_credits: float
    transit_fleet_days: float
    credits_by_branch: dict[BranchId, float]


class InventoryRow(BaseModel):
    """Expected (scenario-weighted) daily position for one branch and class."""

    branch_id: BranchId
    class_id: ClassId
    day: int
    available_none: float  # start-of-day availability under do nothing
    available_plan: float
    unmet_none: float  # new demand at the chosen tier that went unserved, by start day
    unmet_plan: float
    unmet_revenue_none: float  # in-horizon rental revenue those unserved rentals would have earned
    unmet_revenue_plan: float
    idle_none: float  # trucks still on the lot after the day's rentals and dispatches left
    idle_plan: float


class SituationTotals(BaseModel):
    """Expected totals over the horizon, all branches and classes."""

    unserved_rentals: float
    unserved_revenue: float
    idle_truck_days: float


class Situation(BaseModel):
    do_nothing: SituationTotals
    plan: SituationTotals  # the current plan


class DecisionSummary(BaseModel):
    """Expected contribution of four reference plans, on the same inputs."""

    do_nothing: float
    best_possible: float  # joint with no approvals or rejections
    current_plan: float  # joint under the approvals and rejections sent
    approved_only: float  # exactly the approved actions and nothing else
    # The approved actions on their own can leave a confirmed booking unserved (the
    # current plan may add a move that rescues it). Contribution excludes penalties,
    # so these two say what `approved_only` leaves out.
    approved_only_broken: float = 0.0  # expected broken commitments
    approved_only_penalty: float = 0.0  # expected penalty, dollars
    cost_of_rejections: float  # best_possible - current_plan
    approved_count: int
    rejected_action_ids: list[str]


class Plan(BaseModel):
    strategy_id: StrategyId = "joint"
    actions: list[Action]  # moves by dispatch day, then rate, fee, incentive
    broken_commitments: list[BrokenCommitment]


class SolveResponse(BaseModel):
    request_key: str  # cache key of (case, params, added bookings)
    case_id: str
    params: Params  # effective parameters after overrides
    added_bookings: list[Booking]  # the reported bookings as the model saw them
    # Evidence: the four strategies with NO approvals or rejections applied.
    strategies: list[StrategyResult]  # always four, order: none, moves, pricing, joint
    # Everything below describes the CURRENT plan: joint under the decisions sent.
    # With no decisions it is identical to the joint strategy.
    plan: Plan
    plan_result: StrategyResult  # id "joint", label "Current plan"
    decision: DecisionSummary
    situation: Situation
    bridge: Bridge  # do nothing -> current plan
    downside: list[DownsideRow]  # low, base, high; `plan` is the current plan
    scorecards: list[BranchScorecard]  # one per branch, scenario order of branches
    central_account: CentralAccount
    inventory: list[InventoryRow]
    total_solve_ms: float
    cached: bool


# --------------------------------------------------------------------------- #
# Action counterfactual (POST /api/explain/action)
# --------------------------------------------------------------------------- #


class ExplainRequest(SolveRequest):
    action_id: str  # must be an id from the joint plan of the same inputs


class AltMode(BaseModel):
    mode: Mode
    allowed: bool  # false if the lane is too long for staff
    arrival_day: Optional[int]
    cost: Optional[float]
    arrives_in_time: Optional[bool]  # against shortage_day; null if no shortage day


class TransferDetail(BaseModel):
    donor_branch_id: BranchId
    receiver_branch_id: BranchId
    class_id: ClassId
    count: int
    mode: Mode
    dispatch_day: int
    arrival_day: int
    cost: float
    shortage_day: Optional[int]  # first day >= arrival with unmet demand at the receiver under do nothing
    donor_rentals_lost: float  # expected rentals at donor: replanned-without minus plan, floored at 0
    receiver_rentals_gained: float  # expected rentals at receiver: plan minus replanned-without, floored at 0
    alt_mode: AltMode


class LeverDetail(BaseModel):
    """For rate, fee and incentive actions: plan minus replanned-without."""

    rentals_delta: float
    revenue_delta: float
    cost_delta: float


class ExplainResponse(BaseModel):
    action: Action
    forbidden: str  # plain sentence saying exactly what was forbidden
    plan_value: float  # joint objective
    replanned_value: float  # objective of the re-solve with the action forbidden
    reduction: float  # plan_value - replanned_value, >= 0 up to solver gap
    status: SolverStatus
    gap: Optional[float]
    replanned_actions: list[Action]
    transfer_detail: Optional[TransferDetail]  # moves only
    lever_detail: Optional[LeverDetail]  # rate, fee, incentive only
    affected_scorecards: list[BranchScorecard]  # from the joint plan
    solve_ms: float


# --------------------------------------------------------------------------- #
# Value of every action on the current plan (POST /api/explain/batch)
# --------------------------------------------------------------------------- #


class ExplainBatchRequest(SolveRequest):
    action_ids: Optional[list[str]] = None  # default: every action in the current plan


class ActionValue(BaseModel):
    action_id: str
    cost: float  # same as Action.cost
    reduction: float  # current-plan objective lost if this action is refused, after replanning
    status: SolverStatus
    gap: Optional[float]


class ExplainBatchResponse(BaseModel):
    items: list[ActionValue]
    solve_ms: float
