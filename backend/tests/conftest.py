"""Small hand-built scenarios. None of these depend on app.data or its tuning."""

from __future__ import annotations

import random

import pytest

from app.schemas import (
    Booking,
    Branch,
    CaseInfo,
    DemandCohort,
    FleetRow,
    InProgressReturn,
    Lane,
    Params,
    Scenario,
    VehicleClass,
)

BOX = VehicleClass(id="box16", name="16 ft box truck", short_name="box truck", daily_rate=110.0)
MOV = VehicleClass(id="mov26", name="26 ft moving truck", short_name="moving truck", daily_rate=160.0)

NAMES = {
    "HFD": ("Hartford, CT", "Hartford"),
    "NHV": ("New Haven, CT", "New Haven"),
    "PWM": ("Portland, ME", "Portland"),
}


def make_scenario(
    miles: dict[tuple[str, str], float],
    fleet: dict[tuple[str, str], int],
    *,
    classes=(BOX,),
    bookings=(),
    demand=(),
    in_progress=(),
    params: Params | None = None,
    assigned: dict[tuple[str, str], int] | None = None,
) -> Scenario:
    """`miles` is keyed by unordered pair; lanes are generated both ways."""
    params = params or Params()
    ids = sorted({b for pair in miles for b in pair}, key=list(NAMES).index)
    dist = {}
    for (a, b), mi in miles.items():
        dist[(a, b)] = mi
        dist[(b, a)] = mi
    branches = []
    for b in ids:
        near = min((dist[(b, o)], o) for o in ids if o != b)[1]
        branches.append(
            Branch(id=b, name=NAMES[b][0], short_name=NAMES[b][1], lat=0.0, lon=0.0,
                   nearest_branch_id=near, role="test")
        )
    lanes = []
    for (a, b), mi in dist.items():
        ok = mi <= params.staff_max_miles
        lanes.append(
            Lane(
                origin=a, dest=b, miles=mi, staff_allowed=ok,
                staff_cost=(2 * mi / 45 * 35 + 2 * mi * 0.8) if ok else None,
                hauler_cost=150 + 2.5 * mi,
            )
        )
    in_progress = list(in_progress)
    rows = []
    for b in ids:
        for k in classes:
            inv = fleet.get((b, k.id), 0)
            out = sum(r.count for r in in_progress if r.origin == b and r.class_id == k.id)
            rows.append(
                FleetRow(
                    branch_id=b, class_id=k.id, start_inventory=inv,
                    assigned_fleet=(assigned or {}).get((b, k.id), inv + out),
                )
            )
    return Scenario(
        case=CaseInfo(id="test", label="test", description="hand-built"),
        seed=0,
        start_date="2026-11-23",
        params=params,
        branches=branches,
        classes=list(classes),
        lanes=lanes,
        fleet=rows,
        in_progress_returns=in_progress,
        bookings=list(bookings),
        demand=list(demand),
    )


def local(id_, branch, day, qty, class_id="box16", dur=2):
    return DemandCohort(id=id_, origin=branch, dest=branch, class_id=class_id,
                        start_day=day, duration_days=dur, kind="local", base_demand=qty)


def oneway(id_, origin, dest, day, qty, class_id="box16", dur=3):
    return DemandCohort(id=id_, origin=origin, dest=dest, class_id=class_id,
                        start_day=day, duration_days=dur, kind="oneway", base_demand=qty)


def booking(id_, origin, dest, day, count, class_id="box16", dur=None, price=None):
    kind = "local" if origin == dest else "oneway"
    dur = dur or (2 if kind == "local" else 3)
    price = price or (110.0 if class_id == "box16" else 160.0)
    return Booking(id=id_, origin=origin, dest=dest, class_id=class_id, start_day=day,
                   duration_days=dur, count=count, kind=kind, daily_price=price)


@pytest.fixture
def transfer_scenario() -> Scenario:
    """Hartford has idle box trucks; New Haven (40 mi) has none and demand on day 2.
    A staff drive on day 1 arrives day 2; a hauler would arrive day 3, too late."""
    return make_scenario(
        {("HFD", "NHV"): 40.0},
        {("HFD", "box16"): 4, ("NHV", "box16"): 0},
        demand=[local("nhv-d2", "NHV", 2, 2.0)],
    )


@pytest.fixture
def late_transfer_scenario() -> Scenario:
    """Same shortage, but the lane is too long for staff, so the only mode arrives on
    day 3, after the day-2 demand."""
    return make_scenario(
        {("HFD", "NHV"): 200.0},
        {("HFD", "box16"): 4, ("NHV", "box16"): 0},
        demand=[local("nhv-d2", "NHV", 2, 2.0)],
    )


@pytest.fixture
def committed_scenario() -> Scenario:
    """Hartford's only two trucks are promised to a confirmed booking on day 3, and
    New Haven would like them on day 2."""
    return make_scenario(
        {("HFD", "NHV"): 40.0},
        {("HFD", "box16"): 2, ("NHV", "box16"): 0},
        bookings=[booking("bk-hfd", "HFD", "HFD", 3, 2)],
        demand=[local("nhv-d2", "NHV", 2, 2.0)],
    )


@pytest.fixture
def costly_scenario(transfer_scenario) -> Scenario:
    """The transfer case with every intervention priced out."""
    p = transfer_scenario.params.model_copy(
        update={"move_cost_multiplier": 10.0, "change_cost": 5000.0}
    )
    return transfer_scenario.model_copy(update={"params": p})


@pytest.fixture(scope="session")
def rich_scenario() -> Scenario:
    """Three branches, two classes, every lever in play: local and one-way demand,
    confirmed one-way bookings and in-progress returns eligible for incentives."""
    rng = random.Random(7)
    demand = []
    n = 0
    for day in range(1, 15):
        for b, lam in (("HFD", 0.6), ("NHV", 2.6), ("PWM", 1.2)):
            for k in ("box16", "mov26"):
                n += 1
                demand.append(local(f"l{n}", b, day, round(lam * rng.uniform(0.5, 1.5), 2), k))
        for o, d, lam in (("NHV", "PWM", 0.9), ("HFD", "PWM", 0.5), ("PWM", "NHV", 0.2),
                          ("NHV", "HFD", 0.6), ("HFD", "NHV", 0.3)):
            n += 1
            k = "mov26" if d == "PWM" else "box16"
            demand.append(oneway(f"o{n}", o, d, day, round(lam * rng.uniform(0.5, 1.5), 2), k))
    bookings = [
        booking("bk1", "HFD", "HFD", 3, 2),
        booking("bk2", "NHV", "NHV", 2, 1),
        booking("bk3", "NHV", "HFD", 2, 3),  # return eligible for an incentive at NHV
        booking("bk4", "HFD", "NHV", 4, 2),  # eligible at HFD
        booking("bk5", "NHV", "PWM", 5, 2, class_id="mov26"),
        booking("bk6", "PWM", "PWM", 6, 1, class_id="mov26"),
        booking("bk7", "NHV", "HFD", 13, 1),  # returns past the horizon
    ]
    in_progress = [
        InProgressReturn(id="ip1", branch_id="HFD", origin="NHV", class_id="box16",
                         return_day=2, count=2, kind="oneway"),
        InProgressReturn(id="ip2", branch_id="PWM", origin="NHV", class_id="mov26",
                         return_day=1, count=1, kind="oneway"),
        InProgressReturn(id="ip3", branch_id="NHV", origin="NHV", class_id="box16",
                         return_day=3, count=1, kind="local"),
    ]
    return make_scenario(
        {("HFD", "NHV"): 40.0, ("HFD", "PWM"): 230.0, ("NHV", "PWM"): 260.0},
        {("HFD", "box16"): 9, ("NHV", "box16"): 3, ("PWM", "box16"): 3,
         ("HFD", "mov26"): 3, ("NHV", "mov26"): 4, ("PWM", "mov26"): 6},
        classes=(BOX, MOV),
        bookings=bookings,
        demand=demand,
        in_progress=in_progress,
        params=Params(elasticity_by_branch={"PWM": -1.8}),
    )


@pytest.fixture(scope="session")
def rich_sols(rich_scenario):
    """The four strategies solved once for the whole test session."""
    from app.model import solve_all

    return solve_all(rich_scenario)
