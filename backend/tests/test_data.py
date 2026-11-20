"""Tests for the synthetic scenario generator (app/data.py). No solver involved."""

from collections import defaultdict
from itertools import permutations

import pytest

from app.data import get_scenario, list_cases, suggested_missing_booking
from app.schemas import CaseInfo, ReportedBooking, Scenario

CASE_IDS = ["default", "high_move_cost", "joint_equals_moves"]
BRANCH_IDS = ["NYC", "BOS", "HFD", "NHV", "PWM"]
CLASS_IDS = ["box16", "mov26"]


def lane(sc: Scenario, origin: str, dest: str):
    return next(ln for ln in sc.lanes if ln.origin == origin and ln.dest == dest)


def confirmed_only_min_availability(sc: Scenario, extra=()) -> dict[tuple[str, str], float]:
    """Greedy day-by-day simulation serving confirmed bookings only (no new demand,
    no moves). Returns the lowest post-booking availability per (branch, class)."""
    arrivals: dict[tuple[str, str, int], int] = defaultdict(int)
    for r in sc.in_progress_returns:
        arrivals[(r.branch_id, r.class_id, r.return_day)] += r.count
    starts: dict[tuple[str, str, int], int] = defaultdict(int)
    for b in list(sc.bookings):
        starts[(b.origin, b.class_id, b.start_day)] += b.count
        arrivals[(b.dest, b.class_id, b.start_day + b.duration_days)] += b.count
    for r in extra:
        starts[(r.branch_id, r.class_id, r.start_day)] += r.count
        arrivals[(r.dest_branch_id, r.class_id, r.start_day + r.duration_days)] += r.count

    avail = {(f.branch_id, f.class_id): f.start_inventory for f in sc.fleet}
    lowest = dict(avail)
    for day in range(1, sc.params.horizon_days + 1):
        for key in avail:
            avail[key] += arrivals[(*key, day)] - starts[(*key, day)]
            lowest[key] = min(lowest[key], avail[key])
    return lowest


# --------------------------------------------------------------------------- #
# Cases, determinism, schema
# --------------------------------------------------------------------------- #


def test_list_cases():
    cases = list_cases()
    assert [c.id for c in cases] == CASE_IDS
    assert all(isinstance(c, CaseInfo) and c.label and c.description for c in cases)


@pytest.mark.parametrize("case_id", CASE_IDS)
def test_case_loads_and_is_schema_valid(case_id):
    sc = get_scenario(case_id)
    assert isinstance(sc, Scenario)
    assert sc.case.id == case_id
    assert Scenario.model_validate(sc.model_dump()) == sc
    assert Scenario.model_validate_json(sc.model_dump_json()) == sc


def test_default_argument():
    assert get_scenario() == get_scenario("default")


@pytest.mark.parametrize("case_id", CASE_IDS)
def test_deterministic(case_id):
    assert get_scenario(case_id) == get_scenario(case_id)


def test_returned_scenario_is_a_copy():
    sc = get_scenario()
    sc.bookings.clear()
    sc.params.change_cost = 1.0
    sc.fleet[0].start_inventory = 999
    fresh = get_scenario()
    assert fresh.bookings and fresh.params.change_cost == 50.0
    assert fresh.fleet[0].start_inventory != 999


def test_unknown_case_raises_key_error():
    with pytest.raises(KeyError):
        get_scenario("no_such_case")


def test_variants_change_only_case_and_params():
    base = get_scenario("default").model_dump(exclude={"case", "params"})
    for case_id in ("high_move_cost", "joint_equals_moves"):
        sc = get_scenario(case_id)
        assert sc.model_dump(exclude={"case", "params"}) == base
        assert sc.params != get_scenario("default").params
    assert get_scenario("high_move_cost").params.move_cost_multiplier > 1.0
    assert get_scenario("joint_equals_moves").params.move_cost_multiplier == 1.0


# --------------------------------------------------------------------------- #
# Network
# --------------------------------------------------------------------------- #


def test_branches_classes_and_start_date():
    sc = get_scenario()
    assert [b.id for b in sc.branches] == BRANCH_IDS
    assert {c.id: c.daily_rate for c in sc.classes} == {"box16": 110.0, "mov26": 160.0}
    assert sc.start_date == "2026-11-23"
    assert sc.params.horizon_days == 14


def test_lanes_complete_and_symmetric():
    sc = get_scenario()
    pairs = [(ln.origin, ln.dest) for ln in sc.lanes]
    assert sorted(pairs) == sorted(permutations(BRANCH_IDS, 2))
    for o, d in pairs:
        assert lane(sc, o, d).miles == lane(sc, d, o).miles > 0


def test_lane_costs_follow_the_contract():
    sc = get_scenario()
    p = sc.params
    for ln in sc.lanes:
        assert ln.staff_allowed == (ln.miles <= p.staff_max_miles)
        assert ln.hauler_cost == pytest.approx(p.hauler_load_fee + ln.miles * p.hauler_per_mile, abs=0.01)
        if ln.staff_allowed:
            expected = 2 * ln.miles / p.staff_speed_mph * p.staff_hourly + 2 * ln.miles * p.staff_per_mile
            assert ln.staff_cost == pytest.approx(expected, abs=0.01)
        else:
            assert ln.staff_cost is None


def test_hartford_new_haven_is_a_short_staff_lane():
    ln = lane(get_scenario(), "HFD", "NHV")
    assert ln.staff_allowed
    assert 35 <= ln.miles <= 45
    assert ln.staff_cost < ln.hauler_cost


def test_new_york_portland_is_hauler_only_and_expensive():
    sc = get_scenario()
    ln = lane(sc, "NYC", "PWM")
    assert not ln.staff_allowed and ln.staff_cost is None
    assert ln.hauler_cost == max(x.hauler_cost for x in sc.lanes)


def test_nearest_branch_by_lane_miles():
    sc = get_scenario()
    for b in sc.branches:
        best = min((ln for ln in sc.lanes if ln.origin == b.id), key=lambda ln: ln.miles)
        assert b.nearest_branch_id == best.dest
    nearest = {b.id: b.nearest_branch_id for b in sc.branches}
    assert nearest["HFD"] == "NHV" and nearest["NHV"] == "HFD" and nearest["PWM"] == "BOS"


# --------------------------------------------------------------------------- #
# Fleet, bookings, demand
# --------------------------------------------------------------------------- #


def test_fleet_rows_cover_every_branch_and_class():
    sc = get_scenario()
    keys = [(f.branch_id, f.class_id) for f in sc.fleet]
    assert sorted(keys) == sorted((b, k) for b in BRANCH_IDS for k in CLASS_IDS)


def test_fleet_reconciles():
    """Assigned fleet sums to the class total: start inventory plus every truck out
    on an in-progress rental (all of which are listed and return inside the horizon)."""
    sc = get_scenario()
    for k in CLASS_IDS:
        rows = [f for f in sc.fleet if f.class_id == k]
        out = sum(r.count for r in sc.in_progress_returns if r.class_id == k)
        total = sum(f.start_inventory for f in rows) + out
        assert sum(f.assigned_fleet for f in rows) == total
        for f in rows:
            own_out = sum(
                r.count for r in sc.in_progress_returns if r.class_id == k and r.origin == f.branch_id
            )
            assert f.assigned_fleet == f.start_inventory + own_out


def test_in_progress_returns_are_well_formed():
    sc = get_scenario()
    assert sc.in_progress_returns
    for r in sc.in_progress_returns:
        assert r.branch_id in BRANCH_IDS and r.origin in BRANCH_IDS and r.class_id in CLASS_IDS
        assert r.count >= 1
        assert r.kind == ("local" if r.origin == r.branch_id else "oneway")
        max_day = sc.params.local_duration_days if r.kind == "local" else sc.params.oneway_duration_days
        assert 1 <= r.return_day <= max_day


def test_bookings_are_well_formed():
    sc = get_scenario()
    rate = {c.id: c.daily_rate for c in sc.classes}
    assert sc.bookings
    for b in sc.bookings:
        assert b.origin in BRANCH_IDS and b.dest in BRANCH_IDS and b.class_id in CLASS_IDS
        assert 1 <= b.start_day <= 14 and b.count >= 1
        assert b.kind == ("local" if b.origin == b.dest else "oneway")
        assert b.duration_days == (2 if b.kind == "local" else 3)
        assert b.daily_price == rate[b.class_id]
        assert b.source == "seed"
        assert b.id.startswith("bk-") and len(b.id) == 7


def test_demand_is_well_formed_and_modest():
    sc = get_scenario()
    assert 100 <= len(sc.demand) <= 300
    keys = set()
    for c in sc.demand:
        assert c.origin in BRANCH_IDS and c.dest in BRANCH_IDS and c.class_id in CLASS_IDS
        assert 1 <= c.start_day <= 14 and c.base_demand > 0
        assert c.kind == ("local" if c.origin == c.dest else "oneway")
        assert c.duration_days == (2 if c.kind == "local" else 3)
        keys.add((c.origin, c.dest, c.class_id, c.start_day))
    assert len(keys) == len(sc.demand)  # one cohort per origin, dest, class, start day
    # Local demand exists at every branch, class and day.
    local = {(c.origin, c.class_id, c.start_day) for c in sc.demand if c.kind == "local"}
    assert len(local) == 5 * 2 * 14


def test_ids_unique():
    sc = get_scenario()
    for items in (sc.bookings, sc.demand, sc.in_progress_returns, sc.branches, sc.classes):
        ids = [x.id for x in items]
        assert len(ids) == len(set(ids))
    all_ids = [x.id for x in sc.bookings + sc.demand + sc.in_progress_returns]
    assert len(all_ids) == len(set(all_ids))


@pytest.mark.parametrize("case_id", CASE_IDS)
def test_confirmed_bookings_are_coverable_under_do_nothing(case_id):
    lowest = confirmed_only_min_availability(get_scenario(case_id))
    assert all(v >= 0 for v in lowest.values()), lowest


# --------------------------------------------------------------------------- #
# The engineered story (structure only; outcomes need the solver)
# --------------------------------------------------------------------------- #


def test_nyc_has_the_largest_demand():
    sc = get_scenario()
    by_origin: dict[str, float] = defaultdict(float)
    for c in sc.demand:
        by_origin[c.origin] += c.base_demand
    assert max(by_origin, key=by_origin.get) == "NYC"
    assert min(by_origin, key=by_origin.get) in ("PWM", "HFD")


def test_hartford_cannot_dispatch_box_trucks_on_day_one():
    """Start inventory equals the confirmed day-1 bookings, so the first possible
    dispatch is day 2: staff arrives day 3, a hauler day 4."""
    sc = get_scenario()
    start = next(f.start_inventory for f in sc.fleet if (f.branch_id, f.class_id) == ("HFD", "box16"))
    day1_returns = sum(
        r.count for r in sc.in_progress_returns
        if (r.branch_id, r.class_id, r.return_day) == ("HFD", "box16", 1)
    )
    day1_booked = sum(
        b.count for b in sc.bookings if (b.origin, b.class_id, b.start_day) == ("HFD", "box16", 1)
    )
    assert start + day1_returns == day1_booked
    day2_returns = sum(
        r.count for r in sc.in_progress_returns
        if (r.branch_id, r.class_id, r.return_day) == ("HFD", "box16", 2)
    )
    assert day2_returns >= 4


def test_new_haven_box_demand_peaks_midweek():
    sc = get_scenario()
    total: dict[int, float] = defaultdict(float)
    for c in sc.demand:
        if (c.origin, c.class_id) == ("NHV", "box16"):
            total[c.start_day] += c.base_demand
    for b in sc.bookings:
        if (b.origin, b.class_id) == ("NHV", "box16"):
            total[b.start_day] += b.count
    assert max(range(1, 8), key=lambda d: total[d]) == 3


def test_incentive_stream_into_hartford_exists():
    """Confirmed one-way box trucks due at Hartford: what a New Haven return incentive acts on."""
    sc = get_scenario()
    assert next(b for b in sc.branches if b.id == "HFD").nearest_branch_id == "NHV"
    due = sum(
        b.count for b in sc.bookings
        if b.kind == "oneway" and b.dest == "HFD" and b.class_id == "box16"
        and b.start_day + b.duration_days <= 14
    )
    due += sum(
        r.count for r in sc.in_progress_returns
        if r.kind == "oneway" and r.branch_id == "HFD" and r.class_id == "box16"
    )
    assert due >= 6


def test_portland_receives_moving_trucks():
    sc = get_scenario()
    inbound = sum(c.base_demand for c in sc.demand if c.kind == "oneway" and c.dest == "PWM" and c.class_id == "mov26")
    inbound += sum(b.count for b in sc.bookings if b.kind == "oneway" and b.dest == "PWM" and b.class_id == "mov26")
    outbound = sum(c.base_demand for c in sc.demand if c.kind == "oneway" and c.origin == "PWM")
    outbound += sum(b.count for b in sc.bookings if b.kind == "oneway" and b.origin == "PWM")
    assert inbound > 3 and outbound == 0
    local = defaultdict(float)
    for c in sc.demand:
        if c.kind == "local" and c.class_id == "mov26":
            local[c.origin] += c.base_demand
    assert local["PWM"] < local["BOS"] < local["NYC"]
    assert sc.params.elasticity_by_branch.get("PWM") == -1.8


def test_no_forecast_one_way_stream_into_hartford():
    """A drop fee into Hartford would raise its revenue and hide the transfer's cost."""
    sc = get_scenario()
    assert not [c for c in sc.demand if c.kind == "oneway" and c.dest == "HFD"]


def test_suggested_missing_booking():
    rb = suggested_missing_booking()
    assert isinstance(rb, ReportedBooking)
    assert (rb.branch_id, rb.dest_branch_id, rb.class_id) == ("HFD", "HFD", "box16")
    assert rb.count >= 1 and 1 <= rb.start_day <= 5
    assert rb == suggested_missing_booking()

    sc = get_scenario()
    # Hartford can still cover it if it sends nothing away (no broken commitment by itself)...
    lowest = confirmed_only_min_availability(sc, extra=[rb])
    assert all(v >= 0 for v in lowest.values()), lowest
    # ...but it leaves at most one spare box truck, where before there were more.
    assert lowest[("HFD", "box16")] <= 1
    assert confirmed_only_min_availability(sc)[("HFD", "box16")] == 0  # day 1 uses the whole lot
