import { useMemo, useState } from "react";
import type { InventoryRow, SituationTotals } from "../api/types";
import { usd, whole } from "../lib/format";
import { useDecisions, useLookups, useStore, type Lookups } from "../state/store";
import { Card } from "./ui";

/** Do nothing; exactly what is approved so far; or the full recommended plan (approved plus everything still waiting). */
type Mode = "none" | "approved" | "plan";

const unmet = (r: InventoryRow, m: Mode) => r[`unmet_${m}`];
const idle = (r: InventoryRow, m: Mode) => r[`idle_${m}`];
const lostRevenue = (r: InventoryRow, m: Mode) => r[`unmet_revenue_${m}`];

/**
 * Against doing nothing, is this cell better or worse for customers? Only rentals turned
 * away count: nearly every cell's idle count moves under a plan, and marking them all
 * hides the few cells where a branch is newly short.
 */
function shift(r: InventoryRow, m: Mode): "better" | "worse" | null {
  if (m === "none") return null;
  const d = Math.round(unmet(r, m)) - Math.round(r.unmet_none);
  return d < 0 ? "better" : d > 0 ? "worse" : null;
}

/** A cell is "short" when rentals are turned away, else "idle" when trucks are left on the lot. */
function stateOf(r: InventoryRow, m: Mode): { kind: "short" | "idle" | "even"; n: number } {
  const u = Math.round(unmet(r, m));
  if (u >= 1) return { kind: "short", n: u };
  const i = Math.round(idle(r, m));
  if (i >= 1) return { kind: "idle", n: i };
  return { kind: "even", n: 0 };
}

const step = (n: number, max: number) => Math.max(1, Math.min(4, Math.ceil((n / Math.max(max, 1)) * 4)));

interface Hover {
  row: InventoryRow;
  x: number;
  y: number;
}

function Tooltip({ hover }: { hover: Hover }) {
  const L = useLookups();
  const r = hover.row;
  const left = Math.min(hover.x, window.innerWidth - 400);
  return (
    <div className="tip board-tip" style={{ left, top: hover.y }} role="tooltip">
      <div className="tip-title">
        {L.branchName(r.branch_id)} · {L.className(r.class_id, 2)} · {L.date(r.day)}
      </div>
      <table>
        <thead>
          <tr>
            <th />
            <th>If we do nothing</th>
            <th>Approved so far</th>
            <th>Full plan</th>
          </tr>
        </thead>
        <tbody>
          <tr>
            <td>Rentals turned away</td>
            <td>{whole(r.unmet_none)}</td>
            <td>{whole(r.unmet_approved)}</td>
            <td>{whole(r.unmet_plan)}</td>
          </tr>
          <tr>
            <td>Revenue they represent</td>
            <td>{usd(r.unmet_revenue_none)}</td>
            <td>{usd(r.unmet_revenue_approved)}</td>
            <td>{usd(r.unmet_revenue_plan)}</td>
          </tr>
          <tr>
            <td>Trucks sitting idle</td>
            <td>{whole(r.idle_none)}</td>
            <td>{whole(r.idle_approved)}</td>
            <td>{whole(r.idle_plan)}</td>
          </tr>
        </tbody>
      </table>
    </div>
  );
}

function Grid({ classId, rows, mode, maxShort, maxIdle, onHover }: { classId: string; rows: InventoryRow[]; mode: Mode; maxShort: number; maxIdle: number; onHover: (h: Hover | null) => void }) {
  const L = useLookups();
  const { selectBranch } = useStore();
  const days = Array.from({ length: L.scenario.params.horizon_days }, (_, i) => i + 1);
  const byKey = useMemo(() => new Map(rows.map((r) => [`${r.branch_id}:${r.day}`, r])), [rows]);
  const cls = L.vehicleClass(classId);

  return (
    <div className="board-grid" role="table" aria-label={`${cls?.name ?? classId}: branch by day`}>
      <div className="board-row board-head" role="row">
        <div className="board-class" role="columnheader">{cls?.name ?? classId}s</div>
        {days.map((d) => {
          const [wd, dn] = L.date(d).split(" ");
          return (
            <div key={d} className={`board-day ${d === 8 ? "week-start" : ""}`} role="columnheader" title={L.date(d)}>
              <span>{wd}</span>
              <b>{dn}</b>
            </div>
          );
        })}
        <div className="board-total" role="columnheader">14 days</div>
      </div>
      {L.scenario.branches.map((b) => {
        const mine = days.map((d) => byKey.get(`${b.id}:${d}`));
        const away = mine.reduce((s, r) => s + (r ? unmet(r, mode) : 0), 0);
        const idleDays = mine.reduce((s, r) => s + (r ? idle(r, mode) : 0), 0);
        return (
          <div className="board-row" role="row" key={b.id}>
            <button type="button" className="board-branch" role="rowheader" onClick={() => selectBranch(b.id, true)} title={`Open ${b.short_name} in Branches`}>
              {b.short_name}
            </button>
            {mine.map((r, i) => {
              const d = days[i];
              if (!r) return <div key={d} className={`cell cell-even ${d === 8 ? "week-start" : ""}`} role="cell" />;
              const s = stateOf(r, mode);
              const moved = shift(r, mode);
              const before = Math.round(r.unmet_none);
              const level = s.kind === "short" ? step(s.n, maxShort) : s.kind === "idle" ? step(s.n, maxIdle) : 0;
              const label =
                s.kind === "short" ? `${s.n} rentals turned away` : s.kind === "idle" ? `${s.n} trucks sitting idle` : "neither short nor idle";
              return (
                <div
                  key={d}
                  role="cell"
                  tabIndex={0}
                  className={`cell cell-${s.kind} lvl-${level} ${d === 8 ? "week-start" : ""} ${moved ? `is-${moved}` : ""}`}
                  aria-label={`${b.short_name}, ${L.date(d)}: ${label}${moved === "worse" ? `, more turned away than the ${before} if nothing is done` : moved === "better" ? `, fewer turned away than the ${before} if nothing is done` : ""}`}
                  onMouseEnter={(e) => {
                    const box = e.currentTarget.getBoundingClientRect();
                    onHover({ row: r, x: box.left, y: box.bottom + 6 });
                  }}
                  onMouseLeave={() => onHover(null)}
                  onFocus={(e) => {
                    const box = e.currentTarget.getBoundingClientRect();
                    onHover({ row: r, x: box.left, y: box.bottom + 6 });
                  }}
                  onBlur={() => onHover(null)}
                >
                  {s.kind === "short" && (
                    <>
                      <b>{s.n}</b>
                      <span>short</span>
                    </>
                  )}
                  {s.kind === "idle" && <b>{s.n}</b>}
                  {moved && <i className={`shift shift-${moved}`} aria-hidden="true">{moved === "worse" ? "▲" : "▼"}</i>}
                </div>
              );
            })}
            <div className="board-total" role="cell">
              {Math.round(away) >= 1 && <span className="t-short">{whole(away)} turned away</span>}
              {Math.round(idleDays) >= 1 && <span className="t-idle">{whole(idleDays)} idle truck-days</span>}
              {Math.round(away) < 1 && Math.round(idleDays) < 1 && <span className="muted">in balance</span>}
            </div>
          </div>
        );
      })}
    </div>
  );
}

/** "Wed 25 Nov to Fri 27 Nov" for the days a branch is short. */
function span(days: number[], L: Lookups): string {
  if (days.length === 0) return "spread thinly across the two weeks";
  const first = Math.min(...days);
  const last = Math.max(...days);
  return first === last ? `on ${L.date(first)}` : `between ${L.date(first)} and ${L.date(last)}`;
}

function standouts(rows: InventoryRow[], mode: Mode, L: Lookups) {
  const groups = new Map<string, InventoryRow[]>();
  for (const r of rows) {
    const k = `${r.branch_id}|${r.class_id}`;
    groups.set(k, [...(groups.get(k) ?? []), r]);
  }
  const short: { text: string; n: number }[] = [];
  const idleList: { text: string; n: number }[] = [];
  for (const [k, list] of groups) {
    const [b, c] = k.split("|");
    const away = list.reduce((s, r) => s + unmet(r, mode), 0);
    const lost = list.reduce((s, r) => s + lostRevenue(r, mode), 0);
    const idleDays = list.reduce((s, r) => s + idle(r, mode), 0);
    if (Math.round(away) >= 1) {
      const days = list.filter((r) => unmet(r, mode) >= 0.5).map((r) => r.day);
      const more = Math.round(away) - Math.round(list.reduce((s, r) => s + r.unmet_none, 0));
      short.push({
        n: away,
        text: `${L.branchName(b)} turns away about ${whole(away)} ${L.className(c)} ${Math.round(away) === 1 ? "rental" : "rentals"} ${span(days, L)}, worth ${usd(lost)}.${mode !== "none" && more > 0 ? ` That is ${more} more than if nothing is done: trucks or returns it would have used go elsewhere.` : ""}`,
      });
    }
    if (Math.round(idleDays) >= 1) {
      const daysIdle = list.filter((r) => idle(r, mode) >= 0.5).length;
      const peak = Math.max(...list.map((r) => idle(r, mode)));
      idleList.push({
        n: idleDays,
        text: `${L.branchName(b)} has ${L.className(c, 2)} sitting idle on ${daysIdle === list.length ? "every day" : `${daysIdle} of ${list.length} days`}: ${whole(idleDays)} truck-days, up to ${whole(peak)} at once.`,
      });
    }
  }
  const top = (xs: { text: string; n: number }[]) => xs.sort((a, b) => b.n - a.n).slice(0, 3);
  return { short: top(short), idle: top(idleList) };
}

function Stat({ value, label, was, lowerIsBetter = true }: { value: string; label: string; was?: { text: string; delta: number }; lowerIsBetter?: boolean }) {
  const good = was ? (lowerIsBetter ? was.delta < 0 : was.delta > 0) : false;
  return (
    <div className="stat">
      <div className="stat-value">{value}</div>
      <div className="stat-label">{label}</div>
      {/* The line is always there, so the page does not jump when the view is switched. */}
      <div className={`stat-was ${!was || Math.abs(was.delta) < 0.5 ? "" : good ? "pos" : "neg"}`}>{was ? was.text : "the starting point"}</div>
    </div>
  );
}

export function SituationBoard() {
  const { result, setView } = useStore();
  const L = useLookups();
  const { counts, actions } = useDecisions();
  const [mode, setMode] = useState<Mode>("none");
  const [hover, setHover] = useState<Hover | null>(null);
  const inventory = result?.inventory ?? [];

  const { maxShort, maxIdle } = useMemo(() => {
    // One scale for both views, so switching the toggle compares like with like.
    let s = 1;
    let i = 1;
    for (const r of inventory) {
      s = Math.max(s, r.unmet_none, r.unmet_plan);
      i = Math.max(i, r.idle_none, r.idle_plan);
    }
    return { maxShort: s, maxIdle: i };
  }, [inventory]);

  if (!result) return null;
  const t: SituationTotals = mode === "none" ? result.situation.do_nothing : mode === "approved" ? result.situation.approved : result.situation.plan;
  const compared = mode !== "none";
  const base = result.situation.do_nothing;
  const days = result.params.horizon_days;
  const out = standouts(inventory, mode, L);
  const change = (now: number, then: number, unit: (n: number) => string) => {
    const d = now - then;
    return { delta: d, text: Math.abs(d) < 0.5 ? "same as doing nothing" : `${d < 0 ? "down" : "up"} ${unit(Math.abs(d))} from doing nothing` };
  };
  const hasPlan = actions.length > 0;

  return (
    <div className="view">
      <div className="board-top">
        <div>
          <h1>{mode === "none" ? `If nothing is done over the next ${days} days` : mode === "approved" ? "With what is approved so far" : "With the full recommended plan"}</h1>
          <p className="why">
            {mode === "none"
              ? "Where the fleet is in the wrong place: branches turning rentals away while others have trucks sitting on the lot."
              : mode === "approved"
                ? counts.approved > 0
                  ? `Only the ${counts.approved} ${counts.approved === 1 ? "action" : "actions"} you have approved, and nothing else. ${counts.pending} ${counts.pending === 1 ? "recommendation is" : "recommendations are"} still waiting and not counted here.`
                  : "Nothing is approved yet, so this is the same as doing nothing."
              : hasPlan
                ? `What the ${actions.length} recommended ${actions.length === 1 ? "action fixes" : "actions fix"}, and what ${actions.length === 1 ? "it leaves" : "they leave"}. ${counts.approved} approved, ${counts.pending} still waiting${counts.pending > 0 ? ": this assumes you approve the rest" : ""}.`
                : "The tool recommends no action on these inputs, so the plan is the same as doing nothing."}
          </p>
        </div>
        <div className="seg seg-lg" role="group" aria-label="Which situation to show">
          <button type="button" className={mode === "none" ? "on" : ""} aria-pressed={mode === "none"} onClick={() => setMode("none")}>If we do nothing</button>
          <button type="button" className={mode === "approved" ? "on" : ""} aria-pressed={mode === "approved"} onClick={() => setMode("approved")} title="Exactly the actions you have approved, and nothing else">Approved so far</button>
          <button type="button" className={mode === "plan" ? "on" : ""} aria-pressed={mode === "plan"} onClick={() => setMode("plan")} title="What you have approved plus everything the tool still recommends">Full recommended plan</button>
        </div>
      </div>

      <div className="board-stats">
        <Stat value={whole(t.unserved_rentals)} label="rentals turned away" was={compared ? change(t.unserved_rentals, base.unserved_rentals, whole) : undefined} />
        <Stat value={usd(t.unserved_revenue)} label="rental revenue those rentals would bring in" was={compared ? change(t.unserved_revenue, base.unserved_revenue, usd) : undefined} />
        <Stat value={whole(t.idle_truck_days)} label="truck-days sitting idle" was={compared ? change(t.idle_truck_days, base.idle_truck_days, whole) : undefined} />
        <div className="stat stat-cta">
          {counts.pending > 0 ? (
            <>
              <div className="stat-value">{counts.pending}</div>
              <div className="stat-label">{counts.pending === 1 ? "recommendation" : "recommendations"} waiting for your decision</div>
              <button type="button" className="btn btn-primary" onClick={() => setView("decisions")}>Review decisions ›</button>
            </>
          ) : counts.approved > 0 ? (
            <>
              <div className="stat-value">{counts.approved}</div>
              <div className="stat-label">approved, nothing left to decide</div>
              <button type="button" className="btn btn-primary" onClick={() => setView("handoff")}>Go to hand-off ›</button>
            </>
          ) : (
            <>
              <div className="stat-value">0</div>
              <div className="stat-label">recommendations: the tool advises leaving the fleet and prices as they are</div>
              <button type="button" className="btn" onClick={() => setView("decisions")}>See why ›</button>
            </>
          )}
        </div>
      </div>

      <Card
        title="Every branch, every day"
        subtitle="Each cell is one branch on one day. Hover or tab to a cell for the figures in both situations; click a branch name for its view."
        aside={
          <div className="legend board-legend">
            <span><i className="cell-short lvl-3" />“3 short” = rentals turned away</span>
            <span><i className="cell-idle lvl-3" />number = trucks sitting idle</span>
            {compared && <span><i className="shift shift-better">▼</i>fewer turned away</span>}
            {compared && <span><i className="shift shift-worse">▲</i>more turned away than doing nothing</span>}
          </div>
        }
      >
        <div className="board">
          {L.scenario.classes.map((c) => (
            <Grid key={c.id} classId={c.id} rows={inventory.filter((r) => r.class_id === c.id)} mode={mode} maxShort={maxShort} maxIdle={maxIdle} onHover={setHover} />
          ))}
        </div>
        <p className="fine">Darker means more. Figures are averaged over low, base and high demand and rounded to whole trucks and rentals, so the rows can differ by one from the totals above.</p>
      </Card>

      <div className="grid-2">
        <Card title={mode === "none" ? "Where rentals are being turned away" : mode === "approved" ? "Shortages left with what is approved" : "Shortages the plan leaves"}>
          {out.short.length === 0 ? (
            <p className="empty-line">No branch turns rentals away{mode === "plan" ? " under the recommended plan" : mode === "approved" ? " with what is approved" : ""}.</p>
          ) : (
            <ul className="plain-list">
              {out.short.map((s) => (
                <li key={s.text}>{s.text}</li>
              ))}
            </ul>
          )}
        </Card>
        <Card title={mode === "none" ? "Where trucks are sitting idle" : mode === "approved" ? "Idle trucks left with what is approved" : "Idle trucks the plan leaves"}>
          {out.idle.length === 0 ? (
            <p className="empty-line">No trucks are left sitting idle.</p>
          ) : (
            <ul className="plain-list">
              {out.idle.map((s) => (
                <li key={s.text}>{s.text}</li>
              ))}
            </ul>
          )}
          {mode === "plan" && out.idle.length > 0 && (
            <p className="note">
              The plan does not clear every idle truck. Nothing is valued after day {days}, so a move that would only pay for itself later is not made. The tool is meant to be re-run each week, when those trucks are looked at again.
            </p>
          )}
        </Card>
      </div>
      {hover && <Tooltip hover={hover} />}
    </div>
  );
}
