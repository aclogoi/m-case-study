"""Seeded synthetic scenario generator for the fleet rebalancing prototype.

Exports (see docs/API_CONTRACT.md section 5):

    list_cases() -> list[CaseInfo]
    get_scenario(case_id="default") -> Scenario      # KeyError on unknown id
    suggested_missing_booking() -> ReportedBooking   # the Hartford correction

Everything here is invented. The default scenario is engineered toward the
planning doc's story; every number that shapes that story is a named constant
in the "TUNING KNOBS" block below, so the data can be re-tuned once the model
is running without touching the generator code.

The story, and which knobs carry it:

1. Hartford -> New Haven (box16). Hartford's lot is fully booked on day 1
   (start inventory == confirmed day-1 bookings), then a batch of local rentals
   comes back on day 2 (IN_PROGRESS, HFD row). New Haven runs short all fortnight
   with a Wed/Thu peak (LOCAL_BASE, LOCAL_SHAPE_OVERRIDES) on a thin fleet. So the
   first possible dispatch is day 2: a staff drive lands day 3 (the peak), a
   hauler lands day 4 (too late for it).
2. The donor pays for it. Hartford has real local demand of its own
   (LOCAL_BASE HFD box16) and no forecast one-way stream into it, so no drop fee
   props up its revenue: the trucks it gives up cost it weekend rentals, and its
   revenue under the plan is below do nothing (a scorecard credit).
3. Fleets are tight (do-nothing utilization about two thirds): most trucks start
   the horizon out on rent (IN_PROGRESS), NYC and New Haven have unmet demand.
   NYC has the largest demand and its mov26 trucks drain out on one-ways
   (ONEWAY_STREAMS); Boston drains toward Portland.
4. Portland piles up mov26 trucks against low local demand. PWM -> NYC is a
   ~$1,000 haul and Boston is kept long on mov26, which leaves pricing (PWM
   elasticity -1.8, or a drop fee into PWM). The inflow is kept small enough
   that the idle pile ends near 2x Portland's assigned fleet.
5. Confirmed one-way box16 bookings NYC/BOS -> Hartford (CONFIRMED_ONEWAY) are
   due back at Hartford from day 6 on; nearest(HFD) == NHV, so they are what a
   return incentive at New Haven acts on. They land after the day-3 peak on
   purpose, so the incentive does not simply replace the staff drive.
6. suggested_missing_booking(): with it, Hartford's day-3 commitments leave room
   to send at most one truck away on day 2 instead of two.

Solve time is sensitive to how tight the fleets are: one truck fewer per branch
and class roughly doubles the joint solve (about 0.4 s -> 1-3 s), so loosen
rather than tighten if the UI feels slow.
"""

from __future__ import annotations

import math
import random
from functools import lru_cache
from typing import Callable

from .schemas import (
    Booking,
    Branch,
    CaseInfo,
    DemandCohort,
    FleetRow,
    InProgressReturn,
    Lane,
    Params,
    ReportedBooking,
    Scenario,
    VehicleClass,
)

# =========================================================================== #
# TUNING KNOBS
# =========================================================================== #

SEED = 20261123
START_DATE = "2026-11-23"  # day 1, a Monday
ROAD_FACTOR = 1.2  # lane miles = haversine miles x this

# id, name, short name, lat, lon, role
BRANCHES: list[tuple[str, str, str, float, float, str]] = [
    ("NYC", "New York City, NY", "New York", 40.7128, -74.0060,
     "Largest demand; one-way moving trucks drain outward"),
    ("BOS", "Boston, MA", "Boston", 42.3601, -71.0589,
     "High demand; drains toward Portland"),
    ("HFD", "Hartford, CT", "Hartford", 41.7658, -72.6734,
     "Idle box trucks accumulate"),
    ("NHV", "New Haven, CT", "New Haven", 41.3083, -72.9279,
     "Short of box trucks midweek; about 40 miles from Hartford"),
    ("PWM", "Portland, ME", "Portland", 43.6591, -70.2568,
     "Accumulates moving trucks; low local demand; far from New York"),
]

# id, name, short name, daily rate
CLASSES: list[tuple[str, str, str, float]] = [
    ("box16", "16 ft box truck", "box truck", 110.0),
    ("mov26", "26 ft moving truck", "moving truck", 160.0),
]

# Trucks on the lot at the start of day 1 (before day-1 in-progress returns).
# HFD box16 == its confirmed day-1 local bookings, so nothing can leave on day 1.
START_INVENTORY: dict[str, dict[str, int]] = {
    "box16": {"NYC": 8, "BOS": 7, "HFD": 3, "NHV": 3, "PWM": 3},
    "mov26": {"NYC": 6, "BOS": 9, "HFD": 2, "NHV": 2, "PWM": 4},
}

# Rentals already out at the start of day 1.
# (due-back branch, origin branch, class, return day, count)
# kind is "local" when origin == due-back branch, else "oneway".
IN_PROGRESS: list[tuple[str, str, str, int, int]] = [
    # box16
    ("NYC", "NYC", "box16", 1, 6),
    ("NYC", "NYC", "box16", 2, 5),
    ("BOS", "BOS", "box16", 1, 4),
    ("BOS", "BOS", "box16", 2, 3),
    ("HFD", "HFD", "box16", 2, 5),  # the idle pile: a batch of locals back on day 2
    ("NHV", "NHV", "box16", 1, 2),
    ("NHV", "NHV", "box16", 2, 2),
    ("PWM", "PWM", "box16", 1, 1),
    ("PWM", "PWM", "box16", 2, 1),
    # mov26
    ("NYC", "NYC", "mov26", 1, 3),
    ("NYC", "NYC", "mov26", 2, 3),
    ("NYC", "BOS", "mov26", 2, 1),
    ("BOS", "BOS", "mov26", 1, 2),
    ("BOS", "BOS", "mov26", 2, 2),
    ("BOS", "NYC", "mov26", 1, 1),
    ("BOS", "NYC", "mov26", 3, 1),
    ("HFD", "HFD", "mov26", 1, 1),
    ("NHV", "NHV", "mov26", 1, 1),
    ("NHV", "NHV", "mov26", 2, 1),
    ("PWM", "PWM", "mov26", 1, 1),
    ("PWM", "PWM", "mov26", 2, 1),
    ("PWM", "BOS", "mov26", 2, 1),
    ("PWM", "NYC", "mov26", 3, 1),
]

# Total local demand (confirmed + new) per day at weekday multiplier 1.0.
LOCAL_BASE: dict[str, dict[str, float]] = {
    "box16": {"NYC": 8.0, "BOS": 5.0, "HFD": 1.6, "NHV": 5.2, "PWM": 1.5},
    "mov26": {"NYC": 4.0, "BOS": 3.0, "HFD": 0.8, "NHV": 1.0, "PWM": 1.4},
}

# Weekday multipliers, Monday..Sunday (day 1 is a Monday).
LOCAL_SHAPE: list[float] = [0.85, 0.90, 1.00, 1.00, 1.15, 1.30, 0.80]
ONEWAY_SHAPE: list[float] = [0.80, 0.80, 0.90, 1.00, 1.30, 1.40, 0.80]
# New Haven box trucks serve a midweek commercial market: Wed/Thu peak.
LOCAL_SHAPE_OVERRIDES: dict[tuple[str, str], list[float]] = {
    ("NHV", "box16"): [0.90, 0.95, 1.40, 1.25, 1.00, 0.95, 0.80],
}

# Share of a day's local demand that is already a confirmed booking: this on
# day 1, falling linearly to zero at day 1 + CONFIRMED_LOCAL_WINDOW. The new
# (forecast) local demand is the remainder, so confirmed + new ~= total.
CONFIRMED_LOCAL_SHARE_DAY1 = 0.35
CONFIRMED_LOCAL_WINDOW = 8

# Hand-set confirmed local bookings that replace the generic ones.
# (branch, class) -> {start day: count}
CONFIRMED_LOCAL_OVERRIDES: dict[tuple[str, str], dict[int, int]] = {
    # Day 1 uses the whole lot, so nothing can be dispatched before day 2. After the
    # day-2 returns about 2 trucks are spare; MISSING_BOOKING takes that slack away.
    ("HFD", "box16"): {1: 3, 2: 2, 3: 2},
    # Builds into the Wednesday peak.
    ("NHV", "box16"): {1: 1, 2: 1, 3: 4, 4: 2, 5: 1},
}

# New one-way demand, rentals per day at weekday multiplier 1.0.
# (origin, dest, class, rate)
ONEWAY_STREAMS: list[tuple[str, str, str, float]] = [
    ("NYC", "BOS", "mov26", 0.7),
    ("NYC", "PWM", "mov26", 0.1),  # NYC drains outward
    ("BOS", "PWM", "mov26", 0.2),  # Boston drains toward Portland
    ("BOS", "NYC", "mov26", 0.5),
]

# Confirmed one-way bookings. (origin, dest, class) -> {start day: count}
# The two streams into HFD are the return-incentive stream for New Haven; they
# come back (start day + 3) from day 6 on, after the day-3 peak. There is no
# forecast stream into HFD on purpose: a drop fee there would raise Hartford's
# revenue and hide what the transfer costs it.
CONFIRMED_ONEWAY: dict[tuple[str, str, str], dict[int, int]] = {
    ("NYC", "HFD", "box16"): {3: 2, 4: 1, 6: 2, 8: 1},
    ("BOS", "HFD", "box16"): {5: 1, 7: 1},
    ("NYC", "PWM", "mov26"): {5: 1},
    ("BOS", "PWM", "mov26"): {2: 1, 6: 1},
    ("NYC", "BOS", "mov26"): {2: 1, 5: 1, 6: 1},
    ("BOS", "NYC", "mov26"): {3: 1, 6: 1},
}

DEMAND_JITTER = 0.05  # +/- share of seeded noise on each forecast cohort
MIN_COHORT_DEMAND = 0.05  # forecast cohorts below this are dropped

# The Hartford correction for the default case (branch, class, day, duration, dest, count).
MISSING_BOOKING = ("HFD", "box16", 3, 2, "HFD", 3)

# --- Case variants: explicit parameter overrides on the default scenario ----- #
# high_move_cost: transport at the maximum multiplier. Pricing levers have to be
# switched off too, or the plan would still contain fee and +10% actions: at the
# default $50 change cost a drop fee pays on any lane with a few one-way rentals
# regardless of move cost. The price-change cost is raised above any single
# tier's gain to do that.
HIGH_MOVE_COST_PARAMS: dict = {
    "move_cost_multiplier": 10.0,
    "change_cost": 5000.0,
}
# joint_equals_moves: moves stay at default cost; every way pricing could help
# is removed (Portland is no more price-sensitive than anywhere else, nobody
# takes a return incentive, and a price change costs more than a tier can earn).
JOINT_EQUALS_MOVES_PARAMS: dict = {
    "elasticity_by_branch": {},
    "incentive_uptake": [0.0, 0.0, 0.0],
    "change_cost": 5000.0,
}

CASES: list[CaseInfo] = [
    CaseInfo(
        id="default",
        label="Default network",
        description=(
            "Hartford to New Haven short transfer wins by staff drive (a hauler arrives "
            "too late); Portland is fixed by pricing because hauling back is expensive."
        ),
    ),
    CaseInfo(
        id="high_move_cost",
        label="High move cost",
        description=(
            "Same network as the default with two parameters changed: transport costs "
            "10x (move cost multiplier 10) and each price, fee or incentive change costs "
            "$5,000 instead of $50. Every intervention then costs more than it creates, "
            "so the plan has no actions."
        ),
    ),
    CaseInfo(
        id="joint_equals_moves",
        label="Pricing adds nothing",
        description=(
            "Same network as the default with pricing made unattractive: Portland's "
            "elasticity is the network -1.2, return-incentive uptake is zero, and each "
            "price, fee or incentive change costs $5,000 instead of $50. Moves keep their "
            "default cost, so the tool recommends moving trucks and leaves prices alone: "
            "using both levers earns no more than moves on their own."
        ),
    ),
]

# =========================================================================== #
# Generator
# =========================================================================== #

_EARTH_RADIUS_MILES = 3958.8


def _haversine_miles(lat1: float, lon1: float, lat2: float, lon2: float) -> float:
    p1, p2 = math.radians(lat1), math.radians(lat2)
    dp = p2 - p1
    dl = math.radians(lon2 - lon1)
    a = math.sin(dp / 2) ** 2 + math.cos(p1) * math.cos(p2) * math.sin(dl / 2) ** 2
    return 2 * _EARTH_RADIUS_MILES * math.asin(math.sqrt(a))


def _lane_miles() -> dict[tuple[str, str], float]:
    miles: dict[tuple[str, str], float] = {}
    for i, a in enumerate(BRANCHES):
        for b in BRANCHES[i + 1 :]:
            m = round(_haversine_miles(a[3], a[4], b[3], b[4]) * ROAD_FACTOR, 1)
            miles[(a[0], b[0])] = m
            miles[(b[0], a[0])] = m
    return miles


def _build_lanes(miles: dict[tuple[str, str], float], p: Params) -> list[Lane]:
    """Costs per contract section 4 item 10, at default params (multiplier 1)."""
    lanes = []
    for o in BRANCHES:
        for d in BRANCHES:
            if o[0] == d[0]:
                continue
            m = miles[(o[0], d[0])]
            allowed = m <= p.staff_max_miles
            staff = 2 * m / p.staff_speed_mph * p.staff_hourly + 2 * m * p.staff_per_mile
            lanes.append(
                Lane(
                    origin=o[0],
                    dest=d[0],
                    miles=m,
                    staff_allowed=allowed,
                    staff_cost=round(staff, 2) if allowed else None,
                    hauler_cost=round(p.hauler_load_fee + m * p.hauler_per_mile, 2),
                )
            )
    return lanes


def _confirmed_share(day: int) -> float:
    return CONFIRMED_LOCAL_SHARE_DAY1 * max(0.0, 1.0 - (day - 1) / CONFIRMED_LOCAL_WINDOW)


def _local_shape(branch_id: str, class_id: str, day: int) -> float:
    shape = LOCAL_SHAPE_OVERRIDES.get((branch_id, class_id), LOCAL_SHAPE)
    return shape[(day - 1) % 7]


def _build_default(seed: int) -> Scenario:
    rng = random.Random(seed)
    p = Params()
    days = range(1, p.horizon_days + 1)
    branch_ids = [b[0] for b in BRANCHES]
    class_ids = [c[0] for c in CLASSES]
    rate = {c[0]: c[3] for c in CLASSES}
    miles = _lane_miles()

    branches = [
        Branch(
            id=bid, name=name, short_name=short, lat=lat, lon=lon, role=role,
            nearest_branch_id=min((o for o in branch_ids if o != bid), key=lambda o: miles[(bid, o)]),
        )
        for bid, name, short, lat, lon, role in BRANCHES
    ]
    classes = [VehicleClass(id=c, name=n, short_name=s, daily_rate=r) for c, n, s, r in CLASSES]

    # --- in-progress rentals ------------------------------------------------ #
    in_progress = [
        InProgressReturn(
            id=f"ip-{i:04d}", branch_id=due, origin=origin, class_id=k, return_day=day,
            count=n, kind="local" if origin == due else "oneway",
        )
        for i, (due, origin, k, day, n) in enumerate(IN_PROGRESS, start=1)
    ]

    # --- fleet -------------------------------------------------------------- #
    # Total fleet of a class = start inventory + every truck out on an in-progress
    # rental. All in-progress rentals are listed (durations are at most 3 days, so
    # they all return by day 3; none return after day 14), so nothing is hidden.
    # A branch's assigned fleet = its start inventory + the in-progress rentals it
    # rented out (its origin trucks), which matches contract item 9 (in-progress
    # truck-days count at the origin) and sums over branches to the class total.
    fleet = []
    for k in class_ids:
        for b in branch_ids:
            out = sum(r.count for r in in_progress if r.class_id == k and r.origin == b)
            fleet.append(
                FleetRow(
                    branch_id=b, class_id=k,
                    start_inventory=START_INVENTORY[k][b],
                    assigned_fleet=START_INVENTORY[k][b] + out,
                )
            )

    # --- confirmed bookings ------------------------------------------------- #
    raw_bookings: list[tuple[str, str, str, int, int]] = []  # origin, dest, class, day, count
    for k in class_ids:
        for b in branch_ids:
            override = CONFIRMED_LOCAL_OVERRIDES.get((b, k))
            for d in days:
                if override is not None:
                    n = override.get(d, 0)
                else:
                    x = LOCAL_BASE[k][b] * _local_shape(b, k, d) * _confirmed_share(d)
                    n = int(x + rng.random())  # seeded stochastic rounding
                if n > 0:
                    raw_bookings.append((b, b, k, d, n))
    for (o, dst, k), by_day in CONFIRMED_ONEWAY.items():
        for d, n in sorted(by_day.items()):
            raw_bookings.append((o, dst, k, d, n))

    bookings = [
        Booking(
            id=f"bk-{i:04d}", origin=o, dest=dst, class_id=k, start_day=d,
            duration_days=p.local_duration_days if o == dst else p.oneway_duration_days,
            count=n, kind="local" if o == dst else "oneway", daily_price=rate[k],
        )
        for i, (o, dst, k, d, n) in enumerate(raw_bookings, start=1)
    ]

    # --- forecast new demand ------------------------------------------------ #
    raw_demand: list[tuple[str, str, str, int, float]] = []
    for k in class_ids:
        for b in branch_ids:
            for d in days:
                x = LOCAL_BASE[k][b] * _local_shape(b, k, d) * (1.0 - _confirmed_share(d))
                raw_demand.append((b, b, k, d, x))
    for o, dst, k, per_day in ONEWAY_STREAMS:
        for d in days:
            raw_demand.append((o, dst, k, d, per_day * ONEWAY_SHAPE[(d - 1) % 7]))

    demand = []
    for o, dst, k, d, x in raw_demand:
        x = round(x * (1.0 + rng.uniform(-DEMAND_JITTER, DEMAND_JITTER)), 2)
        if x < MIN_COHORT_DEMAND:
            continue
        demand.append(
            DemandCohort(
                id=f"dm-{len(demand) + 1:04d}", origin=o, dest=dst, class_id=k, start_day=d,
                duration_days=p.local_duration_days if o == dst else p.oneway_duration_days,
                kind="local" if o == dst else "oneway", base_demand=x,
            )
        )

    return Scenario(
        case=CASES[0], seed=seed, start_date=START_DATE, params=p,
        branches=branches, classes=classes, lanes=_build_lanes(miles, p),
        fleet=fleet, in_progress_returns=in_progress, bookings=bookings, demand=demand,
    )


def _with_params(case_id: str, overrides: dict) -> Callable[[Scenario], Scenario]:
    """A variant that differs from the default only in its default parameters.

    Lane costs stay as listed (per truck at multiplier 1); the model applies
    params.move_cost_multiplier itself.
    """

    def build(base: Scenario) -> Scenario:
        case = next(c for c in CASES if c.id == case_id)
        params = Params.model_validate({**base.params.model_dump(), **overrides})
        return base.model_copy(update={"case": case, "params": params}, deep=True)

    return build


_VARIANTS: dict[str, Callable[[Scenario], Scenario]] = {
    "default": lambda base: base.model_copy(deep=True),
    "high_move_cost": _with_params("high_move_cost", HIGH_MOVE_COST_PARAMS),
    "joint_equals_moves": _with_params("joint_equals_moves", JOINT_EQUALS_MOVES_PARAMS),
}


@lru_cache(maxsize=4)
def _default(seed: int) -> Scenario:
    return _build_default(seed)


# =========================================================================== #
# Public API
# =========================================================================== #


def list_cases() -> list[CaseInfo]:
    return [c.model_copy() for c in CASES]


def get_scenario(case_id: str = "default") -> Scenario:
    """The scenario for a case. Deterministic; each call returns a fresh copy."""
    if case_id not in _VARIANTS:
        raise KeyError(case_id)
    return _VARIANTS[case_id](_default(SEED))


def suggested_missing_booking() -> ReportedBooking:
    """The booking Hartford reports in the default case: it should change the plan."""
    branch, class_id, day, duration, dest, count = MISSING_BOOKING
    return ReportedBooking(
        branch_id=branch, class_id=class_id, start_day=day,
        duration_days=duration, dest_branch_id=dest, count=count,
    )
