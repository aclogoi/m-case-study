import { useEffect, useLayoutEffect, useMemo, useRef } from "react";
import { BACKEND_START_COMMAND, USE_MOCK } from "./api/client";
import { ActionDetail } from "./components/ActionDetail";
import { useChangedAssumptions } from "./components/AssumptionsPanel";
import { BranchView } from "./components/BranchView";
import { BrokenBanner } from "./components/BrokenBanner";
import { ErrorBoundary } from "./components/ErrorBoundary";
import { DecisionQueue } from "./components/DecisionQueue";
import { EvidenceDrawer } from "./components/Evidence";
import { HandOff } from "./components/HandOff";
import { SituationBoard } from "./components/SituationBoard";
import { TallyBar } from "./components/TallyBar";
import { Spinner } from "./components/ui";
import { calendarDate } from "./lib/format";
import { LookupProvider, makeLookups, useDecisions, useStore, type View } from "./state/store";

function ErrorPanel({ compact }: { compact?: boolean }) {
  const { error, retry } = useStore();
  if (!error) return null;
  return (
    <div className={`banner banner-critical no-print ${compact ? "" : "banner-large"}`} role="alert">
      <div className="banner-title">
        <span className="banner-icon" aria-hidden="true">!</span>
        {error.unreachable ? "The backend is unreachable" : "The request failed"}
      </div>
      <p>{error.message}</p>
      {!USE_MOCK && (
        <p>
          {error.unreachable ? "Start it" : "If the backend is not running, start it"} from <code>backend/</code> with <code>{BACKEND_START_COMMAND}</code>, or run the frontend without it using <code>npm run dev:mock</code>.
        </p>
      )}
      {compact && <p>What you see below is from the last successful solve and may not match your latest change.</p>}
      <button type="button" className="btn" onClick={retry}>Try again</button>
    </div>
  );
}

/** Asks before a case switch throws away decisions or reported bookings. In the page, not a browser dialog. */
function CaseSwitchDialog() {
  const { caseSwitch, cases, confirmCaseSwitch, cancelCaseSwitch } = useStore();
  const cancelRef = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    if (!caseSwitch) return;
    cancelRef.current?.focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") cancelCaseSwitch();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [caseSwitch, cancelCaseSwitch]);
  if (!caseSwitch) return null;
  const label = cases.find((c) => c.id === caseSwitch.id)?.label ?? caseSwitch.id;
  return (
    <div className="dialog-wrap no-print">
      <div className="scrim" onClick={cancelCaseSwitch} />
      <div className="dialog" role="alertdialog" aria-modal="true" aria-labelledby="case-switch-title" aria-describedby="case-switch-text">
        <h2 id="case-switch-title">Switch to “{label}”?</h2>
        <p id="case-switch-text">{caseSwitch.message} This cannot be undone.</p>
        <div className="dialog-buttons">
          <button type="button" className="btn" ref={cancelRef} onClick={cancelCaseSwitch}>Stay on this case</button>
          <button type="button" className="btn btn-primary" onClick={confirmCaseSwitch}>Switch and clear</button>
        </div>
      </div>
    </div>
  );
}

export function App() {
  const { scenario, result, solving, error, view, setView, selectedActionId, cases, caseId, changeCase, setEvidenceOpen, resetOverrides } = useStore();
  // The main network is the default; anything else is an alternate case loaded from the evidence drawer.
  const mainCaseId = cases[0]?.id ?? "default";
  const alternate = caseId !== mainCaseId ? cases.find((c) => c.id === caseId)?.label ?? scenario?.case.label ?? caseId : null;
  const changedAssumptions = useChangedAssumptions();
  const { counts } = useDecisions();
  const lookups = useMemo(() => (scenario ? makeLookups(scenario) : null), [scenario]);
  const ready = !!(lookups && result);
  const mainRef = useRef<HTMLElement>(null);

  // Each view starts at its top, with one exception: coming back from an action's detail
  // returns to the same place in the decision list, not to its first card.
  const shown = useRef<View>(view);
  const queueScroll = useRef(0);
  useLayoutEffect(() => {
    const back = view === "decisions" && shown.current === "action";
    shown.current = view;
    mainRef.current?.scrollTo({ top: back ? queueScroll.current : 0 });
  }, [view, selectedActionId]);

  const tabs: { id: View; label: string; badge?: number }[] = [
    { id: "situation", label: "Situation" },
    { id: "decisions", label: "Decisions", badge: counts.pending },
    { id: "branches", label: "Branches" },
    { id: "handoff", label: "Hand-off", badge: counts.approved },
  ];
  const active = view === "action" ? "decisions" : view;

  return (
    <div className="app">
      <header className="topbar no-print">
        <div className="brand">
          <div className="brand-title">Fleet rebalancing</div>
          <div className="brand-sub">
            {scenario ? `${scenario.branches.length} branches · two weeks from ${calendarDate(scenario.start_date, 1)}` : "Loading the scenario…"}
          </div>
        </div>
        <nav className="tabs" aria-label="Views">
          {tabs.map((t) => (
            <button key={t.id} type="button" aria-current={active === t.id ? "page" : undefined} className={`tab ${active === t.id ? "on" : ""}`} onClick={() => setView(t.id)}>
              {t.label}
              {t.badge !== undefined && t.badge > 0 && <span className="badge">{t.badge}</span>}
            </button>
          ))}
        </nav>
        <div className="top-status" aria-live="polite">
          {solving && ready && (
            <span className="resolving">
              <span className="spinner small" aria-hidden="true" />
              Rebuilding the plan…
            </span>
          )}
          {/* No picker here: the alternate cases live under "Why trust this?". This only says when one is loaded. */}
          {alternate && (
            <span className="pill pill-warn" title="An alternate case is loaded in place of the main network">
              Alternate case: {alternate}
              <button type="button" className="link" onClick={() => changeCase(mainCaseId)}>Back to the main network</button>
            </span>
          )}
          {changedAssumptions.length > 0 && (
            <span className="pill pill-warn" title={`Every figure on screen uses changed assumptions: ${changedAssumptions.join(", ")}`}>
              Assumptions changed
              <button type="button" className="link" onClick={() => setEvidenceOpen(true, "assumptions")}>Review</button>
              <button type="button" className="link" onClick={resetOverrides}>Reset</button>
            </span>
          )}
          <button type="button" className="btn btn-small" onClick={() => setEvidenceOpen(true)}>Why trust this?</button>
          {USE_MOCK && <span className="pill pill-mock" title="VITE_USE_MOCK=1: responses come from src/api/mock.ts, not the optimizer">Mock data</span>}
        </div>
      </header>

      {ready && <TallyBar />}

      <main
        ref={mainRef}
        className={`main ${solving && ready ? "is-stale" : ""}`}
        onScroll={(e) => {
          if (shown.current === "decisions") queueScroll.current = e.currentTarget.scrollTop;
        }}
      >
        {error && <ErrorPanel compact={ready} />}
        {!ready && !error && (
          <div className="card loading-card">
            <Spinner label="Working out the situation and the plan…" />
          </div>
        )}
        {ready && lookups && result && (
          <LookupProvider value={lookups}>
            <BrokenBanner result={result} />
            <ErrorBoundary resetKey={view}>
              {view === "situation" && <SituationBoard />}
              {view === "decisions" && <DecisionQueue />}
              {view === "action" && <ActionDetail />}
              {view === "branches" && <BranchView />}
              {view === "handoff" && <HandOff />}
            </ErrorBoundary>
          </LookupProvider>
        )}
      </main>

      <EvidenceDrawer />
      <CaseSwitchDialog />
    </div>
  );
}
