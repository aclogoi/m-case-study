"""Approve / reject decisions (contract section 7) on hand-built scenarios."""

import pytest

from app import explain
from app.model import solve, solve_all
from app.schemas import ApprovedAction, InProgressReturn

from .conftest import local, make_scenario

HAUL = 150 + 2.5 * 200  # one hauler move on the 200-mile lane


def _approvals(actions):
    return [
        ApprovedAction(id=a.id, count=a.count, tier_pct=a.tier_pct, fee=a.fee, amount=a.amount)
        for a in actions
    ]


def test_approved_move_is_held_even_when_the_solver_would_not_choose_it(late_transfer_scenario):
    free = solve(late_transfer_scenario)
    assert free.moves == []
    ok = [ApprovedAction(id="move:HFD>NHV:box16:hauler:d1", count=1)]
    for flags in ({}, {"allow_moves": False, "allow_pricing": False}):
        sol = solve(late_transfer_scenario, approved=ok, **flags)
        assert sol.status == "optimal"
        assert [(m.id, m.count) for m in sol.moves] == [("move:HFD>NHV:box16:hauler:d1", 1)]
        assert sol.objective == pytest.approx(free.objective - HAUL, abs=1e-6)
    # the why sentence makes no claim the numbers do not support
    none = solve(late_transfer_scenario, allow_moves=False, allow_pricing=False)
    sc = late_transfer_scenario
    (a,) = explain.build_actions(sc, sc.params, sol, none, [ok[0].id])
    assert a.decision == "approved"
    assert "earns more" not in a.why and "shortage" not in a.why


def test_approved_tiers_are_held(transfer_scenario):
    ok = [
        ApprovedAction(id="rate:NHV:box16", tier_pct=-0.2),
        ApprovedAction(id="fee:HFD", fee=50.0),  # no one-way demand: pure change cost
    ]
    free = solve(transfer_scenario)
    assert free.rate_tier[("NHV", "box16")] != -0.2
    sol = solve(transfer_scenario, approved=ok)
    assert sol.rate_tier[("NHV", "box16")] == -0.2 and sol.fee_tier["HFD"] == 50.0
    assert sol.components()["change_cost"] == pytest.approx(100.0)
    assert sol.objective <= free.objective + 1e-6
    assert {"rate:NHV:box16", "fee:HFD"} <= set(sol.action_ids())
    with pytest.raises(ValueError):
        solve(transfer_scenario, approved=[ApprovedAction(id="rate:NHV:box16", tier_pct=-0.15)])
    with pytest.raises(ValueError):  # staff cannot drive the 200-mile lane
        solve(transfer_scenario, approved=[ApprovedAction(id="move:HFD>PWM:box16:staff:d1", count=1)])


def test_approved_incentive_on_in_progress_returns_matches_the_solver_choice():
    sc = make_scenario(
        {("HFD", "NHV"): 40.0},
        {("HFD", "box16"): 0, ("NHV", "box16"): 0},
        demand=[local("d", "NHV", 2, 2.0)],
        in_progress=[InProgressReturn(id="ip", branch_id="HFD", origin="NHV",
                                      class_id="box16", return_day=2, count=4, kind="oneway")],
    )
    chosen = solve(sc, allow_moves=False)
    held = solve(sc, allow_moves=False, allow_pricing=False,
                 approved=[ApprovedAction(id="incentive:NHV", amount=80.0)])
    assert held.incentive_tier["NHV"] == 80.0
    assert held.objective == pytest.approx(chosen.objective, abs=1e-6)
    assert held.components() == pytest.approx(chosen.components())
    assert held.expect(held.redirects).sum() == pytest.approx(2.0)


def test_rejected_lane_is_closed_but_an_approved_move_on_it_survives(transfer_scenario):
    assert sum(m.count for m in solve(transfer_scenario).moves) == 2
    sol = solve(
        transfer_scenario,
        approved=[ApprovedAction(id="move:HFD>NHV:box16:staff:d1", count=1)],
        forbid=["move:HFD>NHV:box16:staff:d2"],  # closes the lane, both modes, all days
    )
    assert [(m.id, m.count) for m in sol.moves] == [("move:HFD>NHV:box16:staff:d1", 1)]


def test_rejecting_an_action_removes_it_and_never_improves_the_plan(rich_scenario, rich_sols):
    joint = rich_sols["joint"]
    for aid in (joint.action_ids()[0], "rate:PWM:mov26", "fee:PWM"):
        sol = solve(rich_scenario, forbid=[aid], hint=joint.plan_values)
        if aid.startswith("move:"):
            lane = ":".join(aid.split(":")[:3]) + ":"
            assert not any(i.startswith(lane) for i in sol.action_ids())
        else:
            assert aid not in sol.action_ids()
        assert sol.objective <= joint.objective + 1e-6 * abs(joint.objective)


def test_approved_only_equals_do_nothing_or_the_whole_plan(rich_scenario, rich_sols):
    sc, none, joint = rich_scenario, rich_sols["none"], rich_sols["joint"]
    nothing = solve(sc, allow_moves=False, allow_pricing=False, approved=[])
    assert nothing.objective == pytest.approx(none.objective, abs=1e-6)
    # approve every action of the joint plan: exactly those actions reproduce it
    actions = explain.build_actions(sc, sc.params, joint, none)
    everything = solve(sc, allow_moves=False, allow_pricing=False, approved=_approvals(actions))
    assert everything.action_ids() == joint.action_ids()
    assert everything.objective == pytest.approx(joint.objective, rel=1e-6)
    # approve half: between do nothing's floor of what those actions do and the joint
    some = solve(sc, allow_moves=False, allow_pricing=False, approved=_approvals(actions[::2]))
    assert some.action_ids() == [a.id for a in actions[::2]]
    assert some.objective <= joint.objective + 1e-6 * abs(joint.objective)


def test_response_under_decisions(rich_scenario, rich_sols):
    sc, none, joint = rich_scenario, rich_sols["none"], rich_sols["joint"]
    base = explain.build_solve_response(sc, sc.params, [], rich_sols)
    # no decisions: the current plan IS the joint strategy
    assert base.plan_result.model_dump(exclude={"label"}) == base.strategies[3].model_dump(exclude={"label"})
    assert base.plan_result.label == "Current plan"
    d = base.decision
    assert (d.do_nothing, d.best_possible) == (
        base.strategies[0].expected_contribution, base.strategies[3].expected_contribution)
    assert d.current_plan == d.best_possible and d.approved_only == d.do_nothing
    assert d.cost_of_rejections == 0 and d.approved_count == 0 and d.rejected_action_ids == []
    assert all(a.decision == "proposed" for a in base.plan.actions)

    keep, drop = base.plan.actions[0], "rate:PWM:mov26"
    approved = _approvals([keep])
    current = solve(sc, approved=approved, forbid=[drop], hint=joint.plan_values)
    only = solve(sc, allow_moves=False, allow_pricing=False, approved=approved)
    res = explain.build_solve_response(
        sc, sc.params, [], rich_sols, current=current, approved_only=only,
        approved_ids=[keep.id], rejected_ids=[drop],
    )
    assert res.strategies == base.strategies  # evidence is untouched by decisions
    by_id = {a.id: a for a in res.plan.actions}
    assert by_id[keep.id].decision == "approved" and by_id[keep.id].count == keep.count
    assert drop not in by_id
    assert all(a.decision == "proposed" for i, a in by_id.items() if i != keep.id)
    d = res.decision
    assert d.current_plan == res.plan_result.expected_contribution == res.bridge.end
    assert d.current_plan <= d.best_possible + 0.01
    assert d.cost_of_rejections == pytest.approx(d.best_possible - d.current_plan, abs=0.011)
    assert d.cost_of_rejections > 0
    assert d.approved_count == 1 and d.rejected_action_ids == [drop]
    assert d.approved_only == pytest.approx(only.expected_contribution, abs=0.011)
    assert d.approved_only_penalty == pytest.approx(only.expected_penalty, abs=0.011)
    assert d.approved_only_broken == pytest.approx(only.expected_broken, abs=1e-4)
    # net of penalties the approved set alone can never beat the plan that contains it
    assert (d.approved_only - d.approved_only_penalty
            <= d.current_plan - res.plan_result.expected_penalty + 0.02)
    assert res.downside[1].plan == res.plan_result.by_scenario[1].contribution


def test_situation_totals_are_the_inventory_sums(rich_scenario, rich_sols):
    res = explain.build_solve_response(rich_scenario, rich_scenario.params, [], rich_sols)
    inv, sit = res.inventory, res.situation
    for totals, sfx in ((sit.do_nothing, "none"), (sit.plan, "plan")):
        assert totals.unserved_rentals == pytest.approx(sum(getattr(r, f"unmet_{sfx}") for r in inv), abs=1e-6)
        assert totals.unserved_revenue == pytest.approx(sum(getattr(r, f"unmet_revenue_{sfx}") for r in inv), abs=0.005)
        assert totals.idle_truck_days == pytest.approx(sum(getattr(r, f"idle_{sfx}") for r in inv), abs=1e-6)
    assert sit.do_nothing.unserved_rentals > 0 and sit.do_nothing.idle_truck_days > 0
    for r in inv:
        assert r.idle_none >= 0 and r.idle_plan <= r.available_plan + 1e-6
        assert (r.unmet_revenue_none > 0) == (r.unmet_none > 0) or r.unmet_none < 0.01


def test_unmet_revenue_by_hand(late_transfer_scenario):
    """New Haven turns away 2 two-day box rentals on day 2 (base scenario weight 1.0
    in expectation): 2 x 2 x $110. Hartford's four trucks sit idle all 14 days."""
    sols = solve_all(late_transfer_scenario)
    res = explain.build_solve_response(late_transfer_scenario, late_transfer_scenario.params, [], sols)
    assert res.situation.do_nothing.unserved_rentals == pytest.approx(2.0)
    assert res.situation.do_nothing.unserved_revenue == pytest.approx(440.0)
    assert res.situation.do_nothing.idle_truck_days == pytest.approx(56.0)
    assert res.situation.plan == res.situation.do_nothing


def test_explaining_an_approved_action_unfixes_and_forbids_it(late_transfer_scenario):
    sc = late_transfer_scenario
    sols = solve_all(sc)
    ok = [ApprovedAction(id="move:HFD>NHV:box16:hauler:d1", count=1)]
    current = solve(sc, approved=ok)
    res = explain.explain_action(sc, sc.params, [], sols, ok[0].id, current=current, approved=ok)
    assert res.action.decision == "approved"
    assert res.replanned_actions == []
    assert res.reduction == pytest.approx(-HAUL, abs=0.01)  # refusing it saves its cost
    replanned = explain.replan_without(sc, sc.params, [], current, ok[0].id, ok, [])
    assert explain.action_value(res.action, current, replanned).reduction == res.reduction
    # not in the current plan -> None (the route turns this into 404)
    assert explain.explain_action(sc, sc.params, [], sols, "fee:NHV", current=current, approved=ok) is None


def test_wording_uses_whole_numbers(rich_scenario, rich_sols):
    import re

    sc = rich_scenario
    actions = explain.build_actions(sc, sc.params, rich_sols["joint"], rich_sols["none"])
    assert {a.type for a in actions} == {"move", "rate", "fee", "incentive"}
    for a in actions:
        assert "expected" not in a.why and "do nothing" not in a.why, a.why
        for num in re.findall(r"(?<![\$\d,.])(\d+\.\d+)", a.why):
            assert float(num) < 1, a.why  # decimals only for counts below 1
