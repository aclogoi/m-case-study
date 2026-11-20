import { useEffect, useState } from "react";
import { ApiError, BACKEND_START_COMMAND, explainAction } from "../api/client";
import type { Action, ExplainResponse, SolveResponse, TransferDetail } from "../api/types";
import { MODE_LABEL, TYPE_LABEL, quantityText } from "../lib/actions";
import { diffPlans } from "../lib/diff";
import { signedUsd, usd, usdCents } from "../lib/format";
import { actionById, useDecisions, useLookups, useStore } from "../state/store";
import { DecisionButtons } from "./DecisionQueue";
import { ActualImpact, AdjustedScorecardTable } from "./Scorecards";
import { ActionName, BranchChips, Card, Delta, Kv, Spinner, StatusBadge } from "./ui";

// One answer per (plan on screen, action): reopening a card does not re-solve.
const cache = new WeakMap<SolveResponse, Map<string, ExplainResponse>>();

function useExplain(action: Action | undefined) {
  const { resultRequest, result, solving } = useStore();
  const [state, setState] = useState<{ result: SolveResponse | null; id: string | null; data: ExplainResponse | null; error: { message: string; unreachable: boolean } | null }>({ result: null, id: null, data: null, error: null });
  const [attempt, setAttempt] = useState(0);
  const id = action?.id ?? null;

  useEffect(() => {
    // Wait for an in-flight solve: the request must describe the plan on screen, decisions included.
    if (!id || !result || !resultRequest || solving) return;
    const hit = cache.get(result)?.get(id);
    if (hit) {
      setState({ result, id, data: hit, error: null });
      return;
    }
    const controller = new AbortController();
    let live = true;
    setState({ result, id, data: null, error: null });
    explainAction({ ...resultRequest, action_id: id }, controller.signal)
      .then((d) => {
        if (!cache.has(result)) cache.set(result, new Map());
        cache.get(result)!.set(id, d);
        if (live) setState({ result, id, data: d, error: null });
      })
      .catch((e) => {
        if (!live || (e instanceof DOMException && e.name === "AbortError")) return;
        setState({ result, id, data: null, error: { message: e instanceof Error ? e.message : String(e), unreachable: e instanceof ApiError && e.unreachable } });
      });
    return () => {
      live = false;
      controller.abort();
    };
  }, [id, result, resultRequest, solving, attempt]);

  const current = state.result === result && state.id === id;
  return {
    data: current ? state.data : null,
    error: current ? state.error : null,
    loading: !!id && (!current || (!state.data && !state.error)),
    retry: () => setAttempt((n) => n + 1),
  };
}

/** Whole rentals for an ops lead; a fraction of one is said as such. */
const rentals = (n: number) => (n >= 0.95 ? `about ${Math.round(n)}` : "under 1");

function TransferCard({ t }: { t: TransferDetail }) {
  const L = useLookups();
  const inTime = t.shortage_day === null ? null : t.arrival_day <= t.shortage_day;
  const alt = t.alt_mode;
  return (
    <Card title="What this transfer does" subtitle={`${t.count} ${L.className(t.class_id, t.count)}, ${L.branchName(t.donor_branch_id)} to ${L.branchName(t.receiver_branch_id)}`}>
      <div className="timeline">
        <div className="tl-step">
          <div className="tl-label">Dispatched</div>
          <div className="tl-value">{L.day(t.dispatch_day)}</div>
          <div className="fine">{L.date(t.dispatch_day)} · leaves {L.branchName(t.donor_branch_id)}</div>
        </div>
        <div className="tl-arrow" aria-hidden="true">→</div>
        <div className="tl-step">
          <div className="tl-label">Arrives</div>
          <div className="tl-value">{L.day(t.arrival_day)}</div>
          <div className="fine">{L.date(t.arrival_day)} · available at {L.branchName(t.receiver_branch_id)}</div>
        </div>
        <div className="tl-arrow" aria-hidden="true">{inTime === false ? "✕" : "→"}</div>
        <div className="tl-step">
          <div className="tl-label">Shortage day</div>
          <div className="tl-value">{t.shortage_day === null ? "None found" : L.day(t.shortage_day)}</div>
          <div className="fine">
            {t.shortage_day === null
              ? `No unmet demand at ${L.branchName(t.receiver_branch_id)} on or after arrival under do nothing`
              : inTime
                ? "The trucks are on the lot in time"
                : "The trucks arrive after it"}
          </div>
        </div>
      </div>

      <dl className="kv-grid">
        <Kv k={`Rentals lost at ${L.branchName(t.donor_branch_id)} (donor)`}>
          <span className={t.donor_rentals_lost > 0.05 ? "delta neg" : "delta zero"}>{t.donor_rentals_lost > 0.05 ? rentals(t.donor_rentals_lost) : "0"}</span>
        </Kv>
        <Kv k={`Rentals gained at ${L.branchName(t.receiver_branch_id)} (receiver)`}>
          <span className={t.receiver_rentals_gained > 0.05 ? "delta pos" : "delta zero"}>{t.receiver_rentals_gained > 0.05 ? rentals(t.receiver_rentals_gained) : "0"}</span>
        </Kv>
        <Kv k="Mode">{MODE_LABEL[t.mode]}</Kv>
        <Kv k="Transport cost">{usdCents(t.cost)}</Kv>
      </dl>
      <p className="fine">Rentals are averaged over low, base and high demand, compared with the replanned plan that leaves this transfer out.</p>

      <div className="altmode">
        <div className="altmode-title">The other mode: {MODE_LABEL[alt.mode].toLowerCase()}</div>
        {alt.allowed ? (
          <dl className="kv-grid three">
            <Kv k="Allowed on this lane">Yes</Kv>
            <Kv k="Would arrive">{alt.arrival_day === null ? "—" : L.day(alt.arrival_day)}</Kv>
            <Kv k="In time for the shortage">
              {alt.arrives_in_time === null ? "No shortage day" : alt.arrives_in_time ? <span className="delta pos">Yes</span> : <span className="delta neg">No, too late</span>}
            </Kv>
            {alt.cost !== null && <Kv k="Would cost">{usdCents(alt.cost)}</Kv>}
          </dl>
        ) : (
          <p>Not allowed on this lane{alt.mode === "staff" ? ": it is longer than a staff drive can cover." : "."}</p>
        )}
      </div>
    </Card>
  );
}

function LeverCard({ action, data }: { action: Action; data: ExplainResponse }) {
  const L = useLookups();
  const d = data.lever_detail;
  return (
    <Card title="What this change does" subtitle={`${TYPE_LABEL[action.type]} at ${L.branchName(action.branch_id)}: ${quantityText(action)}`}>
      <dl className="kv-grid">
        <Kv k="Lever">{TYPE_LABEL[action.type]}</Kv>
        <Kv k="Set to">{quantityText(action)}</Kv>
        {action.type === "rate" && <Kv k="Applies to">New local {L.className(action.class_id)} rentals from {L.branchName(action.branch_id)}</Kv>}
        {action.type === "fee" && <Kv k="Applies to">New one-way rentals dropping at {L.branchName(action.branch_id)}</Kv>}
        {action.type === "incentive" && (
          <>
            <Kv k="Applies to">Confirmed one-way returns due at {L.branchName(action.from_branch_id)}</Kv>
            <Kv k="Returns likely to switch">{action.expected_redirects === null ? "—" : `about ${Math.max(1, Math.round(action.expected_redirects))}`}</Kv>
            <Kv k="Estimated payments">{usd(action.cost)}</Kv>
          </>
        )}
        <Kv k="In effect">Days 1 to 14 ({L.date(1)} to {L.date(14)})</Kv>
      </dl>
      {d ? (
        <>
          <div className="subhead">Against the replanned plan without it</div>
          <dl className="kv-grid three">
            <Kv k="Rentals"><Delta value={d.rentals_delta} kind="num" /></Kv>
            <Kv k="Revenue"><Delta value={d.revenue_delta} /></Kv>
            <Kv k="Costs"><span className="plain-delta">{signedUsd(d.cost_delta)}</span></Kv>
          </dl>
          <p className="fine">Averaged over low, base and high demand. Revenue includes fee revenue; costs are variable cost, incentive payments, transport and change costs together.</p>
        </>
      ) : (
        <p className="fine">No lever detail was returned for this action.</p>
      )}
    </Card>
  );
}

function Counterfactual({ data, plan }: { data: ExplainResponse; plan: Action[] }) {
  const diff = diffPlans(plan.filter((a) => a.id !== data.action.id), data.replanned_actions.filter((a) => a.id !== data.action.id));
  const reduction = data.reduction;
  return (
    <Card title="Reduction in plan value after replanning without this action" subtitle="The cost of refusing it, with every other decision kept as it is.">
      <div className="cf-figure">
        <span className={`cf-number ${reduction > 0.5 ? "neg" : reduction < -0.5 ? "pos" : ""}`}>
          {reduction > 0.5 ? `−${usd(reduction).replace("−", "")}` : reduction < -0.5 ? `+${usd(-reduction)}` : usd(0)}
        </span>
        <span className="cf-side">
          <span>Current plan <strong>{usd(data.plan_value)}</strong></span>
          <span>Replanned without it <strong>{usd(data.replanned_value)}</strong></span>
        </span>
      </div>
      {reduction < -0.5 && (
        <p className="note">The plan would be worth more without this action. It is in the plan only because it was approved; undo the approval to let the tool replan.</p>
      )}
      <p className="forbidden">
        <span className="forbidden-label">What was forbidden</span>
        {data.forbidden}
      </p>
      <div className="replan">
        <div className="subhead">What the replanned plan does instead</div>
        {diff.same ? (
          <p>Nothing else changes: the rest of the plan stays as it is.</p>
        ) : (
          <ul className="difflist">
            {diff.added.map((a) => (
              <li key={a.id}><span className="tag tag-add">Added</span><span><ActionName action={a} /></span></li>
            ))}
            {diff.changed.map((c) => (
              <li key={c.after.id}><span className="tag tag-chg">Changed</span><span><ActionName action={c.after} /> <span className="unit">({quantityText(c.before)} → {quantityText(c.after)})</span></span></li>
            ))}
            {diff.removed.map((a) => (
              <li key={a.id}><span className="tag tag-rem">Dropped</span><span><ActionName action={a} /></span></li>
            ))}
          </ul>
        )}
        <div className="fine">Re-solve: <StatusBadge status={data.status} gap={data.gap} short /> · {Math.round(data.solve_ms)} ms</div>
      </div>
      <div className="caveat">
        <div className="caveat-title">What this number is not</div>
        <ul>
          <li>It is not a share of the plan's profit.</li>
          <li>Two actions that only work together will each show the full loss.</li>
          <li>An action with an equally good substitute will show zero.</li>
          <li>The bridge is the only breakdown that sums to the total.</li>
        </ul>
      </div>
    </Card>
  );
}

export function ActionDetail() {
  const { result, selectedActionId, setView, solving, selectBranch, rejected } = useStore();
  const L = useLookups();
  const { approvedIds } = useDecisions();
  const action = actionById(result, selectedActionId);
  const { data, error, loading, retry } = useExplain(action);
  if (!result) return null;

  if (!action) {
    const wasRejected = rejected.find((a) => a.id === selectedActionId);
    return (
      <div className="view">
        <Card title={selectedActionId ? "That action is not in the current plan" : "Choose an action"}>
          <p className="empty-line">
            {wasRejected
              ? `You rejected "${wasRejected.label}". Restore it from the Rejected list to see its detail again.`
              : selectedActionId
                ? "The plan was rebuilt with different inputs or decisions and no longer includes it."
                : "Open an action from the decision list to see its timing, what refusing it would cost, and the branches it affects."}
          </p>
          <button type="button" className="btn" onClick={() => setView("decisions")}>Back to decisions</button>
        </Card>
      </div>
    );
  }

  const cards = data?.affected_scorecards ?? result.scorecards.filter((s) => action.affected_branches.includes(s.branch_id));

  return (
    <div className="view">
      <div className="detail-head">
        <button type="button" className="link back" onClick={() => setView("decisions")}>‹ Decisions</button>
        <div className="detail-title">
          <div>
            <div className="eyebrow">{TYPE_LABEL[action.type]} · {quantityText(action)}</div>
            <h1>{action.label}</h1>
            <p className="why">{action.why}</p>
            <div className="action-chips">
              <span className="chips-label">Affects</span>
              <BranchChips ids={action.affected_branches} />
            </div>
          </div>
          <DecisionButtons action={action} state={approvedIds.has(action.id) || action.decision === "approved" ? "approved" : "pending"} />
        </div>
      </div>

      {loading || solving ? (
        <Card>
          <Spinner label={solving ? "Rebuilding the plan…" : "Working out what refusing this would cost…"} />
          <p className="fine center">The tool replans the two weeks with this action refused and every other decision kept.</p>
        </Card>
      ) : error ? (
        <Card title="The cost of refusing could not be worked out">
          <p>{error.message}</p>
          {error.unreachable && (
            <p>
              Start the backend with <code>{BACKEND_START_COMMAND}</code> (from <code>backend/</code>).
            </p>
          )}
          <button type="button" className="btn" onClick={retry}>Try again</button>
        </Card>
      ) : data ? (
        <div className="grid-2 detail-grid">
          {data.transfer_detail ? <TransferCard t={data.transfer_detail} /> : <LeverCard action={action} data={data} />}
          <Counterfactual data={data} plan={result.plan.actions} />
        </div>
      ) : null}

      <Card title="Affected branches" subtitle="Actual impact of the whole current plan under current rules, beside the adjusted scorecard. Both columns cover every action that touches the branch, not this one alone.">
        <div className="branch-pairs">
          {cards.map((c) => (
            <div className="branch-pair" key={c.branch_id}>
              <div className="pair-head">
                <h3>{L.branch(c.branch_id)?.name ?? c.branch_id}</h3>
                <button type="button" className="link" onClick={() => selectBranch(c.branch_id, true)}>Open in Branches ›</button>
              </div>
              <div className="pair-body">
                <div>
                  <div className="subhead">Actual impact against do nothing</div>
                  <ActualImpact card={c} />
                </div>
                <div>
                  <div className="subhead">Adjusted scorecard <span className="pill">illustrative</span></div>
                  <AdjustedScorecardTable card={c} />
                </div>
              </div>
            </div>
          ))}
        </div>
        <p className="fine">
          The adjusted scorecard protects revenue against the baseline, not utilization. See Branches for what it does not fix.
        </p>
      </Card>
    </div>
  );
}
