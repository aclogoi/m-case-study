"""Explanation layer: strategies, bridge, week split, actions, counterfactual."""

import pytest

from app import explain
from app.model import solve_all


@pytest.fixture(scope="session")
def rich_response(rich_scenario, rich_sols):
    return explain.build_solve_response(
        rich_scenario, rich_scenario.params, [], rich_sols, request_key="k"
    )


def test_four_strategies_in_order(rich_response):
    assert [s.id for s in rich_response.strategies] == ["none", "moves", "pricing", "joint"]
    for s in rich_response.strategies:
        assert s.status == "optimal" and s.gap is not None and s.gap <= 1e-4
        assert s.objective == pytest.approx(s.expected_contribution - s.expected_penalty, abs=0.011)
        assert sum(o.weight for o in s.by_scenario) == pytest.approx(1.0)
        expected = sum(o.weight * o.contribution for o in s.by_scenario)
        assert expected == pytest.approx(s.expected_contribution, abs=0.02)
        c = s.components
        total = (c.rental_revenue + c.fee_revenue - c.variable_cost
                 - c.incentive_payments - c.transport_cost - c.change_cost)
        assert total == pytest.approx(s.expected_contribution, abs=0.05)


def test_bridge_and_week_split_sum_exactly(rich_response):
    b = rich_response.bridge
    assert [s.key for s in b.steps] == [
        "rental_revenue", "fee_revenue", "variable_cost",
        "incentive_payments", "transport_cost", "change_cost",
    ]
    assert round(b.start + sum(s.delta for s in b.steps), 2) == b.end
    by_id = {s.id: s for s in rich_response.strategies}
    assert b.start == by_id["none"].expected_contribution
    assert b.end == by_id["joint"].expected_contribution
    for s in rich_response.strategies:
        assert round(s.week1 + s.week2, 2) == s.expected_contribution
    # costs that rise show as negative steps
    steps = {s.key: s.delta for s in b.steps}
    assert steps["transport_cost"] < 0 and steps["change_cost"] < 0


def test_downside_rows_match_strategies(rich_response):
    by_id = {s.id: s for s in rich_response.strategies}
    assert [r.scenario_id for r in rich_response.downside] == ["low", "base", "high"]
    for row, j, n in zip(rich_response.downside, by_id["joint"].by_scenario,
                         by_id["none"].by_scenario):
        assert row.plan == j.contribution and row.do_nothing == n.contribution


def test_action_list_ids_order_and_fields(rich_response, rich_sols):
    actions = rich_response.plan.actions
    assert [a.id for a in actions] == rich_sols["joint"].action_ids()
    assert len(actions) == rich_response.strategies[3].action_count
    order = {"move": 0, "rate": 1, "fee": 2, "incentive": 3}
    assert [order[a.type] for a in actions] == sorted(order[a.type] for a in actions)
    moves = [a for a in actions if a.type == "move"]
    assert [a.dispatch_day for a in moves] == sorted(a.dispatch_day for a in moves)
    for a in actions:
        assert a.why.endswith(".") and a.label and a.affected_branches
        if a.type == "move":
            assert a.id == f"move:{a.origin}>{a.dest}:{a.class_id}:{a.mode}:d{a.dispatch_day}"
            assert a.count >= 1 and a.cost > 0
            assert a.arrival_day == a.dispatch_day + (1 if a.mode == "staff" else 2)
        elif a.type == "rate":
            assert a.tier_pct != 0 and a.id == f"rate:{a.branch_id}:{a.class_id}"
        elif a.type == "fee":
            assert a.fee > 0
        else:
            assert a.amount > 0 and a.from_branch_id and a.expected_redirects >= 0


def test_inventory_rows_cover_branch_class_day(rich_response, rich_scenario):
    n = len(rich_scenario.branches) * len(rich_scenario.classes) * 14
    assert len(rich_response.inventory) == n
    assert all(r.unmet_none >= 0 and r.available_plan >= 0 for r in rich_response.inventory)
    # nothing is approved here, so the approved-only columns are the do-nothing ones
    assert all(
        (r.unmet_approved, r.idle_approved, r.available_approved)
        == (r.unmet_none, r.idle_none, r.available_none)
        for r in rich_response.inventory
    )
    assert rich_response.situation.approved == rich_response.situation.do_nothing


def test_why_sentence_for_the_timed_transfer(transfer_scenario):
    sols = solve_all(transfer_scenario)
    actions = explain.build_actions(
        transfer_scenario, transfer_scenario.params, sols["joint"], sols["none"]
    )
    assert len(actions) == 1
    assert actions[0].label == "Drive 2 box trucks Hartford to New Haven"
    assert actions[0].why == (
        "Arrives Tuesday, in time for Tuesday's shortage, and a hauler would arrive too late."
    )


def test_why_sentence_does_not_claim_a_late_hauler_when_it_is_not(transfer_scenario):
    """Demand a day later: a hauler sent Monday would also make it, so the sentence
    must talk about cost, not timing."""
    from .conftest import local

    sc = transfer_scenario.model_copy(update={"demand": [local("d", "NHV", 3, 2.0)]})
    sols = solve_all(sc)
    actions = explain.build_actions(sc, sc.params, sols["joint"], sols["none"])
    assert actions and all(a.type == "move" and a.mode == "staff" for a in actions)
    for a in actions:
        if a.dispatch_day == 1:  # arrives Tuesday; a hauler would arrive Wednesday, in time
            assert "too late" not in a.why and "a hauler would cost $" in a.why
        else:  # sent Tuesday, a hauler would arrive Thursday
            assert "a hauler would arrive too late" in a.why
    assert any(a.dispatch_day == 1 for a in actions)


def test_counterfactual_for_a_transfer(transfer_scenario):
    sols = solve_all(transfer_scenario)
    res = explain.explain_action(
        transfer_scenario, transfer_scenario.params, [], sols, "move:HFD>NHV:box16:staff:d1"
    )
    assert res.status == "optimal"
    assert res.replanned_actions == []
    assert res.reduction == pytest.approx(res.plan_value - res.replanned_value, abs=0.011)
    assert res.reduction == pytest.approx(102.86, abs=0.01)
    assert "Hartford to New Haven" in res.forbidden and "box trucks" in res.forbidden
    t = res.transfer_detail
    assert (t.donor_branch_id, t.receiver_branch_id, t.count, t.mode) == ("HFD", "NHV", 2, "staff")
    assert (t.dispatch_day, t.arrival_day, t.shortage_day) == (1, 2, 2)
    assert t.receiver_rentals_gained == pytest.approx(1.9) and t.donor_rentals_lost == 0
    assert t.alt_mode.mode == "hauler" and t.alt_mode.allowed
    assert t.alt_mode.arrival_day == 3 and t.alt_mode.arrives_in_time is False
    assert res.lever_detail is None
    assert {c.branch_id for c in res.affected_scorecards} == {"HFD", "NHV"}


def test_counterfactual_per_action_type(rich_scenario, rich_sols, rich_response):
    seen = set()
    for a in rich_response.plan.actions:
        if a.type in seen:
            continue
        seen.add(a.type)
        res = explain.explain_action(rich_scenario, rich_scenario.params, [], rich_sols, a.id)
        assert res.action.id == a.id
        assert res.reduction >= -0.5, a.id
        assert (res.transfer_detail is not None) == (a.type == "move")
        assert (res.lever_detail is not None) == (a.type != "move")
        ids = {x.id: x for x in res.replanned_actions}
        if a.type == "move":
            lane = f"move:{a.origin}>{a.dest}:{a.class_id}:"
            assert not any(i.startswith(lane) for i in ids)
        else:
            assert a.id not in ids
    assert seen == {"move", "rate", "fee", "incentive"}
    assert explain.explain_action(
        rich_scenario, rich_scenario.params, [], rich_sols, "fee:NOPE"
    ) is None
