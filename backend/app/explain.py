"""Everything that explains a solve: strategy comparison, bridge, week split, downside
rows, inventory rows, the action list with why sentences, and the action counterfactual.

Every number comes from a solved model (`model.Solution`); nothing is re-estimated here.
Money is rounded to cents in this module, at the response boundary.
"""

from __future__ import annotations

from typing import Iterable, Optional

import numpy as np

from . import model as M
from .model import Solution
from .schemas import (
    Action,
    ActionValue,
    DecisionSummary,
    Situation,
    SituationTotals,
    AltMode,
    Booking,
    Bridge,
    BridgeStep,
    BrokenCommitment,
    Components,
    DownsideRow,
    ExplainResponse,
    InventoryRow,
    LeverDetail,
    Params,
    Plan,
    Scenario,
    ScenarioOutcome,
    SolveResponse,
    StrategyResult,
    TransferDetail,
)
from .scorecard import build_scorecards

DAY_NAMES = ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday"]
BRIDGE_LABELS = {
    "rental_revenue": "Rental revenue",
    "fee_revenue": "Drop-fee revenue",
    "variable_cost": "Variable cost",
    "incentive_payments": "Incentive payments",
    "transport_cost": "Transport cost",
    "change_cost": "Change costs",
}
_SHORT = 0.01  # expected rentals below this are not called a shortage


def r2(x: float) -> float:
    return round(float(x) + 0.0, 2)


def day_name(day: int) -> str:
    """Day 1 is a Monday. Week-2 days are spelled out so they cannot be misread."""
    name = DAY_NAMES[(day - 1) % 7]
    week = (day - 1) // 7 + 1
    return name if week == 1 else f"{name} of week {week}"


def _possessive_shortage(day: int) -> str:
    if day <= 7:
        return f"{day_name(day)}'s shortage"
    return f"the shortage on {day_name(day)}"


def _usd(x: float) -> str:
    return f"${x:,.0f}"


def _pct(x: float) -> str:
    return f"{abs(x) * 100:.0f}%"


def _n(x: float) -> str:
    """A count for an ops lead: whole numbers, one decimal only below 1."""
    if x >= 0.95:
        return f"{round(x):,}"
    return f"{x:.1f}"


def _plural(noun: str, x: float) -> str:
    return noun if _n(x) == "1" else noun + "s"


def _rentals_phrase(x: float) -> str:
    """'about 27 rentals are' / 'about 1 rental is'."""
    return f"about {_n(x)} {_plural('rental', x)} {'is' if _n(x) == '1' else 'are'}"


class _Names:
    def __init__(self, scenario: Scenario):
        self.nearest = {b.id: b.nearest_branch_id for b in scenario.branches}
        self.branch = {b.id: b.short_name for b in scenario.branches}
        self.cls = {k.id: k.short_name for k in scenario.classes}

    def trucks(self, class_id: str, n: int) -> str:
        s = self.cls.get(class_id, class_id)
        return s if n == 1 else s + "s"


# --------------------------------------------------------------------------- #
# Strategy results, bridge, downside, inventory
# --------------------------------------------------------------------------- #


def week_split(sol: Solution) -> tuple[float, float]:
    by_day = sol.contribution_by_day()
    return r2(by_day[:7].sum()), r2(by_day[7:].sum())


def strategy_result(sid: str, label: str, sol: Solution) -> StrategyResult:
    w1, w2 = week_split(sol)
    contribution = r2(w1 + w2)
    penalty = r2(sol.expected_penalty)
    comps = sol.components()
    per_s = sol.contribution_by_scenario()
    broken_s = sol.broken_by_scenario()
    return StrategyResult(
        id=sid,
        label=label,
        expected_contribution=contribution,
        expected_broken_commitments=round(sol.expected_broken, 4),
        expected_penalty=penalty,
        objective=r2(contribution - penalty),
        week1=w1,
        week2=w2,
        components=Components(**{k: r2(v) for k, v in comps.items()}),
        by_scenario=[
            ScenarioOutcome(
                scenario_id=sol.scenario_ids[i],
                label=sol.scenario_labels[i],
                weight=float(sol.weights[i]),
                contribution=r2(per_s[i]),
                broken_commitments=round(float(broken_s[i]), 4),
            )
            for i in range(len(sol.weights))
        ],
        status=sol.status,
        gap=sol.gap,
        solve_ms=round(sol.solve_ms, 1),
        action_count=sol.action_count,
    )


def build_bridge(none: Solution, plan: Solution) -> Bridge:
    """Do nothing to the plan, by component. start + sum(delta) == end exactly: the
    sub-cent rounding residual is folded into the rental revenue step."""
    start = r2(sum(week_split(none)))
    end = r2(sum(week_split(plan)))
    c0, c1 = none.components(), plan.components()
    steps = []
    for i, key in enumerate(M.COMPONENTS):
        steps.append(
            BridgeStep(
                key=key, label=BRIDGE_LABELS[key],
                delta=r2(M.SIGNS[i] * (c1[key] - c0[key])),
            )
        )
    residual = r2(end - start - sum(s.delta for s in steps))
    if residual:
        steps[0].delta = r2(steps[0].delta + residual)
    return Bridge(start=start, steps=steps, end=end)


def build_downside(none: Solution, plan: Solution) -> list[DownsideRow]:
    a, b = plan.contribution_by_scenario(), none.contribution_by_scenario()
    return [
        DownsideRow(
            scenario_id=plan.scenario_ids[i],
            label=plan.scenario_labels[i],
            weight=float(plan.weights[i]),
            plan=r2(a[i]),
            do_nothing=r2(b[i]),
        )
        for i in range(len(plan.weights))
    ]


def build_inventory(none: Solution, plan: Solution,
                    only: Optional[Solution] = None) -> list[InventoryRow]:
    """only: exactly the approved actions; defaults to do nothing."""
    only = only or none
    a0, a1, a2 = none.expect(none.avail), plan.expect(plan.avail), only.expect(only.avail)
    u0, u1, u2 = none.expect(none.unmet), plan.expect(plan.unmet), only.expect(only.unmet)
    v0, v1, v2 = (none.expect(none.unmet_revenue), plan.expect(plan.unmet_revenue),
                  only.expect(only.unmet_revenue))
    i0, i1, i2 = none.expect(none.idle), plan.expect(plan.idle), only.expect(only.idle)
    rows = []
    for i, b in enumerate(plan.branch_ids):
        for j, k in enumerate(plan.class_ids):
            for d in range(plan.horizon):
                rows.append(
                    InventoryRow(
                        branch_id=b, class_id=k, day=d + 1,
                        available_none=round(float(a0[i, j, d]), 3),
                        available_plan=round(float(a1[i, j, d]), 3),
                        available_approved=round(float(a2[i, j, d]), 3),
                        unmet_none=round(float(u0[i, j, d]), 3),
                        unmet_plan=round(float(u1[i, j, d]), 3),
                        unmet_approved=round(float(u2[i, j, d]), 3),
                        unmet_revenue_none=r2(v0[i, j, d]),
                        unmet_revenue_plan=r2(v1[i, j, d]),
                        unmet_revenue_approved=r2(v2[i, j, d]),
                        idle_none=round(float(i0[i, j, d]), 3),
                        idle_plan=round(float(i1[i, j, d]), 3),
                        idle_approved=round(float(i2[i, j, d]), 3),
                    )
                )
    return rows


def build_broken(sol: Solution) -> list[BrokenCommitment]:
    exp = sol.expect(sol.broken) if sol.broken.size else np.zeros(0)
    return [
        BrokenCommitment(
            booking_id=bk.id, origin=bk.origin, class_id=bk.class_id,
            start_day=bk.start_day, expected_count=round(float(exp[n]), 4),
        )
        for n, bk in enumerate(sol.bookings)
        if exp[n] > 1e-6
    ]


# --------------------------------------------------------------------------- #
# Actions and why sentences
# --------------------------------------------------------------------------- #


def shortage_day(none: Solution, branch: str, class_id: str, from_day: int) -> Optional[int]:
    """First day >= from_day with unmet new demand at the branch under do nothing."""
    b, k = none.branch_ids.index(branch), none.class_ids.index(class_id)
    unmet = none.expect(none.unmet)[b, k]
    for d in range(max(from_day, 1), none.horizon + 1):
        if unmet[d - 1] > _SHORT:
            return d
    return None


def _broken_day(none: Solution, branch: str, class_id: str, from_day: int) -> Optional[int]:
    """First start day >= from_day of a confirmed booking do nothing fails to serve."""
    if not none.broken.size:
        return None
    exp = none.expect(none.broken)
    days = [
        bk.start_day
        for n, bk in enumerate(none.bookings)
        if bk.origin == branch and bk.class_id == class_id
        and bk.start_day >= from_day and exp[n] > _SHORT
    ]
    return min(days) if days else None


def alt_mode_for(scenario: Scenario, params: Params, mv: M.MoveChoice,
                 short: Optional[int]) -> AltMode:
    lane = next(
        (ln for ln in scenario.lanes if ln.origin == mv.origin and ln.dest == mv.dest), None
    )
    other = "hauler" if mv.mode == "staff" else "staff"
    if lane is None:
        return AltMode(mode=other, allowed=False, arrival_day=None, cost=None,
                       arrives_in_time=None)
    if other == "staff":
        allowed = lane.staff_allowed and lane.miles <= params.staff_max_miles
        transit = params.staff_transit_days
        unit = M.staff_unit_cost(lane.miles, params)
    else:
        allowed, transit = True, params.hauler_transit_days
        unit = M.hauler_unit_cost(lane.miles, params)
    if not allowed:
        return AltMode(mode=other, allowed=False, arrival_day=None, cost=None,
                       arrives_in_time=None)
    arrival = mv.dispatch_day + transit
    return AltMode(
        mode=other, allowed=True, arrival_day=arrival, cost=r2(unit * mv.count),
        arrives_in_time=None if short is None else arrival <= short,
    )


def _move_why(scenario: Scenario, params: Params, plan: Solution, none: Solution,
              mv: M.MoveChoice, names: _Names, chosen: bool = True) -> str:
    # The label already names the move and the card gives its dates: start at the reason.
    n = mv.count
    them = "it" if n == 1 else "them"
    o, d = names.branch[mv.origin], names.branch[mv.dest]
    head = f"Arrives {day_name(mv.arrival_day)}"
    short = shortage_day(none, mv.dest, mv.class_id, mv.arrival_day)
    if short is None:
        broken = _broken_day(none, mv.dest, mv.class_id, mv.arrival_day)
        if broken is not None:
            return (
                f"{head}, in time for confirmed bookings starting {day_name(broken)} "
                f"that {d} could not serve otherwise."
            )
        if not chosen:  # held by an approval: the solver makes no claim for it
            return f"{head}. {d} turns no rentals away from then on if nothing changes."
        return f"{head}, and the plan earns more with {them} at {d} than at {o}."

    if mv.arrival_day < short:
        head += f", before {_possessive_shortage(short)}"
    else:
        head += f", in time for {_possessive_shortage(short)}"

    alt = alt_mode_for(scenario, params, mv, short)
    alt_name = "a hauler" if alt.mode == "hauler" else "a staff drive"
    if not alt.allowed:
        return f"{head}, and the lane is too long for a staff drive."
    if alt.arrives_in_time is False:
        return f"{head}, and {alt_name} would arrive too late."
    extra = (alt.cost or 0.0) - mv.cost
    if extra > 0.005:
        return f"{head}, and {alt_name} would cost {_usd(extra)} more."
    if alt.mode == "staff":
        used = sum(
            m.count for m in plan.moves
            if m.mode == "staff" and m.origin == mv.origin
            and m.dispatch_day == mv.dispatch_day
        )
        if used >= params.staff_max_per_branch_day:
            return (
                f"{head}, and {o}'s {params.staff_max_per_branch_day} staff drives "
                f"that day are already used."
            )
    return head + "."


def _rate_why(plan: Solution, none: Solution, b: str, k: str, pct: float,
              names: _Names) -> str:
    i, j = plan.branch_ids.index(b), plan.class_ids.index(k)
    unmet0 = float(none.expect(none.unmet)[i, j].sum())
    idle0 = float(none.expect(none.idle)[i, j].mean())
    r0 = float(none.expect(none.starts)[i, j].sum())
    r1 = float(plan.expect(plan.starts)[i, j].sum())
    rev0 = float(none.expect(none.money)[M.C_RENT, i].sum())
    rev1 = float(plan.expect(plan.money)[M.C_RENT, i].sum())
    cls, br = names.cls[k], names.branch[b]
    # The label already says which rate moves and where: start at the reason.
    if pct > 0:
        if unmet0 >= 0.5:
            phrase = _rentals_phrase(unmet0)
            return (
                f"{phrase[0].upper()}{phrase[1:]} turned away there for lack of "
                f"trucks if nothing changes, so the higher rate earns more from the "
                f"trucks it has."
            )
    else:
        if idle0 >= 0.5 and round(r1) > round(r0):
            n_idle = max(1, round(idle0))
            sit = "sits" if n_idle == 1 else "sit"
            return (
                f"About {n_idle} {names.trucks(k, n_idle)} {sit} idle there "
                f"each day if nothing changes, and the discount lifts rentals from "
                f"about {_n(r0)} to about {_n(r1)}."
            )
    return (
        f"With the rest of the plan, {cls} rentals there go from about "
        f"{_n(r0)} to about {_n(r1)} and {br}'s rental revenue from {_usd(rev0)} to "
        f"{_usd(rev1)}."
    )


def _fee_facts(plan: Solution, j: str) -> tuple[float, float, Optional[str], float, float]:
    """deterred demand, rebooked rentals, main rebooking branch, its share, fees."""
    i = plan.branch_ids.index(j)
    deterred = float(plan.expect(plan.fee_deterred)[i])
    div = plan.expect(plan.fee_diverted)[i]
    total = float(div.sum())
    to = plan.branch_ids[int(np.argmax(div))] if total > 1e-9 else None
    share = float(div.max() / total) if total > 1e-9 else 0.0
    fee_rev = float(plan.expect(plan.money)[M.C_FEE, i].sum())
    return deterred, total, to, share, fee_rev


def _fee_why(plan: Solution, j: str, fee: float, names: _Names) -> str:
    deterred, rebooked, to, share, fee_rev = _fee_facts(plan, j)
    br = names.branch[j]
    s = f"Deters about {_n(deterred)} one-way {_plural('rental', deterred)} into {br}"
    # Name the rebooking branch only when it is the fee branch's own neighbour and
    # takes nearly all of the rebooked rentals; otherwise the detail misleads.
    if (
        to is not None and to == names.nearest.get(j) and share >= 0.9
        and rebooked >= 0.95 and round(rebooked) < round(deterred)
    ):
        s += f" (about {_n(rebooked)} rebook to {names.branch[to]} instead)"
    return s + f" and collects about {_usd(fee_rev)} in fees."


def _incentive_facts(plan: Solution, b: str) -> tuple[float, Optional[str], float]:
    i = plan.branch_ids.index(b)
    red = plan.expect(plan.redirects)[i]
    frm = plan.branch_ids[int(np.argmax(red))] if red.sum() > 1e-9 else None
    paid = float(plan.expect(plan.money)[M.C_INC, i].sum())
    return float(red.sum()), frm, paid


def _incentive_why(plan: Solution, none: Solution, b: str, amount: float,
                   frm: Optional[str], redirects: float, paid: float,
                   names: _Names) -> str:
    i = plan.branch_ids.index(b)
    br = names.branch[b]
    verb = "comes" if _n(redirects) == "1" else "come"
    s = (
        f"About {_n(redirects)} {_plural('truck', redirects)} {verb} back to {br} "
        f"for about {_usd(paid)} in payments"
    )
    unmet0 = float(none.expect(none.unmet)[i].sum())
    if unmet0 >= 0.5:
        s += f", where {_rentals_phrase(unmet0)} turned away if nothing changes"
    return s + "."


def build_actions(scenario: Scenario, params: Params, plan: Solution,
                  none: Solution, approved_ids: Iterable[str] = ()) -> list[Action]:
    """Moves by dispatch day, then rate, fee, incentive (contract 3, "Action ids").
    Actions whose id is in approved_ids carry decision="approved"."""
    names = _Names(scenario)
    approved_ids = set(approved_ids)
    actions: list[Action] = []
    for mv in plan.moves:
        verb = "Drive" if mv.mode == "staff" else "Haul"
        actions.append(
            Action(
                id=mv.id, type="move",
                label=(
                    f"{verb} {mv.count} {names.trucks(mv.class_id, mv.count)} "
                    f"{names.branch[mv.origin]} to {names.branch[mv.dest]}"
                ),
                why=_move_why(scenario, params, plan, none, mv, names,
                              chosen=mv.id not in approved_ids),
                affected_branches=[mv.origin, mv.dest],
                cost=r2(mv.cost),
                origin=mv.origin, dest=mv.dest, class_id=mv.class_id, mode=mv.mode,
                dispatch_day=mv.dispatch_day, arrival_day=mv.arrival_day, count=mv.count,
            )
        )
    for (b, k), pct in plan.rate_tier.items():
        if abs(pct) < 1e-12:
            continue
        verb = "Raise" if pct > 0 else "Cut"
        actions.append(
            Action(
                id=f"rate:{b}:{k}", type="rate",
                label=f"{verb} {names.cls[k]} rate {_pct(pct)} at {names.branch[b]}",
                why=_rate_why(plan, none, b, k, pct, names),
                affected_branches=[b], cost=0.0,
                branch_id=b, class_id=k, tier_pct=pct,
            )
        )
    for j, fee in plan.fee_tier.items():
        if abs(fee) < 1e-12:
            continue
        _d, rebooked, to, _share, _rev = _fee_facts(plan, j)
        affected = [j] + ([to] if to and rebooked > 0.05 else [])
        actions.append(
            Action(
                id=f"fee:{j}", type="fee",
                label=f"Add {_usd(fee)} drop fee into {names.branch[j]}",
                why=_fee_why(plan, j, fee, names),
                affected_branches=affected, cost=0.0,
                branch_id=j, fee=fee,
            )
        )
    for b, amount in plan.incentive_tier.items():
        if abs(amount) < 1e-12:
            continue
        redirects, frm, paid = _incentive_facts(plan, b)
        frm = frm or next(
            (x.id for x in scenario.branches if x.nearest_branch_id == b), b
        )
        actions.append(
            Action(
                id=f"incentive:{b}", type="incentive",
                label=(
                    f"Offer {_usd(amount)} to return at {names.branch[b]} "
                    f"instead of {names.branch[frm]}"
                ),
                why=_incentive_why(plan, none, b, amount, frm, redirects, paid, names),
                affected_branches=[b] if frm == b else [b, frm],
                cost=r2(paid),
                branch_id=b, amount=amount, from_branch_id=frm,
                expected_redirects=round(redirects, 3),
            )
        )
    for a in actions:
        if a.id in approved_ids:
            a.decision = "approved"
    return actions


# --------------------------------------------------------------------------- #
# Solve response
# --------------------------------------------------------------------------- #


def build_situation(inventory: list[InventoryRow]) -> Situation:
    """Horizon totals; by construction the sums of the inventory columns."""

    def tot(suffix: str) -> SituationTotals:
        return SituationTotals(
            unserved_rentals=round(sum(getattr(r, f"unmet_{suffix}") for r in inventory), 3),
            unserved_revenue=r2(sum(getattr(r, f"unmet_revenue_{suffix}") for r in inventory)),
            idle_truck_days=round(sum(getattr(r, f"idle_{suffix}") for r in inventory), 3),
        )

    return Situation(do_nothing=tot("none"), plan=tot("plan"), approved=tot("approved"))


def build_solve_response(
    scenario: Scenario,
    params: Params,
    added: list[Booking],
    sols: dict[str, Solution],
    *,
    current: Optional[Solution] = None,
    approved_only: Optional[Solution] = None,
    approved_ids: Iterable[str] = (),
    rejected_ids: Iterable[str] = (),
    request_key: str = "",
    case_id: Optional[str] = None,
    extra_solve_ms: float = 0.0,
) -> SolveResponse:
    """sols: the four unconstrained strategies (evidence).
    current: joint under the decisions sent; defaults to the unconstrained joint.
    approved_only: exactly the approved actions; defaults to do nothing."""
    none = sols["none"]
    plan = current or sols["joint"]
    only = approved_only or none
    approved_ids, rejected_ids = list(approved_ids), list(rejected_ids)
    actions = build_actions(scenario, params, plan, none, approved_ids)
    cards, account = build_scorecards(scenario, none, plan, actions)
    strategies = [
        strategy_result(sid, label, sols[sid]) for sid, label, _m, _p in M.STRATEGIES
    ]
    plan_result = strategy_result("joint", "Current plan", plan)
    inventory = build_inventory(none, plan, only)
    best = strategies[3].expected_contribution
    return SolveResponse(
        request_key=request_key,
        case_id=case_id or scenario.case.id,
        params=params,
        added_bookings=added,
        strategies=strategies,
        plan=Plan(strategy_id="joint", actions=actions,
                  broken_commitments=build_broken(plan)),
        plan_result=plan_result,
        decision=DecisionSummary(
            do_nothing=strategies[0].expected_contribution,
            best_possible=best,
            current_plan=plan_result.expected_contribution,
            approved_only=r2(sum(week_split(only))),
            approved_only_broken=round(only.expected_broken, 4),
            approved_only_penalty=r2(only.expected_penalty),
            cost_of_rejections=r2(best - plan_result.expected_contribution),
            approved_count=len(approved_ids),
            rejected_action_ids=rejected_ids,
        ),
        situation=build_situation(inventory),
        bridge=build_bridge(none, plan),
        downside=build_downside(none, plan),
        scorecards=cards,
        central_account=account,
        inventory=inventory,
        total_solve_ms=round(sum(s.solve_ms for s in sols.values()) + extra_solve_ms, 1),
        cached=False,
    )


# --------------------------------------------------------------------------- #
# Action counterfactual
# --------------------------------------------------------------------------- #


def forbidden_sentence(scenario: Scenario, params: Params, action: Action,
                       kept_moves: int = 0) -> str:
    names = _Names(scenario)
    tail = " Every other move and lever stayed available."
    if action.type == "move":
        s = (
            f"Closed the {names.branch[action.origin]} to {names.branch[action.dest]} "
            f"lane for {names.trucks(action.class_id, 2)}: no staff drives or hauls on "
            f"any dispatch day (days 1 to {params.dispatch_days})"
        )
        if kept_moves:
            s += ", except the other moves you approved on it"
        return s + "." + tail
    if action.type == "rate":
        return (
            f"Held the {names.cls[action.class_id]} rate at "
            f"{names.branch[action.branch_id]} at the base rate." + tail
        )
    if action.type == "fee":
        return f"Held the drop fee into {names.branch[action.branch_id]} at $0." + tail
    return f"Held the return incentive at {names.branch[action.branch_id]} at $0." + tail


def _rentals(sol: Solution, branch: Optional[str] = None,
             class_id: Optional[str] = None) -> float:
    e = sol.expect(sol.starts)
    if branch is not None:
        e = e[sol.branch_ids.index(branch)]
        if class_id is not None:
            e = e[sol.class_ids.index(class_id)]
    return float(e.sum())


def replan_without(
    scenario: Scenario,
    params: Params,
    added: Iterable[Booking],
    plan: Solution,
    action_id: str,
    approved: Iterable = (),
    rejected: Iterable[str] = (),
) -> Solution:
    """The current plan re-solved with one action refused: if it was approved it is
    un-fixed, then it is forbidden. Every other decision is kept. Warm-started from
    the current plan."""
    return M.solve(
        scenario, params, allow_moves=True, allow_pricing=True,
        forbid=[*rejected, action_id],
        approved=[a for a in approved if a.id != action_id],
        extra_bookings=list(added), hint=plan.plan_values,
    )


def plan_objective(sol: Solution) -> float:
    """Objective as reported: rounded contribution less rounded penalty."""
    return r2(r2(sum(week_split(sol))) - r2(sol.expected_penalty))


def reduction_of(plan: Solution, replanned: Solution) -> float:
    return r2(plan_objective(plan) - plan_objective(replanned))


def action_value(action: Action, plan: Solution, replanned: Solution) -> ActionValue:
    return ActionValue(
        action_id=action.id, cost=action.cost,
        reduction=reduction_of(plan, replanned),
        status=replanned.status, gap=replanned.gap,
    )


def explain_action(
    scenario: Scenario,
    params: Params,
    added: Iterable[Booking],
    sols: dict[str, Solution],
    action_id: str,
    *,
    current: Optional[Solution] = None,
    approved: Iterable = (),
    rejected: Iterable[str] = (),
    replanned: Optional[Solution] = None,
) -> Optional[ExplainResponse]:
    """Counterfactual for one action of the current plan (joint under the decisions).
    None if the id is not in that plan. Pass `replanned` to reuse a cached re-solve."""
    none = sols["none"]
    plan = current or sols["joint"]
    approved, rejected = list(approved), list(rejected)
    approved_ids = [a.id for a in approved]
    actions = build_actions(scenario, params, plan, none, approved_ids)
    action = next((a for a in actions if a.id == action_id), None)
    if action is None:
        return None
    if replanned is None:
        replanned = replan_without(scenario, params, added, plan, action_id, approved, rejected)

    transfer = lever = None
    kept = 0
    if action.type == "move":
        mv = next(m for m in plan.moves if m.id == action_id)
        lane = f"move:{mv.origin}>{mv.dest}:{mv.class_id}:"
        kept = sum(1 for i in approved_ids if i.startswith(lane) and i != action_id)
        short = shortage_day(none, mv.dest, mv.class_id, mv.arrival_day)
        transfer = TransferDetail(
            donor_branch_id=mv.origin, receiver_branch_id=mv.dest, class_id=mv.class_id,
            count=mv.count, mode=mv.mode, dispatch_day=mv.dispatch_day,
            arrival_day=mv.arrival_day, cost=r2(mv.cost), shortage_day=short,
            donor_rentals_lost=round(
                max(0.0, _rentals(replanned, mv.origin, mv.class_id)
                    - _rentals(plan, mv.origin, mv.class_id)), 3),
            receiver_rentals_gained=round(
                max(0.0, _rentals(plan, mv.dest, mv.class_id)
                    - _rentals(replanned, mv.dest, mv.class_id)), 3),
            alt_mode=alt_mode_for(scenario, params, mv, short),
        )
    else:
        c1, c0 = plan.components(), replanned.components()
        rev = lambda c: c["rental_revenue"] + c["fee_revenue"]  # noqa: E731
        cost = lambda c: (  # noqa: E731
            c["variable_cost"] + c["incentive_payments"] + c["transport_cost"]
            + c["change_cost"]
        )
        lever = LeverDetail(
            rentals_delta=round(_rentals(plan) - _rentals(replanned), 3),
            revenue_delta=r2(rev(c1) - rev(c0)),
            cost_delta=r2(cost(c1) - cost(c0)),
        )

    cards, _account = build_scorecards(scenario, none, plan, actions)
    still_approved = [i for i in approved_ids if i != action_id]
    return ExplainResponse(
        action=action,
        forbidden=forbidden_sentence(scenario, params, action, kept),
        plan_value=plan_objective(plan),
        replanned_value=plan_objective(replanned),
        reduction=reduction_of(plan, replanned),
        status=replanned.status,
        gap=replanned.gap,
        replanned_actions=build_actions(scenario, params, replanned, none, still_approved),
        transfer_detail=transfer,
        lever_detail=lever,
        affected_scorecards=[c for c in cards if c.branch_id in action.affected_branches],
        solve_ms=round(replanned.solve_ms, 1),
    )
