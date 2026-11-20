"""The rebalancing MIP: one model, four strategies via flags.

Semantics follow docs/API_CONTRACT.md section 4. Plan variables (moves, tier one-hots)
are shared across demand scenarios; fulfilment and availability are per scenario.

Every column carries "ledger" entries (component, branch, day, amount). The objective
is the weighted sum of those entries, and the reported numbers are the same entries
times the solution, so the totals, the week split and the branch scorecards all come
from one set of books.
"""

from __future__ import annotations

import time
from collections import defaultdict
from dataclasses import dataclass, field
from typing import Iterable, Optional

import highspy
import numpy as np

from .schemas import Booking, Params, Scenario

COMPONENTS = [
    "rental_revenue",
    "fee_revenue",
    "variable_cost",
    "incentive_payments",
    "transport_cost",
    "change_cost",
]
C_RENT, C_FEE, C_VAR, C_INC, C_TRANS, C_CHANGE = range(6)
SIGNS = np.array([1.0, 1.0, -1.0, -1.0, -1.0, -1.0])

_INF = highspy.kHighsInf
_EPS = 1e-9


# --------------------------------------------------------------------------- #
# Small shared helpers
# --------------------------------------------------------------------------- #


def staff_unit_cost(miles: float, p: Params) -> float:
    return (
        2 * miles / p.staff_speed_mph * p.staff_hourly + 2 * miles * p.staff_per_mile
    ) * p.move_cost_multiplier


def hauler_unit_cost(miles: float, p: Params) -> float:
    return (p.hauler_load_fee + miles * p.hauler_per_mile) * p.move_cost_multiplier


def base_tier(values: list[float]) -> int:
    for i, v in enumerate(values):
        if abs(v) < 1e-12:
            return i
    raise ValueError("tier list has no base (zero) tier")


def move_action_id(origin: str, dest: str, class_id: str, mode: str, day: int) -> str:
    return f"move:{origin}>{dest}:{class_id}:{mode}:d{day}"


def divert_target(scenario: Scenario, origin: str, dest: str) -> Optional[str]:
    """Where a rental deterred by a fee at `dest` rebooks: nearest(dest), or the next
    nearest to `dest` if that is the rental's origin (contract 4.13)."""
    by_id = {b.id: b for b in scenario.branches}
    first = by_id[dest].nearest_branch_id
    if first != origin and first != dest and first in by_id:
        return first
    ranked = sorted(
        (ln.miles, ln.dest)
        for ln in scenario.lanes
        if ln.origin == dest and ln.dest not in (origin, dest, first)
    )
    return ranked[0][1] if ranked else None


@dataclass
class MoveChoice:
    origin: str
    dest: str
    class_id: str
    mode: str
    dispatch_day: int
    arrival_day: int
    count: int
    unit_cost: float

    @property
    def id(self) -> str:
        return move_action_id(
            self.origin, self.dest, self.class_id, self.mode, self.dispatch_day
        )

    @property
    def cost(self) -> float:
        return self.unit_cost * self.count


@dataclass
class Solution:
    status: str  # optimal | time_limit | infeasible
    gap: Optional[float]
    solve_ms: float
    allow_moves: bool
    allow_pricing: bool
    forbid: tuple[str, ...]

    branch_ids: list[str]
    class_ids: list[str]
    scenario_ids: list[str]
    scenario_labels: list[str]
    weights: np.ndarray  # [S], sums to 1
    horizon: int
    penalty_rate: float

    moves: list[MoveChoice] = field(default_factory=list)
    rate_tier: dict[tuple[str, str], float] = field(default_factory=dict)  # pct
    fee_tier: dict[str, float] = field(default_factory=dict)  # dollars
    incentive_tier: dict[str, float] = field(default_factory=dict)  # dollars

    # All arrays are per scenario unless noted; days are 0-indexed (day d -> d-1).
    money: np.ndarray = None  # [S, 6, B, H] positive magnitudes
    rented: np.ndarray = None  # [S, B, K, H] rented truck-days at origin (incl. in-progress)
    starts: np.ndarray = None  # [S, B, K, H] rentals fulfilled by origin and start day
    dispatched: np.ndarray = None  # [B, K, H] trucks sent out (plan level)
    avail: np.ndarray = None  # [S, B, K, H] on the lot at the start of the day
    unmet: np.ndarray = None  # [S, B, K, H] new demand at chosen tier not served
    unmet_revenue: np.ndarray = None  # [S, B, K, H] in-horizon rental revenue of that demand
    on_rent_start: np.ndarray = None  # [S, K, H] trucks out on rental at start of day
    in_transit_start: np.ndarray = None  # [K, H] trucks on the road at start of day
    fleet_total: np.ndarray = None  # [K]
    broken: np.ndarray = None  # [S, n_bookings]
    bookings: list[Booking] = field(default_factory=list)
    redirects: np.ndarray = None  # [S, B_to, B_from] incentive-redirected returns
    fee_deterred: np.ndarray = None  # [S, B] one-way demand deterred by the fee into B
    fee_diverted: np.ndarray = None  # [S, B, B_to] deterred rentals fulfilled elsewhere
    plan_values: dict = field(default_factory=dict)  # integer column key -> value

    # ---- derived numbers ---------------------------------------------------- #

    @property
    def idle(self) -> np.ndarray:
        """[S, B, K, H] trucks still on the lot after the day's rentals and moves left."""
        return np.maximum(self.avail - self.starts - self.dispatched[None], 0.0)

    def expect(self, arr: np.ndarray) -> np.ndarray:
        """Scenario-weighted mean over the leading axis."""
        return np.tensordot(self.weights, arr, axes=(0, 0))

    def contribution_by_scenario(self) -> np.ndarray:
        return np.einsum("scbd,c->s", self.money, SIGNS)

    def contribution_by_day(self) -> np.ndarray:
        """Expected contribution per day, [H]."""
        return self.expect(np.einsum("scbd,c->sd", self.money, SIGNS))

    @property
    def expected_contribution(self) -> float:
        return float(self.weights @ self.contribution_by_scenario())

    def broken_by_scenario(self) -> np.ndarray:
        return self.broken.sum(axis=1) if self.broken.size else np.zeros(len(self.weights))

    @property
    def expected_broken(self) -> float:
        return float(self.weights @ self.broken_by_scenario())

    @property
    def expected_penalty(self) -> float:
        return self.penalty_rate * self.expected_broken

    @property
    def objective(self) -> float:
        return self.expected_contribution - self.expected_penalty

    def components(self) -> dict[str, float]:
        tot = self.expect(self.money).sum(axis=(1, 2))
        return {name: float(tot[i]) for i, name in enumerate(COMPONENTS)}

    def branch_revenue(self) -> np.ndarray:
        """Expected rental + fee revenue booked at each branch, [B]."""
        m = self.expect(self.money)
        return (m[C_RENT] + m[C_FEE]).sum(axis=1)

    @property
    def action_count(self) -> int:
        n = len(self.moves)
        n += sum(1 for v in self.rate_tier.values() if abs(v) > 1e-12)
        n += sum(1 for v in self.fee_tier.values() if abs(v) > 1e-12)
        n += sum(1 for v in self.incentive_tier.values() if abs(v) > 1e-12)
        return n

    def action_ids(self) -> list[str]:
        ids = [m.id for m in sorted(self.moves, key=_move_sort)]
        ids += [f"rate:{b}:{k}" for (b, k), v in self.rate_tier.items() if abs(v) > 1e-12]
        ids += [f"fee:{b}" for b, v in self.fee_tier.items() if abs(v) > 1e-12]
        ids += [f"incentive:{b}" for b, v in self.incentive_tier.items() if abs(v) > 1e-12]
        return ids


def _move_sort(m: MoveChoice):
    return (m.dispatch_day, m.origin, m.dest, m.class_id, m.mode)


# --------------------------------------------------------------------------- #
# Model builder
# --------------------------------------------------------------------------- #


class _Builder:
    def __init__(self) -> None:
        self.cost: list[float] = []
        self.lb: list[float] = []
        self.ub: list[float] = []
        self.integer: list[bool] = []
        self.row_lb: list[float] = []
        self.row_ub: list[float] = []
        self.row_start: list[int] = [0]
        self.row_idx: list[int] = []
        self.row_val: list[float] = []

    def col(self, lb: float = 0.0, ub: float = _INF, integer: bool = False) -> int:
        self.cost.append(0.0)
        self.lb.append(lb)
        self.ub.append(ub)
        self.integer.append(integer)
        return len(self.cost) - 1

    def row(self, terms: Iterable[tuple[int, float]], lb: float, ub: float) -> None:
        merged: dict[int, float] = {}
        for i, v in terms:
            merged[i] = merged.get(i, 0.0) + v
        for i, v in merged.items():
            if v != 0.0:
                self.row_idx.append(i)
                self.row_val.append(v)
        self.row_start.append(len(self.row_idx))
        self.row_lb.append(lb)
        self.row_ub.append(ub)


def tier_index(values: list[float], value: float) -> int:
    for i, v in enumerate(values):
        if abs(v - value) < 1e-9:
            return i
    raise ValueError(f"{value} is not one of the tiers {values}")


def _parse_approved(approved: Iterable):
    """Approved actions (anything with id / count / tier_pct / fee / amount) ->
    fixed move cells and fixed tier values."""
    moves: dict[tuple, int] = {}
    rates: dict[tuple, float] = {}
    fees: dict[str, float] = {}
    incs: dict[str, float] = {}
    for a in approved:
        parts = a.id.split(":")
        try:
            if parts[0] == "move" and len(parts) == 5:
                o, d = parts[1].split(">", 1)
                moves[(o, d, parts[2], parts[3], int(parts[4].lstrip("d")))] = int(a.count)
            elif parts[0] == "rate" and len(parts) == 3:
                rates[(parts[1], parts[2])] = float(a.tier_pct)
            elif parts[0] == "fee" and len(parts) == 2:
                fees[parts[1]] = float(a.fee)
            elif parts[0] == "incentive" and len(parts) == 2:
                incs[parts[1]] = float(a.amount)
            else:
                raise ValueError
        except (ValueError, TypeError):
            raise ValueError(f"cannot hold approved action: {a.id}")
    return moves, rates, fees, incs


def _parse_forbid(forbid: Iterable[str]):
    lanes, rates, fees, incs = set(), set(), set(), set()
    for aid in forbid:
        parts = aid.split(":")
        if parts[0] == "move" and len(parts) >= 3 and ">" in parts[1]:
            o, d = parts[1].split(">", 1)
            lanes.add((o, d, parts[2]))
        elif parts[0] == "rate" and len(parts) == 3:
            rates.add((parts[1], parts[2]))
        elif parts[0] == "fee" and len(parts) == 2:
            fees.add(parts[1])
        elif parts[0] == "incentive" and len(parts) == 2:
            incs.add(parts[1])
        else:
            raise ValueError(f"cannot forbid unknown action id: {aid}")
    return lanes, rates, fees, incs


def solve(
    scenario: Scenario,
    params: Optional[Params] = None,
    *,
    allow_moves: bool = True,
    allow_pricing: bool = True,
    forbid: Iterable[str] = (),
    approved: Iterable = (),
    extra_bookings: Iterable[Booking] = (),
    hint: Optional[dict] = None,
    mip_rel_gap: float = 1e-6,
) -> Solution:
    """Build and solve the model.

    forbid: action ids (contract section 4, "Forbidding an action").
    approved: approved actions (contract section 7), held exactly: a move cell is fixed
            at its count and a tier at its value, whatever the strategy flags and
            `forbid` say. With both flags off this evaluates exactly the approved
            actions and nothing else.
    hint:   `Solution.plan_values` from another solve of the same inputs, used as a MIP
            start. Plan variables missing from the hint start at base / zero.
    """
    t0 = time.perf_counter()
    p = params or scenario.params
    forbid = tuple(forbid)
    f_lanes, f_rates, f_fees, f_incs = _parse_forbid(forbid)
    a_moves, a_rates, a_fees, a_incs = _parse_approved(approved)

    H = p.horizon_days
    branches = [b.id for b in scenario.branches]
    classes = [k.id for k in scenario.classes]
    bi = {b: i for i, b in enumerate(branches)}
    ki = {k: i for i, k in enumerate(classes)}
    nB, nK, nS = len(branches), len(classes), len(p.scenarios)
    rate_of = {k.id: k.daily_rate for k in scenario.classes}
    nearest = {b.id: b.nearest_branch_id for b in scenario.branches}
    wsum = sum(s.weight for s in p.scenarios) or 1.0
    weights = np.array([s.weight / wsum for s in p.scenarios])
    scales = [s.scale for s in p.scenarios]
    bookings = list(scenario.bookings) + list(extra_bookings)

    rt_base, ft_base, it_base = (
        base_tier(p.rate_tiers),
        base_tier(p.fee_tiers),
        base_tier(p.incentive_tiers),
    )
    deter = [min(1.0, d * p.fee_deterrence_scale) for d in p.fee_deterrence]
    uptake = [min(1.0, u * p.incentive_uptake_scale) for u in p.incentive_uptake]

    def valid_day(d: int) -> bool:
        return 1 <= d <= H

    # ---- which tiers are open ------------------------------------------------ #
    local_keys = {
        (c.origin, c.class_id)
        for c in scenario.demand
        if c.kind == "local" and c.base_demand > 0 and valid_day(c.start_day)
    }
    fee_keys = {
        c.dest
        for c in scenario.demand
        if c.kind == "oneway" and c.base_demand > 0 and valid_day(c.start_day)
    }

    def booking_incentive_branch(bk: Booking) -> Optional[str]:
        if bk.kind != "oneway" or bk.dest == bk.origin:
            return None
        if bk.start_day + bk.duration_days > H:
            return None
        return nearest.get(bk.dest)

    inc_keys = {booking_incentive_branch(bk) for bk in bookings} - {None}
    for r in scenario.in_progress_returns:
        if r.kind == "oneway" and valid_day(r.return_day) and r.count > 0:
            inc_keys.add(nearest.get(r.branch_id))
    inc_keys.discard(None)

    def tiers_for(n: int, base: int, open_: bool) -> list[int]:
        return list(range(n)) if open_ else [base]

    m = _Builder()
    int_keys: dict[int, tuple] = {}  # integer col -> key
    int_default: dict[int, float] = {}

    def onehot(kind: str, key: tuple, tiers: list[int], base: int) -> dict[int, Optional[int]]:
        """tier index -> y column, or None when the tier is fixed on."""
        if len(tiers) == 1:
            return {tiers[0]: None}
        cols = {}
        for t in tiers:
            c = m.col(0.0, 1.0, integer=True)
            cols[t] = c
            int_keys[c] = (kind, *key, t)
            int_default[c] = 1.0 if t == base else 0.0
        m.row([(c, 1.0) for c in cols.values()], 1.0, 1.0)
        return cols

    money_const = np.zeros((6, nB, H))  # plan-level dollars that are not on a column

    def held(values: list[float], value: float, base: int, b: str) -> list[int]:
        """An approved tier: the only one open, and its change cost is a constant."""
        t = tier_index(values, value)
        if t != base:
            money_const[C_CHANGE, bi[b], 0] += p.change_cost
        return [t]

    y_rate: dict[tuple[str, str], dict[int, Optional[int]]] = {}
    for b in branches:
        for k in classes:
            if (b, k) in a_rates:
                tiers = held(p.rate_tiers, a_rates[(b, k)], rt_base, b)
            else:
                open_ = allow_pricing and (b, k) not in f_rates and (b, k) in local_keys
                tiers = tiers_for(len(p.rate_tiers), rt_base, open_)
            y_rate[(b, k)] = onehot("yr", (b, k), tiers, rt_base)
    y_fee: dict[str, dict[int, Optional[int]]] = {}
    y_inc: dict[str, dict[int, Optional[int]]] = {}
    for b in branches:
        if b in a_fees:
            tiers = held(p.fee_tiers, a_fees[b], ft_base, b)
        else:
            open_ = allow_pricing and b not in f_fees and b in fee_keys
            tiers = tiers_for(len(p.fee_tiers), ft_base, open_)
        y_fee[b] = onehot("yf", (b,), tiers, ft_base)
        if b in a_incs:
            tiers = held(p.incentive_tiers, a_incs[b], it_base, b)
        else:
            open_ = allow_pricing and b not in f_incs and b in inc_keys
            tiers = tiers_for(len(p.incentive_tiers), it_base, open_)
        y_inc[b] = onehot("yi", (b,), tiers, it_base)

    # ---- ledgers ------------------------------------------------------------- #
    money_e: list[tuple[int, int, int, int, int, float]] = []  # col, s(-1 all), comp, b, d0, amt
    rented_e: list[tuple[int, int, int, int, int, float]] = []  # col, s, b, k, d0, coef
    starts_e: list[tuple[int, int, int, int, int, float]] = []
    onrent_e: list[tuple[int, int, int, int, float]] = []  # col, s, k, d0, coef
    unmet_e: list[tuple[int, Optional[int], float, int, int, int, int, float]] = []
    redirect_e: list[tuple[int, int, int, int, float]] = []  # col, s(-1), b_to, b_from, coef
    deterred_e: list[tuple[Optional[int], int, int, float]] = []  # ycol, s, j, amount
    diverted_e: list[tuple[int, int, int, int]] = []  # col, s, j, b_to

    out_t: dict[tuple, list] = defaultdict(list)  # (s,b,k,d) -> [(col, coef)]
    in_t: dict[tuple, list] = defaultdict(list)
    in_const = np.zeros((nB, nK, H + 2))
    redirect_const = np.zeros((nB, nB))
    rented_const = np.zeros((nB, nK, H))
    onrent_const = np.zeros((nK, H))

    # change costs
    for (b, k), cols in y_rate.items():
        for t, c in cols.items():
            if c is not None and t != rt_base:
                money_e.append((c, -1, C_CHANGE, bi[b], 0, p.change_cost))
    for b in branches:
        for t, c in y_fee[b].items():
            if c is not None and t != ft_base:
                money_e.append((c, -1, C_CHANGE, bi[b], 0, p.change_cost))
        for t, c in y_inc[b].items():
            if c is not None and t != it_base:
                money_e.append((c, -1, C_CHANGE, bi[b], 0, p.change_cost))

    def add_rental(col, s, origin, k, start, dur, price, returns):
        """Register one fulfilment column: departure, return(s), money, truck-days."""
        o, kk = bi[origin], ki[k]
        out_t[(s, o, kk, start)].append((col, 1.0))
        end = start + dur
        if end <= H:
            for dest, share in returns:
                if share:
                    in_t[(s, bi[dest], kk, end)].append((col, share))
        vc = p.variable_cost_pct * rate_of[k]
        for d in range(start, min(end - 1, H) + 1):
            money_e.append((col, s, C_RENT, o, d - 1, price))
            money_e.append((col, s, C_VAR, o, d - 1, vc))
            rented_e.append((col, s, o, kk, d - 1, 1.0))
            if d > start:
                onrent_e.append((col, s, kk, d - 1, 1.0))
        starts_e.append((col, s, o, kk, start - 1, 1.0))

    # ---- new demand ------------------------------------------------------------ #
    for c in scenario.demand:
        if c.origin not in bi or c.dest not in bi or c.class_id not in ki:
            continue
        if not valid_day(c.start_day) or c.base_demand <= 0 or c.duration_days < 1:
            continue
        o, kk = bi[c.origin], ki[c.class_id]
        rate = rate_of[c.class_id]
        days_in = min(c.duration_days, H - c.start_day + 1)
        if c.kind == "local":
            elast = (
                p.elasticity_by_branch.get(c.origin, p.elasticity_default)
                * p.elasticity_scale
            )
            for t, ycol in y_rate[(c.origin, c.class_id)].items():
                pct = p.rate_tiers[t]
                factor = (1.0 + pct) ** elast
                for s in range(nS):
                    ub = c.base_demand * scales[s] * factor
                    f = m.col(0.0, ub)
                    if ycol is not None:
                        m.row([(f, 1.0), (ycol, -ub)], -_INF, 0.0)
                    add_rental(
                        f, s, c.origin, c.class_id, c.start_day, c.duration_days,
                        rate * (1.0 + pct), [(c.origin, 1.0)],
                    )
                    unmet_e.append(
                        (f, ycol, ub, s, o, kk, c.start_day - 1, rate * (1.0 + pct) * days_in)
                    )
        else:
            j = c.dest
            target = divert_target(scenario, c.origin, j)
            for t, ycol in y_fee[j].items():
                dt, fee = deter[t], p.fee_tiers[t]
                for s in range(nS):
                    full = c.base_demand * scales[s]
                    ub = full * (1.0 - dt)
                    if dt > 0:
                        deterred_e.append((ycol, s, bi[j], full * dt))
                    if ub > _EPS:
                        f = m.col(0.0, ub)
                        if ycol is not None:
                            m.row([(f, 1.0), (ycol, -ub)], -_INF, 0.0)
                        add_rental(
                            f, s, c.origin, c.class_id, c.start_day, c.duration_days,
                            rate, [(j, 1.0)],
                        )
                        if fee:
                            money_e.append((f, s, C_FEE, bi[j], c.start_day - 1, fee))
                        unmet_e.append((f, ycol, ub, s, o, kk, c.start_day - 1, rate * days_in))
                    ub2 = full * dt * p.fee_divert_share
                    if ub2 > _EPS and target is not None:
                        g = m.col(0.0, ub2)
                        if ycol is not None:
                            m.row([(g, 1.0), (ycol, -ub2)], -_INF, 0.0)
                        add_rental(
                            g, s, c.origin, c.class_id, c.start_day, c.duration_days,
                            rate, [(target, 1.0)],
                        )
                        unmet_e.append((g, ycol, ub2, s, o, kk, c.start_day - 1, rate * days_in))
                        diverted_e.append((g, s, bi[j], bi[target]))

    # ---- confirmed bookings ---------------------------------------------------- #
    broken_cols = np.full((nS, len(bookings)), -1, dtype=int)
    penalty_cost: dict[int, float] = {}
    for n, bk in enumerate(bookings):
        if bk.origin not in bi or bk.dest not in bi or bk.class_id not in ki:
            raise ValueError(f"booking {bk.id} references an unknown branch or class")
        if not valid_day(bk.start_day) or bk.count <= 0:
            continue
        b_inc = booking_incentive_branch(bk)
        tiers = y_inc[b_inc] if b_inc is not None else {it_base: None}
        for s in range(nS):
            u = m.col(0.0, bk.count)
            broken_cols[s, n] = u
            penalty_cost[u] = p.broken_commitment_penalty * weights[s]
            terms = [(u, 1.0)]
            for t, ycol in tiers.items():
                f = m.col(0.0, bk.count)
                terms.append((f, 1.0))
                if ycol is not None:
                    m.row([(f, 1.0), (ycol, -float(bk.count))], -_INF, 0.0)
                ut = uptake[t] if b_inc is not None else 0.0
                returns = [(bk.dest, 1.0 - ut)]
                if ut > 0:
                    returns.append((b_inc, ut))
                    day0 = bk.start_day + bk.duration_days - 1
                    money_e.append(
                        (f, s, C_INC, bi[b_inc], day0, p.incentive_tiers[t] * ut)
                    )
                    redirect_e.append((f, s, bi[b_inc], bi[bk.dest], ut))
                add_rental(
                    f, s, bk.origin, bk.class_id, bk.start_day, bk.duration_days,
                    bk.daily_price, returns,
                )
            m.row(terms, float(bk.count), float(bk.count))

    # ---- rentals already out at the start of day 1 ----------------------------- #
    for r in scenario.in_progress_returns:
        if r.branch_id not in bi or r.class_id not in ki or r.count <= 0:
            continue
        if not valid_day(r.return_day):
            continue
        j, kk = bi[r.branch_id], ki[r.class_id]
        in_const[j, kk, r.return_day] += r.count
        if r.origin in bi:
            rented_const[bi[r.origin], kk, : r.return_day - 1] += r.count
        onrent_const[kk, : r.return_day - 1] += r.count
        b_inc = nearest.get(r.branch_id) if r.kind == "oneway" else None
        if b_inc is None or b_inc not in bi:
            continue
        for t, ycol in y_inc[b_inc].items():
            ut = uptake[t]
            if ut <= 0:
                continue
            moved = r.count * ut
            if ycol is None:  # tier held by an approval: the redirect is a constant
                in_const[j, kk, r.return_day] -= moved
                in_const[bi[b_inc], kk, r.return_day] += moved
                money_const[C_INC, bi[b_inc], r.return_day - 1] += p.incentive_tiers[t] * moved
                redirect_const[bi[b_inc], j] += moved
                continue
            for s in range(nS):
                in_t[(s, j, kk, r.return_day)].append((ycol, -moved))
                in_t[(s, bi[b_inc], kk, r.return_day)].append((ycol, moved))
            money_e.append(
                (ycol, -1, C_INC, bi[b_inc], r.return_day - 1, p.incentive_tiers[t] * moved)
            )
            redirect_e.append((ycol, -1, bi[b_inc], j, moved))

    # ---- moves ------------------------------------------------------------------- #
    start_inv = np.zeros((nB, nK))
    for fr in scenario.fleet:
        if fr.branch_id in bi and fr.class_id in ki:
            start_inv[bi[fr.branch_id], ki[fr.class_id]] += fr.start_inventory
    fleet_total = start_inv.sum(axis=0) + np.array(
        [
            sum(
                r.count
                for r in scenario.in_progress_returns
                if r.class_id == k and valid_day(r.return_day) and r.branch_id in bi
            )
            for k in classes
        ]
    )

    move_cols: list[tuple[int, MoveChoice]] = []
    int_fixed: dict[int, float] = {}
    staff_rows: dict[tuple[str, int], list] = defaultdict(list)
    seen_fixed = set()
    for ln in scenario.lanes:
        if ln.origin not in bi or ln.dest not in bi or ln.origin == ln.dest:
            continue
        modes = [("hauler", p.hauler_transit_days, hauler_unit_cost(ln.miles, p))]
        if ln.staff_allowed and ln.miles <= p.staff_max_miles:
            modes.insert(0, ("staff", p.staff_transit_days, staff_unit_cost(ln.miles, p)))
        for k in classes:
            closed = not allow_moves or (ln.origin, ln.dest, k) in f_lanes
            cap = float(fleet_total[ki[k]])
            for mode, transit, unit in modes:
                for d in range(1, min(p.dispatch_days, H) + 1):
                    key = (ln.origin, ln.dest, k, mode, d)
                    fixed = a_moves.get(key)
                    if fixed is None and closed:
                        continue
                    if fixed is None:
                        x = m.col(0.0, cap, integer=True)
                        int_default[x] = 0.0
                    else:  # approved: held at exactly this count
                        x = m.col(float(fixed), float(fixed), integer=True)
                        int_default[x] = int_fixed[x] = float(fixed)
                        seen_fixed.add(key)
                    int_keys[x] = ("x", *key)
                    mc = MoveChoice(ln.origin, ln.dest, k, mode, d, d + transit, 0, unit)
                    move_cols.append((x, mc))
                    money_e.append((x, -1, C_TRANS, bi[ln.origin], d - 1, unit))
                    for s in range(nS):
                        out_t[(s, bi[ln.origin], ki[k], d)].append((x, 1.0))
                        if d + transit <= H:
                            in_t[(s, bi[ln.dest], ki[k], d + transit)].append((x, 1.0))
                    if mode == "staff":
                        staff_rows[(ln.origin, d)].append((x, 1.0))
    missing = set(a_moves) - seen_fixed
    if missing:
        raise ValueError(f"approved move is not possible on this network: {sorted(missing)}")
    for terms in staff_rows.values():
        m.row(terms, -_INF, float(p.staff_max_per_branch_day))

    # ---- daily balance ------------------------------------------------------------ #
    avail_cols = np.zeros((nS, nB, nK, H), dtype=int)
    for s in range(nS):
        for b in range(nB):
            for k in range(nK):
                for d in range(1, H + 1):
                    avail_cols[s, b, k, d - 1] = m.col(0.0, _INF)
    for s in range(nS):
        for b in range(nB):
            for k in range(nK):
                for d in range(1, H + 1):
                    a = avail_cols[s, b, k, d - 1]
                    arrivals = [(c, -v) for c, v in in_t.get((s, b, k, d), [])]
                    const = in_const[b, k, d]
                    if d == 1:
                        rhs = start_inv[b, k] + const
                        m.row([(a, 1.0)] + arrivals, rhs, rhs)
                    else:
                        prev = avail_cols[s, b, k, d - 2]
                        leaving = out_t.get((s, b, k, d - 1), [])
                        m.row([(a, 1.0), (prev, -1.0)] + leaving + arrivals, const, const)
                    # rentals starting plus moves dispatched cannot exceed availability
                    leaving_today = out_t.get((s, b, k, d), [])
                    if leaving_today:
                        m.row([(a, 1.0)] + [(c, -v) for c, v in leaving_today], 0.0, _INF)

    # ---- objective ------------------------------------------------------------------ #
    cost = np.zeros(len(m.cost))
    for col, s, comp, _b, _d, amt in money_e:
        cost[col] += SIGNS[comp] * amt * (weights[s] if s >= 0 else 1.0)
    for col, pen in penalty_cost.items():
        cost[col] -= pen

    # ---- hand to HiGHS -------------------------------------------------------------- #
    ncol, nrow = len(m.cost), len(m.row_lb)
    lp = highspy.HighsLp()
    lp.num_col_ = ncol
    lp.num_row_ = nrow
    lp.sense_ = highspy.ObjSense.kMaximize
    lp.col_cost_ = cost
    lp.col_lower_ = np.array(m.lb, dtype=float)
    lp.col_upper_ = np.array(m.ub, dtype=float)
    lp.row_lower_ = np.array(m.row_lb, dtype=float)
    lp.row_upper_ = np.array(m.row_ub, dtype=float)
    lp.a_matrix_.format_ = highspy.MatrixFormat.kRowwise
    lp.a_matrix_.start_ = np.array(m.row_start, dtype=np.int32)
    lp.a_matrix_.index_ = np.array(m.row_idx, dtype=np.int32)
    lp.a_matrix_.value_ = np.array(m.row_val, dtype=float)
    int_cols = sorted(int_keys)
    if int_cols:
        integrality = [highspy.HighsVarType.kContinuous] * ncol
        for c in int_cols:
            integrality[c] = highspy.HighsVarType.kInteger
        lp.integrality_ = integrality

    h = highspy.Highs()
    h.setOptionValue("output_flag", False)
    h.setOptionValue("time_limit", float(p.time_limit_s))
    h.setOptionValue("mip_rel_gap", float(mip_rel_gap))
    h.setOptionValue("mip_abs_gap", 1e-4)
    h.setOptionValue("random_seed", 0)
    h.passModel(lp)
    if int_cols:
        start_vals = [
            int_fixed[c] if c in int_fixed
            else float((hint or {}).get(int_keys[c], int_default[c]))
            for c in int_cols
        ]
        h.setSolution(
            len(int_cols),
            np.array(int_cols, dtype=np.int32),
            np.array(start_vals, dtype=float),
        )
    h.run()

    def has_solution() -> bool:
        return h.getInfo().primal_solution_status == 2  # feasible point

    ms = h.getModelStatus()
    gap: Optional[float]
    if ms == highspy.HighsModelStatus.kOptimal:
        status = "optimal"
        g = h.getInfo().mip_gap if int_cols else 0.0
        gap = float(g) if np.isfinite(g) else 0.0
    elif ms in (
        highspy.HighsModelStatus.kInfeasible,
        highspy.HighsModelStatus.kUnboundedOrInfeasible,
    ):
        status, gap = "infeasible", None
    else:
        status = "time_limit"
        g = h.getInfo().mip_gap if has_solution() else float("inf")
        gap = float(g) if np.isfinite(g) else None
        if not has_solution():
            # No incumbent inside the limit: fall back to the hinted / do-nothing plan,
            # which is always feasible, and solve the remaining LP.
            for c in int_cols:
                v = int_fixed.get(c, float((hint or {}).get(int_keys[c], int_default[c])))
                h.changeColBounds(c, v, v)
            h.setOptionValue("time_limit", float(p.time_limit_s) + 30.0)
            h.run()
            if not has_solution():
                status = "infeasible"

    sol = Solution(
        status=status,
        gap=gap,
        solve_ms=0.0,
        allow_moves=allow_moves,
        allow_pricing=allow_pricing,
        forbid=forbid,
        branch_ids=branches,
        class_ids=classes,
        scenario_ids=[s.id for s in p.scenarios],
        scenario_labels=[s.label for s in p.scenarios],
        weights=weights,
        horizon=H,
        penalty_rate=p.broken_commitment_penalty,
        bookings=bookings,
        fleet_total=fleet_total,
    )

    if status == "infeasible":
        x = np.zeros(ncol)
    else:
        x = np.array(h.getSolution().col_value, dtype=float)
        if int_cols:
            x[int_cols] = np.round(x[int_cols])
        x[np.abs(x) < 1e-9] = 0.0

    def chosen(cols: dict[int, Optional[int]], base: int) -> int:
        if status == "infeasible":
            return base
        for t, c in cols.items():
            if c is None or x[c] > 0.5:
                return t
        return base

    for key, cols in y_rate.items():
        sol.rate_tier[key] = p.rate_tiers[chosen(cols, rt_base)]
    for b in branches:
        sol.fee_tier[b] = p.fee_tiers[chosen(y_fee[b], ft_base)]
        sol.incentive_tier[b] = p.incentive_tiers[chosen(y_inc[b], it_base)]
    sol.plan_values = {int_keys[c]: float(x[c]) for c in int_cols}

    dispatched = np.zeros((nB, nK, H))
    in_transit = np.zeros((nK, H))
    for col, mc in move_cols:
        n = int(round(x[col]))
        if n >= 1:
            mc.count = n
            sol.moves.append(mc)
            dispatched[bi[mc.origin], ki[mc.class_id], mc.dispatch_day - 1] += n
            for d in range(mc.dispatch_day + 1, min(mc.arrival_day - 1, H) + 1):
                in_transit[ki[mc.class_id], d - 1] += n
    sol.moves.sort(key=_move_sort)
    sol.dispatched = dispatched
    sol.in_transit_start = in_transit

    money = np.tile(money_const, (nS, 1, 1, 1))
    for col, s, comp, b, d0, amt in money_e:
        v = x[col] * amt
        if v:
            if s >= 0:
                money[s, comp, b, d0] += v
            else:
                money[:, comp, b, d0] += v
    sol.money = money

    rented = np.tile(rented_const, (nS, 1, 1, 1))
    for col, s, b, k, d0, coef in rented_e:
        rented[s, b, k, d0] += x[col] * coef
    sol.rented = rented
    starts = np.zeros((nS, nB, nK, H))
    for col, s, b, k, d0, coef in starts_e:
        starts[s, b, k, d0] += x[col] * coef
    sol.starts = starts
    onrent = np.tile(onrent_const, (nS, 1, 1))
    for col, s, k, d0, coef in onrent_e:
        onrent[s, k, d0] += x[col] * coef
    sol.on_rent_start = onrent
    sol.avail = x[avail_cols] if status != "infeasible" else np.zeros(avail_cols.shape)

    unmet = np.zeros((nS, nB, nK, H))
    unmet_rev = np.zeros((nS, nB, nK, H))
    for f, ycol, ub, s, b, k, d0, rev in unmet_e:
        on = 1.0 if ycol is None else x[ycol]
        if on > 0.5:
            gap_ = max(0.0, ub - x[f])
            if gap_ < 1e-7:
                continue
            unmet[s, b, k, d0] += gap_
            unmet_rev[s, b, k, d0] += gap_ * rev
    sol.unmet = unmet
    sol.unmet_revenue = unmet_rev

    if status == "infeasible":
        sol.broken = np.zeros((nS, len(bookings)))
    else:
        sol.broken = np.where(broken_cols >= 0, x[np.maximum(broken_cols, 0)], 0.0)
        sol.broken[sol.broken < 1e-7] = 0.0

    redirects = np.tile(redirect_const, (nS, 1, 1))
    for col, s, b_to, b_from, coef in redirect_e:
        v = x[col] * coef
        if s >= 0:
            redirects[s, b_to, b_from] += v
        else:
            redirects[:, b_to, b_from] += v
    sol.redirects = redirects
    deterred = np.zeros((nS, nB))
    for ycol, s, j, amt in deterred_e:
        if ycol is None or x[ycol] > 0.5:
            deterred[s, j] += amt
    sol.fee_deterred = deterred
    diverted = np.zeros((nS, nB, nB))
    for col, s, j, b_to in diverted_e:
        diverted[s, j, b_to] += x[col]
    sol.fee_diverted = diverted

    sol.solve_ms = (time.perf_counter() - t0) * 1000.0
    return sol


STRATEGIES: list[tuple[str, str, bool, bool]] = [
    ("none", "Do nothing", False, False),
    ("moves", "Moves only", True, False),
    ("pricing", "Pricing only", False, True),
    ("joint", "Joint", True, True),
]


def solve_all(
    scenario: Scenario,
    params: Optional[Params] = None,
    extra_bookings: Iterable[Booking] = (),
) -> dict[str, Solution]:  # the four UNCONSTRAINED strategies: no approvals, no rejections
    """The four strategies on the same inputs. The joint solve starts from the better
    restricted plan, so it cannot come out worse than one of them at a time limit."""
    extra = list(extra_bookings)
    out: dict[str, Solution] = {}
    for sid, _label, mv, pr in STRATEGIES:
        hint = None
        if sid == "joint":
            best = max((out["moves"], out["pricing"]), key=lambda s: s.objective)
            hint = best.plan_values
        out[sid] = solve(
            scenario, params, allow_moves=mv, allow_pricing=pr,
            extra_bookings=extra, hint=hint,
        )
    return out
