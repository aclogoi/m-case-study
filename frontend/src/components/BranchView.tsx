import { useEffect, useState } from "react";
import { getSuggestedBooking } from "../api/client";
import type { Action, BranchScorecard, ReportedBooking, SolveResponse } from "../api/types";
import { MODE_LABEL, quantityText } from "../lib/actions";
import { diffPlans } from "../lib/diff";
import { signedUsd, usd } from "../lib/format";
import { useDecisions, useLookups, useSoured, useStore, type Lookups } from "../state/store";
import { ActualImpact, AdjustedScorecardTable, CentralAccountNote, DoesNotFix } from "./Scorecards";
import { ActionName, Card, Spinner } from "./ui";

/** One action, phrased from this branch's side, with its dates. */
function ask(a: Action, branchId: string, L: Lookups): { what: string; when: string } {
  const horizon = `In effect ${L.date(1)} to ${L.date(L.scenario.params.horizon_days)}`;
  const n = a.count ?? 0;
  switch (a.type) {
    case "move": {
      const trucks = `${n} ${L.className(a.class_id, n)}`;
      const how = a.mode ? MODE_LABEL[a.mode].toLowerCase() : "move";
      if (a.origin === branchId)
        return {
          what: `Send ${trucks} to ${L.branchName(a.dest)} by ${how}`,
          when: `Leaves ${L.day(a.dispatch_day)}; available at ${L.branchName(a.dest)} from ${L.day(a.arrival_day)}`,
        };
      if (a.dest === branchId)
        return {
          what: `Receive ${trucks} from ${L.branchName(a.origin)} by ${how}`,
          when: `Dispatched ${L.day(a.dispatch_day)}; on your lot from ${L.day(a.arrival_day)}`,
        };
      return { what: a.label, when: `Dispatched ${L.day(a.dispatch_day)}, arrives ${L.day(a.arrival_day)}` };
    }
    case "rate":
      return { what: `HQ sets new local ${L.className(a.class_id)} rentals at ${quantityText(a).replace(" rate", "")} against the base rate`, when: horizon };
    case "fee":
      if (a.branch_id === branchId) return { what: `HQ adds a $${a.fee} drop fee on new one-way rentals returned here`, when: horizon };
      return { what: `A $${a.fee} drop fee at ${L.branchName(a.branch_id)} changes where some one-way rentals from or near this branch end up`, when: horizon };
    case "incentive":
      if (a.branch_id === branchId)
        return { what: `HQ offers $${a.amount} to customers due back at ${L.branchName(a.from_branch_id)} who return here instead`, when: `${horizon}; paid on the day of each redirected return` };
      return { what: `Some returns due here go to ${L.branchName(a.branch_id)} instead, for a $${a.amount} incentive paid by HQ`, when: horizon };
  }
}

function Asks({ card, result }: { card: BranchScorecard; result: SolveResponse }) {
  const L = useLookups();
  const { openAction, rejected } = useStore();
  const { approvedIds } = useDecisions();
  const byId = new Map(result.plan.actions.map((a) => [a.id, a]));
  const actions = card.action_ids.map((id) => byId.get(id)).filter((a): a is Action => !!a);
  const refused = rejected.filter((a) => a.affected_branches.includes(card.branch_id));
  if (actions.length === 0 && refused.length === 0) return <p className="empty-line">The plan asks nothing of this branch. Its fleet, rates, fees and incentives stay as they are.</p>;
  return (
    <ul className="asks">
      {actions.map((a) => {
        const t = ask(a, card.branch_id, L);
        const isApproved = approvedIds.has(a.id) || a.decision === "approved";
        return (
          <li key={a.id}>
            <div className="ask-main">
              <div className="ask-what">{t.what}</div>
              <div className="ask-when">{t.when}</div>
            </div>
            {a.type === "move" && <div className="ask-cost">{usd(a.cost)} <span className="unit">paid by HQ</span></div>}
            <span className={`state ${isApproved ? "state-approved" : "state-pending"}`}>{isApproved ? "✓ Approved" : "Waiting for HQ's decision"}</span>
            <button type="button" className="link" onClick={() => openAction(a.id)}>Why ›</button>
          </li>
        );
      })}
      {refused.map((a) => (
        <li key={a.id} className="ask-refused">
          <div className="ask-main">
            <div className="ask-what">{a.label}</div>
            <div className="ask-when">HQ rejected this, so it will not happen this week.</div>
          </div>
          <span className="state state-rejected">✕ Rejected</span>
        </li>
      ))}
    </ul>
  );
}

function bookingText(b: ReportedBooking, L: Lookups): string {
  const kind = b.dest_branch_id === b.branch_id ? "local" : `one-way to ${L.branchName(b.dest_branch_id)}`;
  return `${b.count} × ${L.className(b.class_id)} from ${L.branchName(b.branch_id)}, ${kind}, starting ${L.day(b.start_day)} for ${b.duration_days} ${b.duration_days === 1 ? "day" : "days"}`;
}

function PlanDiffPanel() {
  const { change, result, solving, valuesFresh, setView } = useStore();
  const { approvedActions } = useDecisions();
  // An approval stays pinned through a re-solve. If the new fact has turned it against
  // the plan, refusing it would now gain money: say so instead of hiding it.
  const soured = useSoured();
  const L = useLookups();
  if (!change || !result || !change.booking || (change.kind !== "booking-added" && change.kind !== "booking-removed")) return null;
  if (solving) return <div className="diff"><Spinner label="Rebuilding the plan with the updated bookings…" /></div>;
  const added = change.kind === "booking-added";
  const d = diffPlans(change.before.plan.actions, result.plan.actions);
  const valueChange = result.decision.current_plan - change.before.decision.current_plan;
  return (
    <div className="diff" role="status">
      <div className="diff-title">What changed in the plan</div>
      <p className="fine">{added ? "Reported" : "Removed"}: {bookingText(change.booking, L)}. The plan was rebuilt with it {added ? "as a commitment" : "taken out"}.</p>
      {d.same ? (
        <p className="diff-same">
          {added ? "The plan did not change: the remaining fleet still covers the booking." : "The plan did not change: it did not depend on that booking."}
          {" "}All {d.unchanged.length} {d.unchanged.length === 1 ? "action is" : "actions are"} unchanged.
        </p>
      ) : (
        <>
          <ul className="difflist">
            {d.added.map((a) => (
              <li key={a.id}><span className="tag tag-add">Added</span><span><ActionName action={a} /><span className="diff-why">{a.why}</span></span></li>
            ))}
            {d.removed.map((a) => (
              <li key={a.id}><span className="tag tag-rem">Removed</span><span><ActionName action={a} /></span></li>
            ))}
            {d.changed.map((c) => (
              <li key={c.after.id}><span className="tag tag-chg">Changed</span><span><ActionName action={c.after} /> <span className="unit">{quantityText(c.before)} → {quantityText(c.after)}</span></span></li>
            ))}
          </ul>
          <p className="fine">{d.unchanged.length} {d.unchanged.length === 1 ? "action" : "actions"} unchanged.</p>
        </>
      )}
      {approvedActions.length > 0 && !valuesFresh && <p className="fine">Checking whether the approved actions still make sense…</p>}
      {soured.length > 0 && (
        <div className="soured">
          <div className="soured-title">
            {soured.length === 1 ? "An approved action no longer makes sense" : `${soured.length} approved actions no longer make sense`}
          </div>
          <ul>
            {soured.map((s) => (
              <li key={s.action.id}>
                <strong>{s.action.label}</strong>: it stays approved, but the plan would now be {usd(s.gain)} better without it.
              </li>
            ))}
          </ul>
          <button type="button" className="btn btn-small" onClick={() => setView("decisions")}>Review in Decisions ›</button>
        </div>
      )}
      <p className="fine">
        Recommended plan: {usd(change.before.decision.current_plan)} → {usd(result.decision.current_plan)} ({signedUsd(valueChange)}). The booking's own revenue is part of that change, with or without the plan.
        {result.plan.broken_commitments.length > 0 && " Some commitments can no longer be covered: see the banner at the top."}
      </p>
    </div>
  );
}

function BookingForm({ branchId }: { branchId: string }) {
  const L = useLookups();
  const { addBooking, addedBookings, removeBooking, solving, caseId } = useStore();
  const s = L.scenario;
  const blank = (): ReportedBooking => ({ branch_id: branchId, class_id: s.classes[0]?.id ?? "box16", start_day: 3, duration_days: s.params.local_duration_days, dest_branch_id: branchId, count: 1 });
  const [form, setForm] = useState<ReportedBooking>(blank);
  const [note, setNote] = useState<string | null>(null);

  useEffect(() => {
    setForm(blank());
    setNote(null);
    // Reset the form when the branch or case changes; origin is always the selected branch.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [branchId, caseId]);

  const set = <K extends keyof ReportedBooking>(k: K, v: ReportedBooking[K]) => setForm((f) => ({ ...f, [k]: v }));
  const days = Array.from({ length: s.params.horizon_days }, (_, i) => i + 1);
  const valid = form.start_day >= 1 && form.start_day <= s.params.horizon_days && form.duration_days >= 1 && form.duration_days <= 7 && form.count >= 1 && form.count <= 10;

  const suggest = () => {
    setNote(null);
    getSuggestedBooking()
      .then((b) => {
        if (b.branch_id !== branchId) {
          setNote(`The suggested example is for ${L.branchName(b.branch_id)}, not this branch.`);
          return;
        }
        setForm(b);
        setNote("Filled in with the suggested example. Submit to rebuild the plan.");
      })
      .catch(() => setNote("The suggested example could not be loaded."));
  };

  return (
    <>
      <form
        className="booking-form"
        onSubmit={(e) => {
          e.preventDefault();
          if (!valid) return;
          addBooking({ ...form, branch_id: branchId });
          setNote(null);
        }}
      >
        <label>
          <span>Origin</span>
          <input value={L.branchName(branchId)} disabled />
        </label>
        <label>
          <span>Class</span>
          <select value={form.class_id} onChange={(e) => set("class_id", e.target.value)}>
            {s.classes.map((c) => (
              <option key={c.id} value={c.id}>{c.name}</option>
            ))}
          </select>
        </label>
        <label>
          <span>Start day</span>
          <select value={form.start_day} onChange={(e) => set("start_day", Number(e.target.value))}>
            {days.map((d) => (
              <option key={d} value={d}>{L.day(d)}</option>
            ))}
          </select>
        </label>
        <label>
          <span>Duration (days)</span>
          <input type="number" min={1} max={7} value={form.duration_days} onChange={(e) => set("duration_days", Number(e.target.value))} />
        </label>
        <label>
          <span>Destination</span>
          <select value={form.dest_branch_id} onChange={(e) => set("dest_branch_id", e.target.value)}>
            {s.branches.map((b) => (
              <option key={b.id} value={b.id}>{b.short_name}{b.id === branchId ? " (local, returns here)" : ""}</option>
            ))}
          </select>
        </label>
        <label>
          <span>Count</span>
          <input type="number" min={1} max={10} value={form.count} onChange={(e) => set("count", Number(e.target.value))} />
        </label>
        <div className="form-actions">
          <button type="submit" className="btn btn-primary" disabled={!valid || solving}>Report booking and rebuild the plan</button>
          {branchId === "HFD" && (
            <button type="button" className="link" onClick={suggest}>Use suggested example</button>
          )}
          {!valid && <span className="form-error">Duration is 1 to 7 days and count 1 to 10.</span>}
          {note && <span className="fine">{note}</span>}
        </div>
      </form>

      {addedBookings.length > 0 && (
        <div className="reported">
          <div className="subhead">Reported bookings in this plan</div>
          <ul>
            {addedBookings.map((b, i) => (
              <li key={`${i}-${b.branch_id}-${b.start_day}`}>
                <span>{bookingText(b, L)}</span>
                <button type="button" className="link danger" onClick={() => removeBooking(i)} disabled={solving}>Remove</button>
              </li>
            ))}
          </ul>
        </div>
      )}
      <PlanDiffPanel />
    </>
  );
}

export function BranchView() {
  const { result, selectedBranchId, selectBranch } = useStore();
  const L = useLookups();
  if (!result) return null;
  const branch = L.branch(selectedBranchId) ?? L.scenario.branches[0];
  const card = result.scorecards.find((c) => c.branch_id === branch?.id);

  return (
    <div className="view">
      <div className="branch-head">
        <div className="seg seg-lg" role="tablist" aria-label="Branch">
          {L.scenario.branches.map((b) => (
            <button key={b.id} type="button" role="tab" aria-selected={b.id === branch?.id} className={b.id === branch?.id ? "on" : ""} onClick={() => selectBranch(b.id)}>
              {b.short_name}
            </button>
          ))}
        </div>
        {branch && (
          <div>
            <h1>{branch.name}</h1>
            <p className="why">{branch.role}</p>
          </div>
        )}
      </div>

      {!card || !branch ? (
        <Card><p className="empty-line">No scorecard was returned for this branch.</p></Card>
      ) : (
        <>
          <Card title="What the recommended plan asks of this branch" subtitle="HQ sets rates, fees and incentives and pays for moves. These are the plan's actions that touch this branch, with their dates and whether HQ has approved them.">
            <Asks card={card} result={result} />
          </Card>

          <div className="grid-2">
            <Card title="Actual impact against do nothing" subtitle="Under current scorecard rules. Nothing is adjusted here: the assigned fleet stays fixed when HQ moves a truck.">
              <ActualImpact card={card} />
              <p className="fine">Rental revenue is booked at the origin branch and drop-fee revenue at the destination. Move, incentive and change costs are HQ costs and sit on no branch.</p>
            </Card>

            <Card title={<>Adjusted scorecard <span className="pill">illustrative hold-harmless policy</span></>} subtitle="One whole-plan credit when revenue falls below the do-nothing baseline, and assigned fleet-days that follow the truck.">
              <AdjustedScorecardTable card={card} />
              <CentralAccountNote central={result.central_account} />
            </Card>
          </div>

          <div className="pushback-head">
            <h2>If {branch.short_name} pushes back</h2>
            <p className="why">There are two kinds of objection, and they are answered in different places. A fact the plan missed changes the plan. Discomfort with the numbers does not.</p>
          </div>
          <div className="grid-2 pushback">
            <Card
              title="“You missed a fact”"
              subtitle="A confirmed booking the forecast omits. Report it: it becomes a commitment, the plan is rebuilt, and the actions that changed are listed. Approved actions stay approved, and are flagged if they no longer make sense."
            >
              <BookingForm branchId={branch.id} />
            </Card>
            <Card title="“I don't like what it does to my numbers”" subtitle="There is nothing to enter here, on purpose.">
              <p className="objection">
                <strong>A scorecard objection has no such input.</strong> Disliking what the plan does to this branch's numbers does not change the plan; it is answered by the two scorecards above:
                what really happens to the branch, and what an adjusted scorecard would credit.
              </p>
              <DoesNotFix />
            </Card>
          </div>
        </>
      )}
    </div>
  );
}
