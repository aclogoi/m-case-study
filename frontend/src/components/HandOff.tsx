import { useState } from "react";
import type { Action } from "../api/types";
import { MODE_LABEL } from "../lib/actions";
import { num, signedPct, signedUsd, usd } from "../lib/format";
import { tallyOf } from "../lib/tally";
import { useDecisions, useLookups, useSoured, useStore, type Lookups } from "../state/store";
import { useChangedAssumptions } from "./AssumptionsPanel";
import { Card } from "./ui";

function pricingRow(a: Action, L: Lookups): { branch: string; appliesTo: string; change: string } {
  const branch = L.branchName(a.branch_id);
  switch (a.type) {
    case "rate":
      return { branch, appliesTo: `New local ${L.className(a.class_id)} rentals`, change: `Daily rate ${signedPct(a.tier_pct ?? 0)}` };
    case "fee":
      return { branch, appliesTo: "New one-way rentals dropped here", change: `Drop fee +$${a.fee ?? 0}` };
    case "incentive":
      return { branch, appliesTo: `Confirmed returns due at ${L.branchName(a.from_branch_id)}`, change: `$${a.amount ?? 0} paid to return here instead` };
    default:
      return { branch, appliesTo: "", change: a.label };
  }
}

interface Sheet {
  byOrigin: { origin: string; moves: Action[] }[];
  pricing: Action[];
  transport: number;
  incentives: number;
  changeCosts: number;
  trucks: number;
}

function buildSheet(approved: Action[], changeCost: number, branchOrder: string[]): Sheet {
  const moves = approved.filter((a) => a.type === "move").sort((a, b) => (a.dispatch_day ?? 0) - (b.dispatch_day ?? 0));
  const pricing = approved.filter((a) => a.type !== "move");
  const origins = [...new Set(moves.map((a) => a.origin ?? ""))].sort((a, b) => branchOrder.indexOf(a) - branchOrder.indexOf(b));
  return {
    byOrigin: origins.map((origin) => ({ origin, moves: moves.filter((a) => a.origin === origin) })),
    pricing,
    transport: moves.reduce((s, a) => s + a.cost, 0),
    incentives: pricing.filter((a) => a.type === "incentive").reduce((s, a) => s + a.cost, 0),
    changeCosts: pricing.length * changeCost,
    trucks: moves.reduce((s, a) => s + (a.count ?? 0), 0),
  };
}

function asText(sheet: Sheet, L: Lookups, gain: number, pendingCount: number, warning: string | null, changed: string[]): string {
  const lines: string[] = [];
  const year = L.scenario.start_date.slice(0, 4);
  lines.push("FLEET PLAN: APPROVED ACTIONS");
  lines.push(`Two weeks from ${L.longDate(1)} ${year}`);
  lines.push("");
  lines.push(`DISPATCH SHEET (${sheet.trucks} ${sheet.trucks === 1 ? "truck" : "trucks"})`);
  if (sheet.byOrigin.length === 0) lines.push("  No moves approved.");
  for (const g of sheet.byOrigin) {
    lines.push(`From ${L.branch(g.origin)?.name ?? g.origin}`);
    for (const a of g.moves) {
      const n = a.count ?? 0;
      lines.push(
        `  ${L.longDate(a.dispatch_day ?? 1)}: ${n} ${L.className(a.class_id, n)} to ${L.branchName(a.dest)} by ${a.mode ? MODE_LABEL[a.mode].toLowerCase() : "move"}; on the lot ${L.longDate(a.arrival_day ?? 1)}; ${usd(a.cost)}`,
      );
    }
  }
  lines.push("");
  lines.push(`PRICING CHANGES (effective ${L.longDate(1)})`);
  if (sheet.pricing.length === 0) lines.push("  No pricing changes approved.");
  for (const a of sheet.pricing) {
    const r = pricingRow(a, L);
    lines.push(`  ${r.branch}: ${r.appliesTo}: ${r.change}`);
  }
  lines.push("");
  lines.push("TOTALS");
  lines.push(`  Transport spend: ${usd(sheet.transport)}`);
  if (sheet.incentives > 0.5) lines.push(`  Return incentive payments (estimate): ${usd(sheet.incentives)}`);
  if (sheet.changeCosts > 0.5) lines.push(`  Change costs: ${usd(sheet.changeCosts)}`);
  lines.push(`  Gain against doing nothing, 14 days: ${signedUsd(gain)}`);
  if (warning) lines.push(`  Warning: ${warning}`);
  if (changed.length > 0) lines.push(`  Note: worked out with changed assumptions (${changed.join(", ")}), not the defaults.`);
  if (pendingCount > 0) lines.push(`  Note: ${pendingCount} ${pendingCount === 1 ? "recommendation is" : "recommendations are"} still undecided and not on this sheet.`);
  return lines.join("\n");
}

async function copy(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    // Clipboard API unavailable (insecure context or permission): fall back to a selection copy.
    const ta = document.createElement("textarea");
    ta.value = text;
    ta.style.position = "fixed";
    ta.style.opacity = "0";
    document.body.appendChild(ta);
    ta.select();
    let ok = false;
    try {
      ok = document.execCommand("copy");
    } catch {
      ok = false;
    }
    ta.remove();
    return ok;
  }
}

/** The approved set only, laid out to send on: a dispatch sheet and a pricing-change list. */
export function HandOff() {
  const { result, setView, solving } = useStore();
  const L = useLookups();
  const { approvedActions, missing, counts } = useDecisions();
  const soured = useSoured();
  const changed = useChangedAssumptions();
  const [copied, setCopied] = useState<"yes" | "failed" | null>(null);
  if (!result) return null;

  const approved = [...approvedActions, ...missing];
  const sheet = buildSheet(approved, result.params.change_cost, L.scenario.branches.map((b) => b.id));
  const tally = tallyOf(result);
  const gain = tally.approvedGain;
  const stranded = tally.approvedPenalty > 0.5;
  const strandedText = `On their own, the approved actions leave ${num(tally.approvedBroken)} confirmed ${Math.abs(tally.approvedBroken - 1) < 0.05 ? "booking" : "bookings"} unserved. The gain includes the ${usd(tally.approvedPenalty)} penalty.`;
  const year = L.scenario.start_date.slice(0, 4);

  if (approved.length === 0) {
    return (
      <div className="view">
        <Card>
          <div className="empty">
            <div className="empty-title">Nothing is approved yet.</div>
            <p>
              The hand-off sheet lists only what you have approved: moves for the branches to dispatch and pricing changes for revenue management.
              {counts.pending > 0 ? ` ${counts.pending} ${counts.pending === 1 ? "recommendation is" : "recommendations are"} waiting for a decision.` : " The tool has no recommendations on these inputs."}
            </p>
            {counts.pending > 0 && (
              <button type="button" className="btn btn-primary" onClick={() => setView("decisions")}>Review decisions ›</button>
            )}
          </div>
        </Card>
      </div>
    );
  }

  return (
    <div className="view handoff">
      <div className="queue-head">
        <div>
          <h1>Fleet plan: approved actions</h1>
          <p className="why">
            Two weeks from {L.longDate(1)} {year}. {approved.length} approved {approved.length === 1 ? "action" : "actions"}: only what has been approved is on this sheet.
          </p>
        </div>
        <div className="handoff-buttons no-print">
          <button
            type="button"
            className="btn"
            onClick={async () => {
              const ok = await copy(asText(sheet, L, gain, counts.pending, stranded ? strandedText : null, changed));
              setCopied(ok ? "yes" : "failed");
              window.setTimeout(() => setCopied(null), 2500);
            }}
          >
            {copied === "yes" ? "Copied ✓" : copied === "failed" ? "Copy failed" : "Copy as text"}
          </button>
          <button type="button" className="btn" onClick={() => window.print()}>Print</button>
        </div>
      </div>

      {/* Printed too: whoever receives the sheet should know the figures are not on the default assumptions. */}
      {changed.length > 0 && (
        <p className="note">
          This sheet was worked out with changed assumptions ({changed.join(", ")}), not the defaults. Reset the sliders under “Why trust this?” before sending if that was only a what-if.
        </p>
      )}
      {counts.pending > 0 && (
        <p className="note no-print">
          {counts.pending} {counts.pending === 1 ? "recommendation is" : "recommendations are"} still undecided and not on this sheet.{" "}
          <button type="button" className="link" onClick={() => setView("decisions")}>Review decisions ›</button>
        </p>
      )}
      {soured.length > 0 && (
        <p className="note no-print">
          {soured.length === 1 ? "One approved action now works" : `${soured.length} approved actions now work`} against the plan ({soured.map((s) => s.action.label).join("; ")}).{" "}
          <button type="button" className="link" onClick={() => setView("decisions")}>Review before sending ›</button>
        </p>
      )}
      {stranded && result.plan.broken_commitments.length === 0 && (
        <p className="note">
          {strandedText}
          {counts.pending > 0 && (
            <>
              {" "}A recommendation still waiting would serve {Math.abs(tally.approvedBroken - 1) < 0.05 ? "it" : "them"}.{" "}
              <button type="button" className="link no-print" onClick={() => setView("decisions")}>Review before sending ›</button>
            </>
          )}
        </p>
      )}
      {result.plan.broken_commitments.length > 0 && (
        <p className="note">A confirmed booking cannot be served under these decisions. Resolve it before sending this sheet.</p>
      )}

      <div className={`handoff-totals ${solving ? "is-refreshing" : ""}`}>
        <div className="stat">
          <div className="stat-value">{signedUsd(gain)}</div>
          <div className="stat-label">gain of the approved set against doing nothing, 14 days</div>
        </div>
        <div className="stat">
          <div className="stat-value">{usd(sheet.transport)}</div>
          <div className="stat-label">transport spend, {sheet.trucks} {sheet.trucks === 1 ? "truck" : "trucks"} moved</div>
        </div>
        <div className="stat">
          <div className="stat-value">{usd(sheet.incentives + sheet.changeCosts)}</div>
          <div className="stat-label">
            pricing costs{sheet.incentives > 0.5 ? `: about ${usd(sheet.incentives)} in incentive payments and ${usd(sheet.changeCosts)} in change costs` : `: change costs for ${sheet.pricing.length} ${sheet.pricing.length === 1 ? "change" : "changes"}`}
          </div>
        </div>
      </div>

      <Card title="Dispatch sheet" subtitle="For branch operations. Grouped by the branch the trucks leave from, in date order.">
        {sheet.byOrigin.length === 0 ? (
          <p className="empty-line">No moves are approved.</p>
        ) : (
          sheet.byOrigin.map((g) => (
            <div className="sheet-group" key={g.origin}>
              <h3>From {L.branch(g.origin)?.name ?? g.origin}</h3>
              <table className="tbl compact sheet">
                <thead>
                  <tr>
                    <th>Leaves</th>
                    <th className="r">Trucks</th>
                    <th>Class</th>
                    <th>To</th>
                    <th>Mode</th>
                    <th>On the lot there</th>
                    <th className="r">Cost</th>
                  </tr>
                </thead>
                <tbody>
                  {g.moves.map((a) => (
                    <tr key={a.id}>
                      <td>{L.longDate(a.dispatch_day ?? 1)}</td>
                      <td className="r n">{a.count}</td>
                      <td>{L.vehicleClass(a.class_id)?.name ?? a.class_id}</td>
                      <td>{L.branch(a.dest)?.name ?? a.dest}</td>
                      <td>{a.mode ? MODE_LABEL[a.mode] : "—"}</td>
                      <td>{L.longDate(a.arrival_day ?? 1)}</td>
                      <td className="r n">{usd(a.cost)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ))
        )}
      </Card>

      <Card title="Pricing changes" subtitle={`For revenue management. All take effect ${L.longDate(1)} and run for the two weeks.`}>
        {sheet.pricing.length === 0 ? (
          <p className="empty-line">No pricing changes are approved.</p>
        ) : (
          <table className="tbl compact sheet sheet-pricing">
            <thead>
              <tr>
                <th>Branch</th>
                <th>Applies to</th>
                <th>Change</th>
                <th>Effective</th>
              </tr>
            </thead>
            <tbody>
              {sheet.pricing.map((a) => {
                const r = pricingRow(a, L);
                return (
                  <tr key={a.id}>
                    <td>{r.branch}</td>
                    <td>{r.appliesTo}</td>
                    <td className="n">{r.change}</td>
                    <td>{L.longDate(1)}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}
      </Card>

      <p className="fine">
        All figures are synthetic. The gain is an average over low, base and high demand for the approved actions on their own, with nothing else changed.
      </p>
    </div>
  );
}
