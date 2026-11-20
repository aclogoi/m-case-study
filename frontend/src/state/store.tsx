import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { ApiError, explainBatch, getCases, getScenario, solve } from "../api/client";
import type {
  Action,
  ActionValue,
  ApprovedAction,
  Branch,
  CaseInfo,
  ParamOverrides,
  ReportedBooking,
  Scenario,
  SolveRequest,
  SolveResponse,
  VehicleClass,
} from "../api/types";
import { calendarDate, longDate, weekdayLong } from "../lib/format";

export type View = "situation" | "decisions" | "action" | "branches" | "handoff";
export type SliderKey = "elasticity_scale" | "fee_deterrence_scale" | "incentive_uptake_scale" | "move_cost_multiplier";
export type SliderOverrides = Partial<Record<SliderKey, number>>;
/** Decision queue order: by when each decision falls due, or by what refusing it would cost. */
export type QueueSort = "due" | "value";
export type EvidenceSection = "top" | "assumptions";

export interface AppError {
  message: string;
  unreachable: boolean;
}

/** What the last re-solve was for, and the plan before it, so the page can say what changed. */
export interface PlanChange {
  before: SolveResponse;
  kind: "booking-added" | "booking-removed" | "rejected" | "restored";
  booking?: ReportedBooking;
  action?: Action;
}

interface Store {
  // inputs: everything a request carries (the backend is stateless)
  caseId: string;
  overrides: SliderOverrides;
  addedBookings: ReportedBooking[];
  approved: ApprovedAction[];
  /** Rejected actions as they looked when rejected; the server never sends them back. */
  rejected: Action[];
  // server data
  cases: CaseInfo[];
  scenario: Scenario | null;
  result: SolveResponse | null;
  /** The request that produced `result`. Explain calls use this, so they describe the plan on screen. */
  resultRequest: SolveRequest | null;
  previous: SolveResponse | null;
  change: PlanChange | null;
  /** Cost of refusing, by action id. Kept across re-solves and refreshed after each one. */
  values: Record<string, ActionValue>;
  valuesFresh: boolean;
  valuesError: string | null;
  /** Approved actions as they looked when approved, in case a solve does not return one. */
  approvedSnapshots: Record<string, Action>;
  // status
  solving: boolean;
  error: AppError | null;
  // selection
  view: View;
  evidenceOpen: boolean;
  /** Where the evidence drawer opens: at its top, or scrolled to the sliders. */
  evidenceSection: EvidenceSection;
  queueSort: QueueSort;
  /** A case switch waiting for the user to confirm, because it would clear their work. */
  caseSwitch: { id: string; message: string } | null;
  selectedActionId: string | null;
  selectedBranchId: string;
  // commands
  setCase: (id: string) => void;
  /** `setCase`, after asking first when there are decisions or reported bookings to lose. */
  changeCase: (id: string) => void;
  confirmCaseSwitch: () => void;
  cancelCaseSwitch: () => void;
  setQueueSort: (s: QueueSort) => void;
  setOverride: (key: SliderKey, value: number) => void;
  resetOverrides: () => void;
  addBooking: (b: ReportedBooking) => void;
  removeBooking: (index: number) => void;
  approve: (actions: Action[]) => void;
  undoApprove: (id: string) => void;
  reject: (action: Action) => void;
  restore: (id: string) => void;
  dismissChange: () => void;
  setView: (v: View) => void;
  setEvidenceOpen: (open: boolean, section?: EvidenceSection) => void;
  openAction: (id: string) => void;
  selectBranch: (id: string, show?: boolean) => void;
  retry: () => void;
}

const Ctx = createContext<Store | null>(null);

export function useStore(): Store {
  const s = useContext(Ctx);
  if (!s) throw new Error("useStore outside StoreProvider");
  return s;
}

function toAppError(e: unknown): AppError {
  if (e instanceof ApiError) return { message: e.message, unreachable: e.unreachable };
  return { message: e instanceof Error ? e.message : String(e), unreachable: false };
}

/** The quantity an approval pins: the id alone does not carry it. */
export function toApproved(a: Action): ApprovedAction {
  switch (a.type) {
    case "move":
      return { id: a.id, count: a.count };
    case "rate":
      return { id: a.id, tier_pct: a.tier_pct };
    case "fee":
      return { id: a.id, fee: a.fee };
    case "incentive":
      return { id: a.id, amount: a.amount };
  }
}

const SOLVE_DEBOUNCE_MS = 400;

export function StoreProvider({ children }: { children: ReactNode }) {
  const [caseId, setCaseId] = useState("default");
  const [overrides, setOverrides] = useState<SliderOverrides>({});
  const [addedBookings, setAddedBookings] = useState<ReportedBooking[]>([]);
  const [approved, setApproved] = useState<ApprovedAction[]>([]);
  const [approvedSnapshots, setApprovedSnapshots] = useState<Record<string, Action>>({});
  const [rejected, setRejected] = useState<Action[]>([]);
  const [cases, setCases] = useState<CaseInfo[]>([]);
  const [scenario, setScenario] = useState<Scenario | null>(null);
  const [solved, setSolved] = useState<{ result: SolveResponse; request: SolveRequest } | null>(null);
  const [previous, setPrevious] = useState<SolveResponse | null>(null);
  const [change, setChange] = useState<PlanChange | null>(null);
  const [values, setValues] = useState<Record<string, ActionValue>>({});
  const [valuesFor, setValuesFor] = useState<SolveResponse | null>(null);
  const [valuesError, setValuesError] = useState<string | null>(null);
  const [solving, setSolving] = useState(false);
  const [error, setError] = useState<AppError | null>(null);
  const [view, setView] = useState<View>("situation");
  const [evidenceOpen, setEvidenceOpenState] = useState(false);
  const [evidenceSection, setEvidenceSection] = useState<EvidenceSection>("top");
  const [queueSort, setQueueSort] = useState<QueueSort>("due");
  const [caseSwitch, setCaseSwitch] = useState<{ id: string; message: string } | null>(null);
  const [selectedActionId, setSelectedActionId] = useState<string | null>(null);
  const [selectedBranchId, setSelectedBranchId] = useState("HFD");
  const [retryTick, setRetryTick] = useState(0);

  const result = solved?.result ?? null;
  const resultRef = useRef<SolveResponse | null>(null);
  const seq = useRef(0);
  /** Slider edits debounce; every other input change solves at once. */
  const debounceNext = useRef(false);
  const pending = useRef<(Omit<PlanChange, "before"> & { before: SolveResponse | null }) | null>(null);

  const request: SolveRequest = useMemo(
    () => ({
      case_id: caseId,
      params: overrides as ParamOverrides,
      added_bookings: addedBookings,
      approved,
      rejected_action_ids: rejected.map((a) => a.id),
    }),
    [caseId, overrides, addedBookings, approved, rejected],
  );

  useEffect(() => {
    let live = true;
    getCases()
      .then((c) => live && setCases(c))
      .catch((e) => live && setError(toAppError(e)));
    return () => {
      live = false;
    };
  }, [retryTick]);

  useEffect(() => {
    let live = true;
    getScenario(caseId)
      .then((s) => {
        if (!live) return;
        setScenario(s);
        setSelectedBranchId((cur) => (s.branches.some((b) => b.id === cur) ? cur : s.branches[0]?.id ?? cur));
      })
      .catch((e) => live && setError(toAppError(e)));
    return () => {
      live = false;
    };
  }, [caseId, retryTick]);

  useEffect(() => {
    const delay = debounceNext.current ? SOLVE_DEBOUNCE_MS : 0;
    debounceNext.current = false;
    const mine = ++seq.current;
    const controller = new AbortController();
    setSolving(true);
    const timer = setTimeout(() => {
      solve(request, controller.signal)
        .then((res) => {
          if (mine !== seq.current) return;
          setPrevious(resultRef.current);
          resultRef.current = res;
          setSolved({ result: res, request });
          setError(null);
          setSolving(false);
          const pd = pending.current;
          pending.current = null;
          if (pd && pd.before) setChange({ ...pd, before: pd.before });
        })
        .catch((e) => {
          if (mine !== seq.current) return;
          if (e instanceof DOMException && e.name === "AbortError") return;
          pending.current = null;
          setError(toAppError(e));
          setSolving(false);
        });
    }, delay);
    return () => {
      clearTimeout(timer);
      controller.abort();
    };
  }, [request, retryTick]);

  // After every solve, ask what refusing each action in the plan would cost.
  useEffect(() => {
    if (!solved) return;
    const { result: res, request: req } = solved;
    if (res.plan.actions.length === 0) {
      setValuesFor(res);
      setValuesError(null);
      return;
    }
    let live = true;
    const controller = new AbortController();
    explainBatch(req, controller.signal)
      .then((b) => {
        if (!live) return;
        setValues((old) => ({ ...old, ...Object.fromEntries(b.items.map((i) => [i.action_id, i])) }));
        setValuesFor(res);
        setValuesError(null);
      })
      .catch((e) => {
        if (!live || (e instanceof DOMException && e.name === "AbortError")) return;
        setValuesError(e instanceof Error ? e.message : String(e));
      });
    return () => {
      live = false;
      controller.abort();
    };
  }, [solved]);

  const setCase = useCallback((id: string) => {
    setCaseId(id);
    setOverrides({});
    setAddedBookings([]);
    setApproved([]);
    setApprovedSnapshots({});
    setRejected([]);
    setChange(null);
    setValues({});
    setValuesFor(null);
    setSelectedActionId(null);
    pending.current = null;
    // A different case is a different network: do not show the old one under the new name.
    resultRef.current = null;
    setSolved(null);
    setPrevious(null);
    setScenario(null);
    setView((v) => (v === "action" ? "decisions" : v));
  }, []);

  const changeCase = useCallback(
    (id: string) => {
      if (id === caseId) return;
      const decisions = approved.length + rejected.length;
      const bookings = addedBookings.length;
      if (decisions + bookings > 0) {
        const parts = [
          decisions > 0 ? `${decisions} ${decisions === 1 ? "decision" : "decisions"}` : "",
          bookings > 0 ? `${bookings} reported ${bookings === 1 ? "booking" : "bookings"}` : "",
        ].filter(Boolean);
        setCaseSwitch({ id, message: `Switching case clears your ${parts.join(" and ")} and resets the sliders.` });
        return;
      }
      setCase(id);
    },
    [caseId, approved, rejected, addedBookings, setCase],
  );

  const confirmCaseSwitch = useCallback(() => {
    if (caseSwitch) setCase(caseSwitch.id);
    setCaseSwitch(null);
  }, [caseSwitch, setCase]);

  const cancelCaseSwitch = useCallback(() => setCaseSwitch(null), []);

  const setEvidenceOpen = useCallback((open: boolean, section: EvidenceSection = "top") => {
    setEvidenceSection(section);
    setEvidenceOpenState(open);
  }, []);

  const setOverride = useCallback((key: SliderKey, value: number) => {
    debounceNext.current = true;
    setChange(null);
    setOverrides((o) => ({ ...o, [key]: value }));
  }, []);

  const resetOverrides = useCallback(() => {
    setChange(null);
    setOverrides({});
  }, []);

  const note = (c: Omit<PlanChange, "before">) => {
    pending.current = { ...c, before: pending.current?.before ?? resultRef.current };
  };

  const addBooking = useCallback((b: ReportedBooking) => {
    note({ kind: "booking-added", booking: b });
    setAddedBookings((list) => [...list, b]);
  }, []);

  const removeBooking = useCallback(
    (index: number) => {
      const b = addedBookings[index];
      if (!b) return;
      note({ kind: "booking-removed", booking: b });
      setAddedBookings((list) => list.filter((_, i) => i !== index));
    },
    [addedBookings],
  );

  const approve = useCallback((actions: Action[]) => {
    if (actions.length === 0) return;
    // A "Rejected" / "Restored" notice describes the plan before this approval.
    setChange(null);
    const ids = new Set(actions.map((a) => a.id));
    setApproved((list) => [...list.filter((a) => !ids.has(a.id)), ...actions.map(toApproved)]);
    setApprovedSnapshots((m) => ({ ...m, ...Object.fromEntries(actions.map((a) => [a.id, { ...a, decision: "approved" as const }])) }));
    // An action cannot be both: approving one that was rejected restores it first.
    setRejected((list) => list.filter((a) => !ids.has(a.id)));
  }, []);

  const undoApprove = useCallback((id: string) => {
    setChange(null);
    setApproved((list) => list.filter((a) => a.id !== id));
    setApprovedSnapshots((m) => {
      const { [id]: _gone, ...rest } = m;
      return rest;
    });
  }, []);

  const reject = useCallback((action: Action) => {
    note({ kind: "rejected", action });
    setApproved((list) => list.filter((a) => a.id !== action.id));
    setApprovedSnapshots((m) => {
      const { [action.id]: _gone, ...rest } = m;
      return rest;
    });
    setRejected((list) => [...list.filter((a) => a.id !== action.id), { ...action, decision: "proposed" }]);
  }, []);

  const restore = useCallback(
    (id: string) => {
      const action = rejected.find((a) => a.id === id);
      if (!action) return;
      note({ kind: "restored", action });
      setRejected((list) => list.filter((a) => a.id !== id));
    },
    [rejected],
  );

  const dismissChange = useCallback(() => setChange(null), []);

  const openAction = useCallback((id: string) => {
    setSelectedActionId(id);
    setView("action");
  }, []);

  const selectBranch = useCallback((id: string, show = false) => {
    setSelectedBranchId(id);
    if (show) setView("branches");
  }, []);

  const retry = useCallback(() => {
    setError(null);
    setRetryTick((t) => t + 1);
  }, []);

  const value: Store = {
    caseId, overrides, addedBookings, approved, rejected, cases, scenario, changeCase,
    result, resultRequest: solved?.request ?? null, previous, change,
    values, valuesFresh: !!result && valuesFor === result, valuesError, approvedSnapshots,
    solving, error, view, evidenceOpen, evidenceSection, queueSort, caseSwitch, selectedActionId, selectedBranchId,
    confirmCaseSwitch, cancelCaseSwitch, setQueueSort,
    setCase, setOverride, resetOverrides, addBooking, removeBooking, approve, undoApprove, reject, restore, dismissChange,
    setView, setEvidenceOpen, openAction, selectBranch, retry,
  };
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

// ------------------------------------------------------------------ derived

export interface DecisionCounts {
  approved: number;
  pending: number;
  rejected: number;
}

/** Proposed actions still waiting, the approved set, and approvals the last solve did not return. */
export function useDecisions() {
  const { result, approved, approvedSnapshots, rejected } = useStore();
  return useMemo(() => {
    const actions = result?.plan.actions ?? [];
    const approvedIds = new Set(approved.map((a) => a.id));
    const inPlan = new Set(actions.map((a) => a.id));
    // Trust the browser's list for what is approved: an approval is never dropped silently.
    const approvedActions = actions.filter((a) => approvedIds.has(a.id) || a.decision === "approved");
    const missing = approved.filter((a) => !inPlan.has(a.id)).map((a) => approvedSnapshots[a.id]).filter((a): a is Action => !!a);
    const pendingActions = actions.filter((a) => !approvedIds.has(a.id) && a.decision !== "approved");
    const counts: DecisionCounts = { approved: approved.length, pending: pendingActions.length, rejected: rejected.length };
    return { actions, approvedIds, approvedActions, missing, pendingActions, counts };
  }, [result, approved, approvedSnapshots, rejected]);
}

/**
 * Approved actions the plan would now be better off without (refusing them would gain
 * money). An approval stays pinned through every re-solve, so this is how a new fact
 * that undermines one gets surfaced instead of hidden.
 */
export function useSoured(): { action: Action; gain: number }[] {
  const { values, valuesFresh } = useStore();
  const { approvedActions } = useDecisions();
  return useMemo(
    () => (valuesFresh ? approvedActions.filter((a) => (values[a.id]?.reduction ?? 0) < -0.5).map((a) => ({ action: a, gain: -(values[a.id]?.reduction ?? 0) })) : []),
    [values, valuesFresh, approvedActions],
  );
}

// ------------------------------------------------------------------ lookups

export interface Lookups {
  scenario: Scenario;
  branch: (id: string | null | undefined) => Branch | undefined;
  branchName: (id: string | null | undefined) => string;
  vehicleClass: (id: string | null | undefined) => VehicleClass | undefined;
  className: (id: string | null | undefined, n?: number) => string;
  /** "Tue 24 Nov", or a dash when there is no day. */
  day: (d: number | null | undefined) => string;
  /** "Tuesday" */
  weekday: (d: number) => string;
  /** "Tue 24 Nov" */
  date: (d: number) => string;
  /** "Tuesday 24 Nov" */
  longDate: (d: number) => string;
}

export function makeLookups(scenario: Scenario): Lookups {
  const branches = new Map(scenario.branches.map((b) => [b.id, b]));
  const classes = new Map(scenario.classes.map((c) => [c.id, c]));
  return {
    scenario,
    branch: (id) => (id ? branches.get(id) : undefined),
    branchName: (id) => (id ? branches.get(id)?.short_name ?? id : "—"),
    vehicleClass: (id) => (id ? classes.get(id) : undefined),
    className: (id, n = 1) => {
      const name = id ? classes.get(id)?.short_name ?? id : "truck";
      return n === 1 ? name : `${name}s`;
    },
    day: (d) => (d === null || d === undefined ? "—" : calendarDate(scenario.start_date, d)),
    weekday: (d) => weekdayLong(scenario.start_date, d),
    date: (d) => calendarDate(scenario.start_date, d),
    longDate: (d) => longDate(scenario.start_date, d),
  };
}

const LookupCtx = createContext<Lookups | null>(null);
export const LookupProvider = LookupCtx.Provider;
export function useLookups(): Lookups {
  const l = useContext(LookupCtx);
  if (!l) throw new Error("useLookups outside LookupProvider");
  return l;
}

export function actionById(result: SolveResponse | null, id: string | null): Action | undefined {
  return id ? result?.plan.actions.find((a) => a.id === id) : undefined;
}
