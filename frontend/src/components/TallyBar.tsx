import { num, signedUsd, usd } from "../lib/format";
import { tallyOf } from "../lib/tally";
import { useDecisions, useStore } from "../state/store";

/**
 * The running tally: do nothing, what is approved so far, the recommended plan, and the
 * best the tool could do with no refusals. Sticky under the header on every view.
 */
export function TallyBar() {
  const { result, view, setView } = useStore();
  const { counts } = useDecisions();
  if (!result) return null;
  const t = tallyOf(result);
  const best = t.bestGain;
  const approved = t.approvedGain;
  const current = t.currentGain;
  const scale = Math.max(best, current, approved, 1);
  const w = (v: number) => `${Math.max(0, Math.min(100, (v / scale) * 100))}%`;
  const nothingToDo = best < 0.5 && counts.pending + counts.approved + counts.rejected === 0;

  return (
    <div className="tally no-print" role="status" aria-label="Running tally of decisions">
      <div className="tally-main">
        {nothingToDo ? (
          <div className="tally-lead">
            <strong>No intervention recommended.</strong> Leaving the fleet and prices alone earns {usd(t.doNothing)} over 14 days.
          </div>
        ) : (
          <div className="tally-lead">
            Approved so far: <strong className={approved > 0.5 ? "pos" : approved < -0.5 ? "neg" : ""}>{signedUsd(approved)}</strong> of <strong>{signedUsd(best)}</strong> possible
            {t.approvedPenalty > 0.5 && (
              <span className="tally-warn" title="On their own, the approved actions leave confirmed bookings unserved. The penalty is counted here so the approved figure cannot exceed what is possible.">
                {" "}· includes {usd(t.approvedPenalty)} in penalties: the approved actions alone leave {num(t.approvedBroken)} confirmed {Math.abs(t.approvedBroken - 1) < 0.05 ? "booking" : "bookings"} unserved
              </span>
            )}
          </div>
        )}
        <div className="tally-counts">
          <span><b>{counts.approved}</b> approved</span>
          <span><b>{counts.pending}</b> waiting</span>
          <span>
            <b>{counts.rejected}</b> rejected
            {counts.rejected > 0 && counts.approved === 0 && t.decisionsCost > 0.5 && <> (costing {usd(t.decisionsCost)})</>}
          </span>
          {counts.approved > 0 && t.decisionsCost > 0.5 && (
            <span title="Best possible minus the recommended plan: what your rejections, and any approval the plan would now do without, are costing">
              decisions cost <b>{usd(t.decisionsCost)}</b> so far
            </span>
          )}
        </div>
        {view !== "decisions" && counts.pending > 0 && (
          <button type="button" className="btn btn-small" onClick={() => setView("decisions")}>Review decisions</button>
        )}
        {view !== "handoff" && counts.pending === 0 && counts.approved > 0 && (
          <button type="button" className="btn btn-small" onClick={() => setView("handoff")}>Go to hand-off</button>
        )}
      </div>
      {!nothingToDo && (
        <div className="tally-track-row">
          <span className="tally-end">Do nothing <b>{usd(t.doNothing)}</b></span>
          <div className="tally-track" aria-hidden="true">
            <div className="tally-fill tally-current" style={{ width: w(current) }} />
            <div className="tally-fill tally-approved" style={{ width: w(approved) }} />
          </div>
          <span className="tally-end">Best possible <b>{usd(t.best)}</b></span>
          <span className="tally-key">
            <i className="k-approved" />Approved {signedUsd(approved)}
            <span title="What you end up with if you approve everything still waiting, given your decisions so far"><i className="k-current" />If you approve the rest {signedUsd(current)}</span>
          </span>
        </div>
      )}
    </div>
  );
}
