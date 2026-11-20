"""FastAPI service. Stateless: every request carries case_id, parameter overrides, added
bookings and the ops lead's decisions (approved / rejected actions).

Two cache layers keep clicks cheap:
  * inputs (case, params, bookings)      -> the four unconstrained strategy solves
  * inputs + decisions                   -> the current plan, its response, and one
                                            re-solve per action for "cost of refusing"
An approve or reject click therefore costs at most two solves (current plan and
approved-only), and none when the decision does not constrain the unconstrained joint.
"""

from __future__ import annotations

import hashlib
import json
import threading
import time
from collections import OrderedDict
from concurrent.futures import Future, ThreadPoolExecutor
from dataclasses import dataclass, field
from typing import Optional

from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware

from . import explain, model
from .data import get_scenario, list_cases, suggested_missing_booking
from .schemas import (
    ApprovedAction,
    Booking,
    CaseInfo,
    ExplainBatchRequest,
    ExplainBatchResponse,
    ExplainRequest,
    ExplainResponse,
    ParamOverrides,
    Params,
    ReportedBooking,
    Scenario,
    SolveRequest,
    SolveResponse,
)

app = FastAPI(title="Fleet rebalancing prototype")
app.add_middleware(
    CORSMiddleware,
    allow_origins=["http://localhost:5173", "http://127.0.0.1:5173"],
    allow_methods=["*"],
    allow_headers=["*"],
)


@dataclass
class _Base:
    """One set of inputs: the four strategies with no decisions applied."""

    key: str
    scenario: Scenario
    params: Params
    added: list[Booking]
    sols: dict[str, model.Solution]


@dataclass
class _Entry:
    """One set of inputs plus decisions: the current plan."""

    base: _Base
    approved: list[ApprovedAction]
    rejected: list[str]
    current: model.Solution
    response: SolveResponse
    replans: dict[str, Future] = field(default_factory=dict)  # action id -> re-solve
    explains: dict[str, ExplainResponse] = field(default_factory=dict)


_BASES: "OrderedDict[str, _Base]" = OrderedDict()
_ENTRIES: "OrderedDict[str, _Entry]" = OrderedDict()
_BASES_MAX, _ENTRIES_MAX = 32, 128
_LOCK = threading.Lock()  # one solve of a plan at a time; guards both caches
_REPLAN_LOCK = threading.Lock()
_POOL = ThreadPoolExecutor(max_workers=8, thread_name_prefix="replan")  # HiGHS frees the GIL


# --------------------------------------------------------------------------- #
# Inputs
# --------------------------------------------------------------------------- #


def _scenario_or_404(case_id: str) -> Scenario:
    try:
        return get_scenario(case_id)
    except KeyError:
        raise HTTPException(status_code=404, detail=f"Unknown case: {case_id}")


def effective_params(scenario: Scenario, overrides: ParamOverrides) -> Params:
    """The case's parameters with any overrides applied on top."""
    merged = scenario.params.model_dump()
    merged.update(overrides.model_dump(exclude_none=True))
    return Params(**merged)


def to_bookings(scenario: Scenario, reported: list[ReportedBooking], params: Params) -> list[Booking]:
    branch_ids = {b.id for b in scenario.branches}
    rates = {k.id: k.daily_rate for k in scenario.classes}
    out = []
    for n, rb in enumerate(reported, start=1):
        if rb.branch_id not in branch_ids or rb.dest_branch_id not in branch_ids:
            raise HTTPException(status_code=422, detail=f"Unknown branch in added booking {n}")
        if rb.class_id not in rates:
            raise HTTPException(status_code=422, detail=f"Unknown class in added booking {n}")
        if rb.start_day > params.horizon_days:
            raise HTTPException(status_code=422, detail=f"Added booking {n} starts after the horizon")
        out.append(
            Booking(
                id=f"rep-{n}",
                origin=rb.branch_id,
                dest=rb.dest_branch_id,
                class_id=rb.class_id,
                start_day=rb.start_day,
                duration_days=rb.duration_days,
                count=rb.count,
                kind="local" if rb.branch_id == rb.dest_branch_id else "oneway",
                daily_price=rates[rb.class_id],
                source="reported",
            )
        )
    return out


def _hash(*parts) -> str:
    return hashlib.sha1(json.dumps(parts, sort_keys=True).encode()).hexdigest()[:16]


# --------------------------------------------------------------------------- #
# Decisions
# --------------------------------------------------------------------------- #


def _bad(detail: str) -> HTTPException:
    return HTTPException(status_code=422, detail=detail)


def _parse_id(action_id: str, scenario: Scenario, params: Params) -> tuple:
    """('move', origin, dest, class, mode, day) | ('rate', b, k) | ('fee', b) |
    ('incentive', b). 422 on anything that is not a possible action on this network."""
    branches = {b.id for b in scenario.branches}
    classes = {k.id for k in scenario.classes}
    parts = action_id.split(":")
    kind = parts[0]
    if kind == "move" and len(parts) == 5 and parts[1].count(">") == 1:
        o, d = parts[1].split(">")
        k, mode, day_s = parts[2], parts[3], parts[4]
        lane = next((ln for ln in scenario.lanes if ln.origin == o and ln.dest == d), None)
        if (
            o in branches and d in branches and o != d and lane is not None
            and k in classes and mode in ("staff", "hauler")
            and day_s[:1] == "d" and day_s[1:].isdigit()
        ):
            day = int(day_s[1:])
            if not 1 <= day <= params.dispatch_days:
                raise _bad(f"{action_id}: dispatch day must be 1..{params.dispatch_days}")
            if mode == "staff" and not (lane.staff_allowed and lane.miles <= params.staff_max_miles):
                raise _bad(f"{action_id}: the lane is too long for a staff drive")
            return ("move", o, d, k, mode, day)
    elif kind == "rate" and len(parts) == 3 and parts[1] in branches and parts[2] in classes:
        return ("rate", parts[1], parts[2])
    elif kind in ("fee", "incentive") and len(parts) == 2 and parts[1] in branches:
        return (kind, parts[1])
    raise _bad(f"Unknown or malformed action id: {action_id}")


def _tier_value(action_id: str, name: str, value: Optional[float], tiers: list[float]) -> float:
    if value is None:
        raise _bad(f"Approved {action_id} needs `{name}`")
    for t in tiers:
        if abs(t - value) < 1e-9 and abs(t) > 1e-12:
            return t
    options = [t for t in tiers if abs(t) > 1e-12]
    raise _bad(f"Approved {action_id}: {name}={value} is not one of {options}")


def validate_decisions(
    scenario: Scenario, params: Params, approved: list[ApprovedAction], rejected: list[str]
) -> tuple[list[ApprovedAction], list[str]]:
    """Normalised (sorted, de-duplicated) decisions, or 422."""
    rejected = sorted(set(rejected))
    for rid in rejected:
        _parse_id(rid, scenario, params)
    out: dict[str, ApprovedAction] = {}
    staff: dict[tuple, int] = {}
    for a in approved:
        if a.id in out:
            raise _bad(f"{a.id} is approved more than once")
        if a.id in rejected:
            raise _bad(f"{a.id} is both approved and rejected")
        parsed = _parse_id(a.id, scenario, params)
        if parsed[0] == "move":
            if a.count is None or a.count < 1:
                raise _bad(f"Approved {a.id} needs a `count` of at least 1")
            out[a.id] = ApprovedAction(id=a.id, count=a.count)
            if parsed[4] == "staff":
                key = (parsed[1], parsed[5])
                staff[key] = staff.get(key, 0) + a.count
                if staff[key] > params.staff_max_per_branch_day:
                    raise _bad(
                        f"Approved staff drives from {parsed[1]} on day {parsed[5]} exceed "
                        f"the limit of {params.staff_max_per_branch_day} a day"
                    )
        elif parsed[0] == "rate":
            v = _tier_value(a.id, "tier_pct", a.tier_pct, params.rate_tiers)
            out[a.id] = ApprovedAction(id=a.id, tier_pct=v)
        elif parsed[0] == "fee":
            v = _tier_value(a.id, "fee", a.fee, params.fee_tiers)
            out[a.id] = ApprovedAction(id=a.id, fee=v)
        else:
            v = _tier_value(a.id, "amount", a.amount, params.incentive_tiers)
            out[a.id] = ApprovedAction(id=a.id, amount=v)
    return [out[k] for k in sorted(out)], rejected


def _already_satisfied(joint: model.Solution, approved: list[ApprovedAction], rejected: list[str]) -> bool:
    """True when the unconstrained joint plan already obeys every decision, so it is
    also the optimum under them and no re-solve is needed."""
    moves = {m.id: m.count for m in joint.moves}
    approved_ids = {a.id for a in approved}
    for a in approved:
        kind = a.id.split(":")[0]
        if kind == "move":
            ok = moves.get(a.id) == a.count
        elif kind == "rate":
            _k, b, k = a.id.split(":")
            ok = abs(joint.rate_tier.get((b, k), 0.0) - a.tier_pct) < 1e-9
        elif kind == "fee":
            ok = abs(joint.fee_tier.get(a.id.split(":")[1], 0.0) - a.fee) < 1e-9
        else:
            ok = abs(joint.incentive_tier.get(a.id.split(":")[1], 0.0) - a.amount) < 1e-9
        if not ok:
            return False
    live = set(joint.action_ids())
    for rid in rejected:
        if rid.startswith("move:"):
            lane = ":".join(rid.split(":")[:3]) + ":"
            if any(i.startswith(lane) and i not in approved_ids for i in moves):
                return False
        elif rid in live:
            return False
    return True


# --------------------------------------------------------------------------- #
# Solving with the two cache layers
# --------------------------------------------------------------------------- #


def _trim(cache: OrderedDict, limit: int) -> None:
    while len(cache) > limit:
        cache.popitem(last=False)


def _solve(req: SolveRequest) -> tuple[_Entry, bool]:
    scenario = _scenario_or_404(req.case_id)
    params = effective_params(scenario, req.params)
    added = to_bookings(scenario, req.added_bookings, params)
    approved, rejected = validate_decisions(scenario, params, req.approved, req.rejected_action_ids)
    base_key = _hash(req.case_id, params.model_dump(), [b.model_dump() for b in added])
    key = _hash(base_key, [a.model_dump() for a in approved], rejected)
    with _LOCK:
        entry = _ENTRIES.get(key)
        if entry is not None:
            _ENTRIES.move_to_end(key)
            return entry, True

        base = _BASES.get(base_key)
        base_ms = 0.0
        if base is None:
            sols = model.solve_all(scenario, params, added)
            base = _Base(base_key, scenario, params, added, sols)
            base_ms = sum(s.solve_ms for s in sols.values())
            _BASES[base_key] = base
            _trim(_BASES, _BASES_MAX)
        else:
            _BASES.move_to_end(base_key)

        joint = base.sols["joint"]
        extra_ms = 0.0
        if _already_satisfied(joint, approved, rejected):
            current = joint
        else:
            current = model.solve(
                scenario, params, allow_moves=True, allow_pricing=True,
                forbid=rejected, approved=approved, extra_bookings=added,
                hint=joint.plan_values,
            )
            extra_ms += current.solve_ms
            if current.status == "infeasible":
                raise _bad(
                    "The approved actions cannot all be carried out together "
                    "(not enough trucks at a branch on a dispatch day)"
                )
        approved_only = None
        if approved:
            approved_only = model.solve(
                scenario, params, allow_moves=False, allow_pricing=False,
                approved=approved, extra_bookings=added,
            )
            extra_ms += approved_only.solve_ms
        response = explain.build_solve_response(
            scenario, params, added, base.sols,
            current=current, approved_only=approved_only,
            approved_ids=[a.id for a in approved], rejected_ids=rejected,
            request_key=key, case_id=req.case_id,
        )
        # this request's own solve time: the four strategies only if they ran now
        response.total_solve_ms = round(base_ms + extra_ms, 1)
        entry = _Entry(base, approved, rejected, current, response)
        _ENTRIES[key] = entry
        _trim(_ENTRIES, _ENTRIES_MAX)
        return entry, False


def _replan(entry: _Entry, action_id: str) -> Future:
    """The (shared, cached) re-solve of the current plan with one action refused."""
    with _REPLAN_LOCK:
        fut = entry.replans.get(action_id)
        if fut is None:
            b = entry.base
            fut = _POOL.submit(
                explain.replan_without, b.scenario, b.params, b.added, entry.current,
                action_id, entry.approved, entry.rejected,
            )
            entry.replans[action_id] = fut
        return fut


def _require_in_plan(entry: _Entry, action_ids: list[str]) -> None:
    in_plan = {a.id for a in entry.response.plan.actions}
    for aid in action_ids:
        if aid not in in_plan:
            raise HTTPException(
                status_code=404,
                detail=f"Action {aid} is not in the current plan for these inputs and decisions",
            )


# --------------------------------------------------------------------------- #
# Routes
# --------------------------------------------------------------------------- #


@app.get("/api/health")
def health() -> dict:
    return {"status": "ok"}


@app.get("/api/cases", response_model=list[CaseInfo])
def cases() -> list[CaseInfo]:
    return list_cases()


@app.get("/api/scenario", response_model=Scenario)
def scenario(case_id: str = "default") -> Scenario:
    return _scenario_or_404(case_id)


@app.get("/api/suggested-booking", response_model=ReportedBooking)
def suggested_booking() -> ReportedBooking:
    return suggested_missing_booking()


@app.post("/api/solve", response_model=SolveResponse)
def solve(req: SolveRequest) -> SolveResponse:
    entry, cached = _solve(req)
    return entry.response.model_copy(update={"cached": cached})


@app.post("/api/explain/action", response_model=ExplainResponse)
def explain_action(req: ExplainRequest) -> ExplainResponse:
    entry, _cached = _solve(req)
    hit = entry.explains.get(req.action_id)
    if hit is not None:
        return hit
    _require_in_plan(entry, [req.action_id])
    replanned = _replan(entry, req.action_id).result()
    b = entry.base
    result = explain.explain_action(
        b.scenario, b.params, b.added, b.sols, req.action_id,
        current=entry.current, approved=entry.approved, rejected=entry.rejected,
        replanned=replanned,
    )
    entry.explains[req.action_id] = result
    return result


@app.post("/api/explain/batch", response_model=ExplainBatchResponse)
def explain_batch(req: ExplainBatchRequest) -> ExplainBatchResponse:
    t0 = time.perf_counter()
    entry, _cached = _solve(req)
    actions = {a.id: a for a in entry.response.plan.actions}
    ids = list(actions) if req.action_ids is None else list(dict.fromkeys(req.action_ids))
    _require_in_plan(entry, ids)
    futures = [(aid, _replan(entry, aid)) for aid in ids]  # all submitted before any wait
    items = [
        explain.action_value(actions[aid], entry.current, fut.result())
        for aid, fut in futures
    ]
    return ExplainBatchResponse(
        items=items, solve_ms=round((time.perf_counter() - t0) * 1000.0, 1)
    )


@app.post("/api/conditional")
def conditional() -> None:
    raise HTTPException(status_code=501, detail="Not built: stretch item")
