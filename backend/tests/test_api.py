"""HTTP layer. Needs app.data (built separately); skipped until it is importable."""

import pytest

pytest.importorskip("app.data", reason="app.data is not available yet")
pytest.importorskip("httpx")

from fastapi.testclient import TestClient  # noqa: E402

from app.main import app  # noqa: E402

client = TestClient(app)


@pytest.fixture(scope="module")
def solved():
    res = client.post("/api/solve", json={})
    assert res.status_code == 200, res.text
    return res.json()


def test_health_cases_scenario():
    assert client.get("/api/health").json() == {"status": "ok"}
    cases = client.get("/api/cases").json()
    assert "default" in [c["id"] for c in cases]
    sc = client.get("/api/scenario", params={"case_id": "default"})
    assert sc.status_code == 200 and sc.json()["case"]["id"] == "default"
    assert client.get("/api/scenario", params={"case_id": "nope"}).status_code == 404


def test_solve_returns_four_strategies_in_order(solved):
    assert [s["id"] for s in solved["strategies"]] == ["none", "moves", "pricing", "joint"]
    assert solved["plan"]["strategy_id"] == "joint"
    for s in solved["strategies"]:
        assert s["status"] in ("optimal", "time_limit")
        assert round(s["week1"] + s["week2"], 2) == s["expected_contribution"]
    b = solved["bridge"]
    assert round(b["start"] + sum(s["delta"] for s in b["steps"]), 2) == b["end"]
    joint = solved["strategies"][3]
    if all(s["status"] == "optimal" for s in solved["strategies"]):
        for s in solved["strategies"][:3]:
            assert joint["objective"] >= s["objective"] - max(1.0, 1e-4 * abs(joint["objective"]))
    network = joint["components"]["rental_revenue"] + joint["components"]["fee_revenue"]
    assert sum(c["actual"]["revenue"] for c in solved["scorecards"]) == pytest.approx(network, abs=0.1)
    assert sum(c["adjusted"]["revenue"] for c in solved["scorecards"]) == pytest.approx(
        network + solved["central_account"]["total_credits"], abs=0.1
    )


def test_solve_is_cached_on_repeat(solved):
    again = client.post("/api/solve", json={}).json()
    assert again["cached"] is True and again["request_key"] == solved["request_key"]
    assert again["strategies"] == solved["strategies"]


def test_param_overrides_are_applied():
    res = client.post("/api/solve", json={"params": {"move_cost_multiplier": 2.0}}).json()
    assert res["params"]["move_cost_multiplier"] == 2.0
    assert client.post("/api/solve", json={"params": {"move_cost_multiplier": 99}}).status_code == 422


def test_explain_action(solved):
    actions = solved["plan"]["actions"]
    if not actions:
        pytest.skip("the default joint plan has no actions")
    res = client.post("/api/explain/action", json={"action_id": actions[0]["id"]})
    assert res.status_code == 200, res.text
    body = res.json()
    assert body["action"]["id"] == actions[0]["id"]
    tol = max(0.5, 1e-4 * abs(body["plan_value"]))
    assert body["reduction"] >= -tol
    assert body["reduction"] == pytest.approx(body["plan_value"] - body["replanned_value"], abs=0.011)
    assert body["forbidden"]
    assert (body["transfer_detail"] is None) != (body["lever_detail"] is None)


def test_explain_unknown_action_is_404():
    res = client.post("/api/explain/action", json={"action_id": "move:XXX>YYY:box16:staff:d1"})
    assert res.status_code == 404


def test_unknown_case_is_404():
    assert client.post("/api/solve", json={"case_id": "nope"}).status_code == 404


def test_conditional_is_not_built():
    assert client.post("/api/conditional", json={}).status_code == 501


def test_suggested_booking_becomes_a_reported_commitment():
    sug = client.get("/api/suggested-booking")
    assert sug.status_code == 200
    res = client.post("/api/solve", json={"added_bookings": [sug.json()]})
    assert res.status_code == 200, res.text
    (bk,) = res.json()["added_bookings"]
    assert bk["id"] == "rep-1" and bk["source"] == "reported"
    assert bk["kind"] == ("local" if bk["origin"] == bk["dest"] else "oneway")
    bad = dict(sug.json(), branch_id="ZZZ")
    assert client.post("/api/solve", json={"added_bookings": [bad]}).status_code == 422


# --------------------------------------------------------------------------- #
# Decisions (contract section 7)
# --------------------------------------------------------------------------- #


def _approve(action):
    return {k: action[k] for k in ("id", "count", "tier_pct", "fee", "amount")}


def _same_totals(a, b):
    drop = ("solve_ms",)
    return [{k: v for k, v in s.items() if k not in drop} for s in a] == [
        {k: v for k, v in s.items() if k not in drop} for s in b
    ]


def test_no_decisions_current_plan_is_the_joint_strategy(solved):
    joint, plan = solved["strategies"][3], solved["plan_result"]
    assert plan["label"] == "Current plan" and plan["id"] == "joint"
    for k in ("expected_contribution", "objective", "week1", "week2", "components", "action_count"):
        assert plan[k] == joint[k]
    d = solved["decision"]
    assert d["do_nothing"] == solved["strategies"][0]["expected_contribution"]
    assert d["best_possible"] == d["current_plan"] == joint["expected_contribution"]
    assert d["approved_only"] == d["do_nothing"] and d["cost_of_rejections"] == 0
    assert all(a["decision"] == "proposed" for a in solved["plan"]["actions"])
    assert solved["bridge"]["end"] == joint["expected_contribution"]


def test_situation_equals_inventory_sums(solved):
    inv = solved["inventory"]
    for key, sfx in (("do_nothing", "none"), ("plan", "plan")):
        t = solved["situation"][key]
        assert t["unserved_rentals"] == pytest.approx(sum(r[f"unmet_{sfx}"] for r in inv), abs=1e-6)
        assert t["unserved_revenue"] == pytest.approx(sum(r[f"unmet_revenue_{sfx}"] for r in inv), abs=0.005)
        assert t["idle_truck_days"] == pytest.approx(sum(r[f"idle_{sfx}"] for r in inv), abs=1e-6)


def test_approving_proposed_actions_keeps_the_plan(solved):
    actions = solved["plan"]["actions"]
    if not actions:
        pytest.skip("no actions")
    res = client.post("/api/solve", json={"approved": [_approve(a) for a in actions]}).json()
    assert _same_totals(res["strategies"], solved["strategies"])
    assert [a["id"] for a in res["plan"]["actions"]] == [a["id"] for a in actions]
    assert all(a["decision"] == "approved" for a in res["plan"]["actions"])
    d = res["decision"]
    assert d["approved_count"] == len(actions)
    assert d["current_plan"] == d["best_possible"]
    # exactly the approved actions reproduce the plan they came from
    assert d["approved_only"] == pytest.approx(d["current_plan"], abs=1.0)
    assert res["request_key"] != solved["request_key"]


def test_rejecting_an_action(solved):
    actions = solved["plan"]["actions"]
    if not actions:
        pytest.skip("no actions")
    target = next((a for a in actions if a["type"] != "move"), actions[0])
    res = client.post("/api/solve", json={"rejected_action_ids": [target["id"]]}).json()
    assert _same_totals(res["strategies"], solved["strategies"])
    assert target["id"] not in [a["id"] for a in res["plan"]["actions"]]
    d = res["decision"]
    tol = max(0.5, 1e-4 * abs(d["best_possible"]))
    assert d["current_plan"] <= d["best_possible"] + tol
    assert d["cost_of_rejections"] == pytest.approx(d["best_possible"] - d["current_plan"], abs=0.011)
    assert d["rejected_action_ids"] == [target["id"]]
    assert d["approved_only"] == d["do_nothing"]
    assert res["plan_result"]["objective"] <= solved["strategies"][3]["objective"] + tol
    assert res["plan_result"]["expected_contribution"] == d["current_plan"]


def test_approved_move_the_solver_would_not_choose_is_held(solved):
    sc = client.get("/api/scenario").json()
    in_plan = {a["id"] for a in solved["plan"]["actions"]}
    cls = sc["classes"][0]["id"]
    lane = max(sc["lanes"], key=lambda ln: ln["miles"])
    aid = f"move:{lane['origin']}>{lane['dest']}:{cls}:hauler:d1"
    assert aid not in in_plan
    res = client.post("/api/solve", json={"approved": [{"id": aid, "count": 1}]})
    if res.status_code == 422:  # no truck of that class there on day 1
        pytest.skip(res.json()["detail"])
    body = res.json()
    held = next(a for a in body["plan"]["actions"] if a["id"] == aid)
    assert held["decision"] == "approved" and held["count"] == 1
    d = body["decision"]
    assert d["current_plan"] < d["best_possible"]
    assert d["approved_only"] < d["do_nothing"] + 0.01 or d["approved_only"] <= d["current_plan"]


def test_decision_validation(solved):
    actions = solved["plan"]["actions"]
    a = actions[0]
    post = lambda body: client.post("/api/solve", json=body).status_code  # noqa: E731
    assert post({"approved": [_approve(a)], "rejected_action_ids": [a["id"]]}) == 422
    assert post({"rejected_action_ids": ["nonsense"]}) == 422
    assert post({"rejected_action_ids": ["fee:ZZZ"]}) == 422
    assert post({"rejected_action_ids": ["move:HFD>NHV:box16:teleport:d1"]}) == 422
    assert post({"approved": [{"id": "move:HFD>NHV:box16:staff:d2"}]}) == 422  # no count
    assert post({"approved": [{"id": "move:HFD>NHV:box16:staff:d9", "count": 1}]}) == 422
    assert post({"approved": [{"id": "rate:PWM:mov26"}]}) == 422  # no tier
    assert post({"approved": [{"id": "rate:PWM:mov26", "tier_pct": -0.15}]}) == 422
    assert post({"approved": [{"id": "fee:PWM", "fee": 75}]}) == 422
    assert post({"approved": [{"id": "incentive:NHV", "amount": 10}]}) == 422
    assert post({"approved": [{"id": "move:HFD>NHV:box16:staff:d2", "count": 500}]}) == 422
    assert post({"approved": [{"id": "rate:PWM:mov26", "tier_pct": -0.2}]}) == 200


def test_batch_matches_single_explain(solved):
    actions = solved["plan"]["actions"]
    if not actions:
        pytest.skip("no actions")
    batch = client.post("/api/explain/batch", json={})
    assert batch.status_code == 200, batch.text
    items = batch.json()["items"]
    assert [i["action_id"] for i in items] == [a["id"] for a in actions]
    costs = {a["id"]: a["cost"] for a in actions}
    for it in items:
        assert it["cost"] == costs[it["action_id"]]
        assert it["reduction"] >= -max(0.5, 1e-4 * abs(solved["plan_result"]["objective"]))
    for it in (items[0], items[-1]):
        one = client.post("/api/explain/action", json={"action_id": it["action_id"]}).json()
        assert one["reduction"] == it["reduction"]
        assert one["status"] == it["status"]
    sub = client.post("/api/explain/batch", json={"action_ids": [actions[-1]["id"]]}).json()
    assert sub["items"] == [items[-1]]
    assert client.post("/api/explain/batch", json={"action_ids": ["fee:ZZZ"]}).status_code == 404


def test_explain_under_decisions(solved):
    actions = solved["plan"]["actions"]
    if len(actions) < 2:
        pytest.skip("needs two actions")
    keep, drop = actions[0], actions[-1]
    body = {"approved": [_approve(keep)], "rejected_action_ids": [drop["id"]]}
    plan = client.post("/api/solve", json=body).json()
    # the rejected action is no longer in the current plan
    assert client.post("/api/explain/action", json={**body, "action_id": drop["id"]}).status_code == 404
    one = client.post("/api/explain/action", json={**body, "action_id": keep["id"]})
    assert one.status_code == 200, one.text
    one = one.json()
    assert one["action"]["decision"] == "approved"
    assert one["plan_value"] == plan["plan_result"]["objective"]
    assert keep["id"] not in [a["id"] for a in one["replanned_actions"]]
    assert drop["id"] not in [a["id"] for a in one["replanned_actions"]]
    batch = client.post("/api/explain/batch", json=body).json()
    by = {i["action_id"]: i for i in batch["items"]}
    assert set(by) == {a["id"] for a in plan["plan"]["actions"]}
    assert by[keep["id"]]["reduction"] == one["reduction"]
