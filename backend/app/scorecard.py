"""Branch layer: actual impact under current rules, and the illustrative hold-harmless
scorecard with its central account (contract 4.17-4.19).

Nothing here feeds back into the model. It only reads two solved plans, so no choice of
credit policy can change company contribution.
"""

from __future__ import annotations

from typing import Iterable

import numpy as np

from .model import Solution
from .schemas import (
    Action,
    AdjustedScorecard,
    BranchScorecard,
    CentralAccount,
    Scenario,
    ScorecardDelta,
    ScorecardNumbers,
)


def _money(x: float) -> float:
    return round(float(x) + 0.0, 2)


def _util(rented: float, assigned: float) -> float:
    return round(rented / assigned, 4) if assigned > 0 else 0.0


def network_revenue(sol: Solution) -> float:
    """Expected rental plus drop-fee revenue, unrounded."""
    return float(sol.branch_revenue().sum())


def build_scorecards(
    scenario: Scenario,
    baseline: Solution,
    plan: Solution,
    actions: Iterable[Action] = (),
    *,
    credit_share: float = 1.0,
) -> tuple[list[BranchScorecard], CentralAccount]:
    """One scorecard per branch plus the central account.

    credit_share is the credit policy knob: the share of a branch's revenue shortfall
    against the do-nothing baseline that HQ credits back (1.0 = hold harmless).
    """
    actions = list(actions)
    H = plan.horizon
    branches = plan.branch_ids
    bi = {b: i for i, b in enumerate(branches)}

    assigned = np.zeros(len(branches))
    for fr in scenario.fleet:
        if fr.branch_id in bi:
            assigned[bi[fr.branch_id]] += fr.assigned_fleet
    assigned_days = assigned * H

    # Adjusted rules: assignment follows the truck.
    adj_days = assigned_days.copy()
    transit_days = 0.0
    for mv in plan.moves:
        arrival = min(mv.arrival_day, H + 1)
        adj_days[bi[mv.origin]] -= mv.count * (H - mv.dispatch_day + 1)
        adj_days[bi[mv.dest]] += mv.count * (H - arrival + 1)
        transit_days += mv.count * (arrival - mv.dispatch_day)

    rev0, rev1 = baseline.branch_revenue(), plan.branch_revenue()
    rent0 = baseline.expect(baseline.rented).sum(axis=(1, 2))
    rent1 = plan.expect(plan.rented).sum(axis=(1, 2))

    cards: list[BranchScorecard] = []
    credits: dict[str, float] = {}
    for b, i in bi.items():
        base = ScorecardNumbers(
            revenue=_money(rev0[i]),
            rented_truck_days=round(float(rent0[i]), 2),
            assigned_fleet_days=float(assigned_days[i]),
            utilization=_util(rent0[i], assigned_days[i]),
        )
        actual = ScorecardNumbers(
            revenue=_money(rev1[i]),
            rented_truck_days=round(float(rent1[i]), 2),
            assigned_fleet_days=float(assigned_days[i]),
            utilization=_util(rent1[i], assigned_days[i]),
        )
        credit = _money(max(0.0, base.revenue - actual.revenue) * credit_share)
        credits[b] = credit
        adjusted = AdjustedScorecard(
            actual_revenue=actual.revenue,
            credit=credit,
            revenue=_money(actual.revenue + credit),
            rented_truck_days=actual.rented_truck_days,
            assigned_fleet_days=float(adj_days[i]),
            utilization=_util(rent1[i], adj_days[i]),
        )
        cards.append(
            BranchScorecard(
                branch_id=b,
                baseline=base,
                actual=actual,
                delta=ScorecardDelta(
                    revenue=_money(actual.revenue - base.revenue),
                    rented_truck_days=round(
                        actual.rented_truck_days - base.rented_truck_days, 2
                    ),
                    utilization=round(actual.utilization - base.utilization, 4),
                ),
                adjusted=adjusted,
                action_ids=[a.id for a in actions if b in a.affected_branches],
            )
        )
    account = CentralAccount(
        total_credits=_money(sum(credits.values())),
        transit_fleet_days=float(transit_days),
        credits_by_branch=credits,
    )
    return cards, account
