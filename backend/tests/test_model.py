"""Model behaviour on hand-built scenarios (planning doc "Tests" table)."""

import numpy as np
import pytest

from app.model import solve, solve_all
from app.schemas import InProgressReturn, Params

from .conftest import booking, local, make_scenario, oneway

TOL = 1e-4


def test_confirmed_booking_keeps_its_trucks(committed_scenario):
    sols = solve_all(committed_scenario)
    for sol in sols.values():
        assert sol.status == "optimal"
        assert sol.expected_broken == pytest.approx(0.0, abs=1e-6)
    assert sols["joint"].moves == []
    # Control: without the booking the same trucks are sent to New Haven.
    free = committed_scenario.model_copy(update={"bookings": []})
    assert sum(m.count for m in solve(free).moves) == 2


def test_booking_covered_another_way():
    """Three trucks, two promised: only the spare one moves, nothing is broken."""
    sc = make_scenario(
        {("HFD", "NHV"): 40.0},
        {("HFD", "box16"): 3, ("NHV", "box16"): 0},
        bookings=[booking("bk", "HFD", "HFD", 3, 2)],
        demand=[local("d", "NHV", 2, 2.0)],
    )
    sol = solve(sc)
    assert sol.expected_broken == pytest.approx(0.0, abs=1e-6)
    assert sum(m.count for m in sol.moves) == 1


def test_late_transfer_is_not_chosen(late_transfer_scenario):
    sols = solve_all(late_transfer_scenario)
    assert sols["moves"].moves == [] and sols["joint"].moves == []
    assert sols["moves"].objective == pytest.approx(sols["none"].objective, abs=TOL)


def test_no_actions_when_everything_costs_too_much(costly_scenario):
    sols = solve_all(costly_scenario)
    for sid in ("moves", "pricing", "joint"):
        assert sols[sid].action_count == 0
        assert sols[sid].action_ids() == []
        assert sols[sid].objective == pytest.approx(sols["none"].objective, abs=TOL)


def test_vehicle_conservation(rich_sols):
    for sid, sol in rich_sols.items():
        total = sol.avail.sum(axis=1) + sol.on_rent_start + sol.in_transit_start[None]
        assert np.allclose(total, sol.fleet_total[None, :, None], atol=1e-6), sid
        # rentals starting plus moves dispatched never exceed what is on the lot
        assert (sol.avail - sol.starts - sol.dispatched[None] > -1e-6).all(), sid
        assert (sol.avail > -1e-9).all()


def test_joint_at_least_as_good_as_restricted(rich_sols):
    joint = rich_sols["joint"].objective
    for sid in ("none", "moves", "pricing"):
        assert joint >= rich_sols[sid].objective - 1e-3 * max(1.0, abs(joint)) * 1e-2, sid
    assert rich_sols["moves"].objective >= rich_sols["none"].objective - TOL
    assert rich_sols["pricing"].objective >= rich_sols["none"].objective - TOL


def test_staff_drive_chosen_when_hauler_is_too_late(transfer_scenario):
    sol = solve(transfer_scenario)
    assert [(m.id, m.count, m.arrival_day) for m in sol.moves] == [
        ("move:HFD>NHV:box16:staff:d1", 2, 2)
    ]
    # 1.9 expected rentals x 2 days x $110 x 85%, less two staff drives
    unit = 2 * 40 / 45 * 35 + 2 * 40 * 0.8
    assert sol.objective == pytest.approx(1.9 * 2 * 110 * 0.85 - 2 * unit, abs=1e-6)


def test_revenue_accrues_only_inside_the_horizon():
    sc = make_scenario(
        {("HFD", "NHV"): 40.0}, {("HFD", "box16"): 1, ("NHV", "box16"): 0},
        bookings=[booking("bk", "HFD", "HFD", 13, 1, dur=3)],
    )
    sol = solve(sc, allow_moves=False, allow_pricing=False)
    assert sol.expected_contribution == pytest.approx(2 * 110 * 0.85)
    assert sol.expect(sol.rented).sum() == pytest.approx(2.0)
    by_day = sol.contribution_by_day()
    assert by_day[:7].sum() == pytest.approx(0.0) and by_day[12:].sum() == pytest.approx(187.0)


def test_fee_tier_deters_and_diverts():
    """10 one-way rentals into Portland, plenty of trucks. At +$100, 7 still come and
    pay the fee, 1.8 rebook to New Haven (Portland's nearest is the origin), 1.2 leave."""
    sc = make_scenario(
        {("HFD", "NHV"): 40.0, ("HFD", "PWM"): 230.0, ("NHV", "PWM"): 260.0},
        {("HFD", "box16"): 20, ("NHV", "box16"): 0, ("PWM", "box16"): 0},
        demand=[oneway("ow", "HFD", "PWM", 1, 10.0)],
        params=Params(fee_divert_share=0.60),  # pinned: the arithmetic below assumes 60%
    )
    margin = 3 * 110 * 0.85
    none = solve(sc, allow_moves=False, allow_pricing=False)
    assert none.objective == pytest.approx(10 * margin)
    sol = solve(sc, allow_moves=False, allow_pricing=True)
    assert sol.fee_tier["PWM"] == 100.0
    assert sol.objective == pytest.approx(7 * (margin + 100) + 1.8 * margin - 50, abs=1e-6)
    i, j = sol.branch_ids.index("PWM"), sol.branch_ids.index("NHV")
    assert sol.expect(sol.fee_diverted)[i, j] == pytest.approx(1.8)
    assert sol.expect(sol.fee_deterred)[i] == pytest.approx(3.0)
    assert sol.components()["fee_revenue"] == pytest.approx(700.0)
    # trucks follow the rentals: 7 land in Portland and 1.8 in New Haven on day 4
    avail = sol.expect(sol.avail)
    assert avail[i, 0, 3] == pytest.approx(7.0) and avail[j, 0, 3] == pytest.approx(1.8)


def test_incentive_redirects_in_progress_returns():
    """Four one-way trucks are due at Hartford on day 2; New Haven is short that day.
    $80 brings half of them to New Haven instead."""
    sc = make_scenario(
        {("HFD", "NHV"): 40.0},
        {("HFD", "box16"): 0, ("NHV", "box16"): 0},
        demand=[local("d", "NHV", 2, 2.0)],
        in_progress=[InProgressReturn(id="ip", branch_id="HFD", origin="NHV",
                                      class_id="box16", return_day=2, count=4, kind="oneway")],
    )
    sol = solve(sc, allow_moves=False, allow_pricing=True)
    assert sol.incentive_tier == {"HFD": 0.0, "NHV": 80.0}
    assert sol.objective == pytest.approx(1.9 * 187 - 2 * 80 - 50, abs=1e-6)
    nhv, hfd = sol.branch_ids.index("NHV"), sol.branch_ids.index("HFD")
    assert sol.expect(sol.redirects)[nhv, hfd] == pytest.approx(2.0)
    assert sol.components()["incentive_payments"] == pytest.approx(160.0)


def test_forbidding_a_lane_closes_both_modes(transfer_scenario):
    sol = solve(transfer_scenario, forbid=["move:HFD>NHV:box16:staff:d1"])
    assert sol.moves == []
    with pytest.raises(ValueError):
        solve(transfer_scenario, forbid=["nonsense"])


def test_move_cost_multiplier_scales_transport(transfer_scenario):
    p = transfer_scenario.params.model_copy(update={"move_cost_multiplier": 1.2})
    sol = solve(transfer_scenario, p)
    unit = (2 * 40 / 45 * 35 + 2 * 40 * 0.8) * 1.2
    assert sol.components()["transport_cost"] == pytest.approx(unit * sum(m.count for m in sol.moves))
