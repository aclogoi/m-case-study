"""Branch-layer invariants (planning doc "Branch layer")."""

import pytest

from app import explain
from app.model import solve_all
from app.scorecard import build_scorecards, network_revenue


def _cards(scenario, sols, **kw):
    actions = explain.build_actions(scenario, scenario.params, sols["joint"], sols["none"])
    return build_scorecards(scenario, sols["none"], sols["joint"], actions, **kw)


def test_credit_policy_does_not_change_company_contribution(rich_scenario, rich_sols):
    before = {k: (s.expected_contribution, s.objective) for k, s in rich_sols.items()}
    full, acct_full = _cards(rich_scenario, rich_sols, credit_share=1.0)
    off, acct_off = _cards(rich_scenario, rich_sols, credit_share=0.0)
    half, acct_half = _cards(rich_scenario, rich_sols, credit_share=0.5)
    assert before == {k: (s.expected_contribution, s.objective) for k, s in rich_sols.items()}
    # the policy only moves scorecard accounting
    assert [c.actual for c in full] == [c.actual for c in off] == [c.actual for c in half]
    assert acct_off.total_credits == 0.0
    assert acct_half.total_credits == pytest.approx(acct_full.total_credits / 2, abs=0.02)


def test_branch_revenues_sum_to_network_revenue(rich_scenario, rich_sols):
    cards, account = _cards(rich_scenario, rich_sols)
    comps = rich_sols["joint"].components()
    network = comps["rental_revenue"] + comps["fee_revenue"]
    assert network == pytest.approx(network_revenue(rich_sols["joint"]))
    assert sum(c.actual.revenue for c in cards) == pytest.approx(network, abs=0.03)
    base = rich_sols["none"].components()
    assert sum(c.baseline.revenue for c in cards) == pytest.approx(
        base["rental_revenue"] + base["fee_revenue"], abs=0.03
    )
    # adjusted revenues exceed actual by exactly the central account's credits
    assert sum(c.adjusted.revenue for c in cards) == pytest.approx(
        network + account.total_credits, abs=0.03
    )
    assert account.total_credits == pytest.approx(sum(account.credits_by_branch.values()))
    for c in cards:
        assert c.adjusted.credit == pytest.approx(
            max(0.0, c.baseline.revenue - c.actual.revenue), abs=0.011
        )
        assert c.adjusted.revenue >= c.baseline.revenue - 0.011  # held harmless


def test_fleet_days_follow_the_truck(rich_scenario, rich_sols):
    cards, account = _cards(rich_scenario, rich_sols)
    total = sum(f.assigned_fleet for f in rich_scenario.fleet) * 14
    assert sum(c.actual.assigned_fleet_days for c in cards) == total
    assert sum(c.adjusted.assigned_fleet_days for c in cards) + account.transit_fleet_days == total
    for c in cards:
        assert c.baseline.assigned_fleet_days == c.actual.assigned_fleet_days
        assert c.actual.utilization >= 0
        assert c.delta.revenue == pytest.approx(c.actual.revenue - c.baseline.revenue, abs=0.011)


def test_scorecard_by_hand(transfer_scenario):
    """Two trucks drive Hartford -> New Haven on day 1 and arrive day 2."""
    sols = solve_all(transfer_scenario)
    cards, account = _cards(transfer_scenario, sols)
    hfd, nhv = cards
    assert (hfd.branch_id, nhv.branch_id) == ("HFD", "NHV")
    assert hfd.actual.assigned_fleet_days == 56 and nhv.actual.assigned_fleet_days == 0
    assert hfd.adjusted.assigned_fleet_days == 56 - 2 * 14
    assert nhv.adjusted.assigned_fleet_days == 2 * 13
    assert account.transit_fleet_days == 2
    assert nhv.actual.revenue == pytest.approx(1.9 * 2 * 110)
    assert nhv.actual.rented_truck_days == pytest.approx(3.8)
    assert nhv.adjusted.utilization == pytest.approx(3.8 / 26, abs=1e-4)
    assert hfd.adjusted.credit == 0 and account.total_credits == 0
    assert hfd.action_ids == nhv.action_ids == ["move:HFD>NHV:box16:staff:d1"]


def test_credit_covers_a_branch_that_loses_revenue():
    """A $100 fee into Portland costs Hartford 1.2 one-way rentals (3 deterred, 1.8
    rebook). Hartford is credited the lost revenue; Portland keeps its fee revenue."""
    from app.model import solve
    from app.schemas import Params

    from .conftest import make_scenario, oneway

    sc = make_scenario(
        {("HFD", "NHV"): 40.0, ("HFD", "PWM"): 230.0, ("NHV", "PWM"): 260.0},
        {("HFD", "box16"): 20, ("NHV", "box16"): 0, ("PWM", "box16"): 0},
        demand=[oneway("ow", "HFD", "PWM", 1, 10.0)],
        params=Params(fee_divert_share=0.60),  # pinned: the arithmetic below assumes 60%
    )
    none = solve(sc, allow_moves=False, allow_pricing=False)
    plan = solve(sc)
    cards, account = build_scorecards(sc, none, plan)
    by = {c.branch_id: c for c in cards}
    assert by["HFD"].baseline.revenue == pytest.approx(3300.0)
    assert by["HFD"].actual.revenue == pytest.approx(8.8 * 330)
    assert by["HFD"].adjusted.credit == pytest.approx(1.2 * 330)
    assert by["HFD"].adjusted.revenue == pytest.approx(3300.0)
    assert by["PWM"].actual.revenue == pytest.approx(700.0) and by["PWM"].adjusted.credit == 0
    assert account.total_credits == pytest.approx(396.0)
    assert account.credits_by_branch == {"HFD": 396.0, "NHV": 0.0, "PWM": 0.0}
    assert sum(c.adjusted.revenue for c in cards) == pytest.approx(
        network_revenue(plan) + account.total_credits
    )
