import type { Action } from "../api/types";
import { costParts, quantityText, refusalEffect } from "../lib/actions";
import { diffPlans } from "../lib/diff";
import { usd } from "../lib/format";
import { tallyOf } from "../lib/tally";
import { useDecisions, useLookups, useStore } from "../state/store";
import { ActionName, BranchChips, Card } from "./ui";

export type CardState = "pending" | "approved" | "rejected" | "missing";

/** "Cost of refusing": plan value lost if the action is refused, after the tool replans around it. */
export function RefuseCost({ id, approved }: { id: string; approved?: boolean }) {
  const { values, valuesFresh, valuesError } = useStore();
  const v = values[id];
  if (!v) {
    if (valuesError) return <div className="figure-value muted" title={valuesError}>not available</div>;
    return <div className="skeleton" aria-label="Working out the cost of refusing" />;
  }
  const r = v.reduction;
  return (
    <div className={valuesFresh ? "" : "is-refreshing"}>
      {r > 0.5 ? (
        <>
          <div className="figure-value">{usd(r)}</div>
          <div className="figure-note">lost if refused, after the tool replans</div>
        </>
      ) : r < -0.5 ? (
        <>
          <div className="figure-value neg">{usd(0)}</div>
          <div className="figure-note warn-text">
            {approved ? `this approval now costs ${usd(-r)}: the plan is better without it` : `the plan would be ${usd(-r)} better without it`}
          </div>
        </>
      ) : (
        <>
          <div className="figure-value">{usd(0)}</div>
          <div className="figure-note">the tool has an equally good alternative</div>
        </>
      )}
    </div>
  );
}

/** How many approved moves share this move's lane and class (not counting the move itself). */
function useApprovedOnLane(action: Action): number {
  const { approvedActions, missing } = useDecisions();
  if (action.type !== "move") return 0;
  return [...approvedActions, ...missing].filter(
    (a) => a.type === "move" && a.id !== action.id && a.origin === action.origin && a.dest === action.dest && a.class_id === action.class_id,
  ).length;
}

/** Approve / Reject, or Undo / Restore, for one action. Used on cards and in the detail view. */
export function DecisionButtons({ action, state }: { action: Action; state: CardState }) {
  const { approve, undoApprove, reject, restore, solving } = useStore();
  const L = useLookups();
  const onLane = useApprovedOnLane(action);
  if (state === "approved" || state === "missing") {
    return (
      <div className="decide">
        <span className="state state-approved">✓ Approved</span>
        <button type="button" className="btn btn-small" onClick={() => undoApprove(action.id)} disabled={solving} aria-label={`Undo approval: ${action.label}`}>Undo</button>
      </div>
    );
  }
  if (state === "rejected") {
    return (
      <div className="decide">
        <span className="state state-rejected">✕ Rejected</span>
        <button type="button" className="btn btn-small" onClick={() => restore(action.id)} disabled={solving} aria-label={`Restore: ${action.label}`}>Restore</button>
      </div>
    );
  }
  return (
    <div className="decide">
      <button type="button" className="btn btn-primary" onClick={() => approve([action])} disabled={solving} aria-label={`Approve: ${action.label}`}>Approve</button>
      <button type="button" className="btn btn-reject" onClick={() => reject(action)} disabled={solving} aria-label={`Reject: ${action.label}`} title={refusalEffect(action, L.branchName, L.className, onLane)}>Reject</button>
    </div>
  );
}

function DecisionCard({ action, state }: { action: Action; state: CardState }) {
  const { result, openAction } = useStore();
  const L = useLookups();
  const onLane = useApprovedOnLane(action);
  const cost = costParts(action, result?.params.change_cost ?? 0);
  const isMove = action.type === "move";
  return (
    <article className={`dcard dcard-${state}`}>
      <div className="dcard-main">
        <h3>{action.label}</h3>
        {isMove && (
          <div className="dcard-when">
            Leaves {L.longDate(action.dispatch_day ?? 1)} · on the lot at {L.branchName(action.dest)} from {L.longDate(action.arrival_day ?? 1)} · {action.mode === "hauler" ? "hauler" : "staff drive"}
          </div>
        )}
        <p className="dcard-why">{action.why}</p>
        {state === "rejected" && <p className="fine">{refusalEffect(action, L.branchName, L.className, onLane).replace(/^Rejecting/, "Rejecting this")}</p>}
        {state === "missing" && (
          <p className="note">You approved this, but the latest plan did not return it. It is kept as approved here; undo it if it no longer applies.</p>
        )}
        <div className="action-chips">
          <span className="chips-label">Affects</span>
          <BranchChips ids={action.affected_branches} />
        </div>
      </div>
      <div className="dcard-figures">
        <div className="figure">
          <div className="figure-label">Cost</div>
          <div className="figure-value">{usd(cost.total)}</div>
          <div className="figure-note">{cost.note}</div>
        </div>
        <div className="figure">
          <div className="figure-label">Cost of refusing</div>
          {state === "rejected" || state === "missing" ? (
            <>
              <div className="figure-value muted">—</div>
              <div className="figure-note">{state === "rejected" ? "already refused; see the tally" : "not in the latest plan"}</div>
            </>
          ) : (
            <RefuseCost id={action.id} approved={state === "approved"} />
          )}
        </div>
      </div>
      <div className="dcard-actions">
        <DecisionButtons action={action} state={state} />
        {state !== "rejected" && state !== "missing" && (
          <button type="button" className="link" onClick={() => openAction(action.id)} aria-label={`Full detail: ${action.label}`}>Full detail ›</button>
        )}
      </div>
    </article>
  );
}

/** After a rejection or a restore: what it cost and how the plan changed around it. */
function ChangeNotice() {
  const { change, result, solving, restore, dismissChange, rejected } = useStore();
  if (!change || !result || !change.action || (change.kind !== "rejected" && change.kind !== "restored")) return null;
  const a = change.action;
  if (solving) return null;
  const cost = change.before.decision.current_plan - result.decision.current_plan;
  const d = diffPlans(
    change.before.plan.actions.filter((x) => x.id !== a.id),
    result.plan.actions.filter((x) => x.id !== a.id),
  );
  const isReject = change.kind === "rejected";
  return (
    <div className={`notice ${isReject ? "notice-reject" : "notice-restore"}`} role="status">
      <div className="notice-head">
        <div>
          <div className="notice-title">
            {isReject ? "Rejected" : "Restored"}: {a.label}
          </div>
          <p>
            {isReject
              ? cost > 0.5
                ? `Refusing it costs ${usd(cost)} over the 14 days: the current plan is now worth ${usd(result.decision.current_plan)}, down from ${usd(change.before.decision.current_plan)}.`
                : cost < -0.5
                  ? `Refusing it leaves the plan ${usd(-cost)} better off: ${usd(result.decision.current_plan)}, up from ${usd(change.before.decision.current_plan)}.`
                  : `Refusing it costs nothing: the tool found an equally good plan without it (${usd(result.decision.current_plan)}).`
              : `It is back in play. The current plan is now worth ${usd(result.decision.current_plan)} (${cost < -0.5 ? `up ${usd(-cost)}` : cost > 0.5 ? `down ${usd(cost)}` : "unchanged"}).`}
          </p>
        </div>
        <div className="notice-buttons">
          {isReject && rejected.some((x) => x.id === a.id) && (
            <button type="button" className="btn btn-small" onClick={() => restore(a.id)}>Restore it</button>
          )}
          <button type="button" className="link" onClick={dismissChange}>Dismiss</button>
        </div>
      </div>
      <div className="subhead">How the plan changed around it</div>
      {d.same ? (
        <p>No other recommendation changed.</p>
      ) : (
        <ul className="difflist">
          {d.added.map((x) => (
            <li key={x.id}><span className="tag tag-add">New</span><span><ActionName action={x} /><span className="diff-why">{x.why}</span></span></li>
          ))}
          {d.changed.map((c) => (
            <li key={c.after.id}><span className="tag tag-chg">Changed</span><span><ActionName action={c.after} /> <span className="unit">{quantityText(c.before)} → {quantityText(c.after)}</span></span></li>
          ))}
          {d.removed.map((x) => (
            <li key={x.id}><span className="tag tag-rem">Dropped</span><span><ActionName action={x} /></span></li>
          ))}
        </ul>
      )}
    </div>
  );
}

export function DecisionQueue() {
  const { result, rejected, approve, solving, setView, setEvidenceOpen } = useStore();
  const L = useLookups();
  const { actions, approvedIds, pendingActions, missing, counts } = useDecisions();
  if (!result) return null;

  const stateOf = (a: Action): CardState => (approvedIds.has(a.id) || a.decision === "approved" ? "approved" : "pending");
  const moves = actions.filter((a) => a.type === "move");
  const pricing = actions.filter((a) => a.type !== "move");
  const dispatchDays = [...new Set(moves.map((a) => a.dispatch_day ?? 1))].sort((a, b) => a - b);
  const nothing = actions.length === 0 && rejected.length === 0 && missing.length === 0;
  const waiting = (list: Action[]) => list.filter((a) => stateOf(a) === "pending").length;
  const groupNote = (list: Action[]) => {
    const w = waiting(list);
    return w === 0 ? "all decided" : `${w} waiting`;
  };

  return (
    <div className="view">
      <div className="queue-head">
        <div>
          <h1>Decisions</h1>
          <p className="why">
            What the tool recommends, in the order the decisions fall due: pricing changes take effect today, then moves by dispatch day. Each card shows what the action costs to carry out and what refusing it would cost.
            The plan is rebuilt after every approval or rejection, so the remaining recommendations can change.
          </p>
        </div>
        {pendingActions.length > 0 && (
          <button type="button" className="btn" onClick={() => approve(pendingActions)} disabled={solving}>
            Approve all remaining ({pendingActions.length})
          </button>
        )}
      </div>

      <ChangeNotice />

      {nothing && (
        <Card>
          <div className="empty">
            <div className="empty-title">The tool recommends no intervention.</div>
            <p>
              On these inputs every move, rate change, fee and incentive costs more than it brings in, so the best plan found is to leave the fleet and prices as they are
              ({usd(result.decision.do_nothing)} over 14 days). There is nothing to approve.
            </p>
            <button type="button" className="link" onClick={() => setEvidenceOpen(true)}>See the evidence ›</button>
          </div>
        </Card>
      )}

      {!nothing && (
        <p className="queue-legend">
          <strong>Cost of refusing</strong> is the plan value lost if you reject that action, after the tool replans around it. It is not a share of the plan's profit: two actions that only work
          together each show the full loss, and an action with an equally good alternative shows $0.
        </p>
      )}

      {pricing.length > 0 && (
        <section className="queue-group">
          <header>
            <h2>Pricing changes — effective today, {L.longDate(1)}</h2>
            <span className="group-note">{pricing.length} {pricing.length === 1 ? "change" : "changes"} · {groupNote(pricing)}</span>
          </header>
          {pricing.map((a) => (
            <DecisionCard key={a.id} action={a} state={stateOf(a)} />
          ))}
        </section>
      )}

      {dispatchDays.map((day) => {
        const list = moves.filter((a) => (a.dispatch_day ?? 1) === day);
        return (
          <section className="queue-group" key={day}>
            <header>
              <h2>Dispatch {day === 1 ? "today, " : ""}{L.longDate(day)}</h2>
              <span className="group-note">{list.length} {list.length === 1 ? "move" : "moves"} · {groupNote(list)}</span>
            </header>
            {list.map((a) => (
              <DecisionCard key={a.id} action={a} state={stateOf(a)} />
            ))}
          </section>
        );
      })}

      {missing.length > 0 && (
        <section className="queue-group">
          <header>
            <h2>Approved, but not in the latest plan</h2>
            <span className="group-note">{missing.length} to check</span>
          </header>
          {missing.map((a) => (
            <DecisionCard key={a.id} action={a} state="missing" />
          ))}
        </section>
      )}

      {rejected.length > 0 && (
        <section className="queue-group">
          <header>
            <h2>Rejected</h2>
            <span className="group-note">
              {rejected.length} rejected
              {tallyOf(result).decisionsCost > 0.5 ? ` · the current plan is ${usd(tallyOf(result).decisionsCost)} below the best possible` : ""}
            </span>
          </header>
          {rejected.map((a) => (
            <DecisionCard key={a.id} action={a} state="rejected" />
          ))}
        </section>
      )}

      {!nothing && counts.pending === 0 && counts.approved > 0 && (
        <div className="queue-done">
          <span>Everything is decided: {counts.approved} approved, {counts.rejected} rejected.</span>
          <button type="button" className="btn btn-primary" onClick={() => setView("handoff")}>Go to hand-off ›</button>
        </div>
      )}
    </div>
  );
}
