import { useEffect, useRef, useState } from "react";
import { getConditional } from "../api/client";
import type { ConditionalResponse, SolveResponse } from "../api/types";
import { signedUsd, usd } from "../lib/format";
import { useStore } from "../state/store";
import { AssumptionsPanel } from "./AssumptionsPanel";
import { BridgeChart } from "./charts/BridgeChart";
import { DownsideChart } from "./charts/DownsideChart";
import { StrategyBars } from "./charts/StrategyBars";
import { C } from "./charts/theme";
import { Card, Delta, StatusBadge } from "./ui";

function Summary({ result }: { result: SolveResponse }) {
  const none = result.strategies.find((s) => s.id === "none")!;
  const plan = result.plan_result;
  const decided = result.decision.approved_count + result.decision.rejected_action_ids.length;
  return (
    <Card title="Best plan found, and whether it is proven optimal">
      <div className="ev-status">
        <StatusBadge status={plan.status} gap={plan.gap} />
        <span className="fine">
          Current plan solved in {Math.round(plan.solve_ms)} ms · everything on this page {Math.round(result.total_solve_ms)} ms{result.cached ? " · cached" : ""}
        </span>
      </div>
      <table className="tbl compact">
        <thead>
          <tr>
            <th>Expected contribution, 14 days</th>
            <th className="r">Do nothing</th>
            <th className="r">Current plan</th>
            <th className="r">Change</th>
          </tr>
        </thead>
        <tbody>
          <tr className="strong">
            <td>Total</td>
            <td className="r n">{usd(none.expected_contribution)}</td>
            <td className="r n">{usd(plan.expected_contribution)}</td>
            <td className="r n"><Delta value={plan.expected_contribution - none.expected_contribution} /></td>
          </tr>
          <tr>
            <td>Week 1</td>
            <td className="r n">{usd(none.week1)}</td>
            <td className="r n">{usd(plan.week1)}</td>
            <td className="r n"><Delta value={plan.week1 - none.week1} /></td>
          </tr>
          <tr>
            <td>Week 2</td>
            <td className="r n">{usd(none.week2)}</td>
            <td className="r n">{usd(plan.week2)}</td>
            <td className="r n"><Delta value={plan.week2 - none.week2} /></td>
          </tr>
        </tbody>
      </table>
      <p className="fine">
        The current plan is the joint plan under your decisions so far ({decided === 0 ? "none yet, so it is the best plan found" : `${result.decision.approved_count} approved, ${result.decision.rejected_action_ids.length} rejected`}).
        Expected means averaged over the three demand scenarios. Penalties for broken commitments are reported separately.
      </p>
    </Card>
  );
}

function StrategyCard({ result }: { result: SolveResponse }) {
  const [mode, setMode] = useState<"gain" | "total">("gain");
  const s = result.strategies;
  const none = s.find((x) => x.id === "none")!;
  const joint = s.find((x) => x.id === "joint")!;
  const restricted = s.filter((x) => x.id === "moves" || x.id === "pricing");
  const match = joint.action_count > 0 ? restricted.find((x) => Math.abs(x.expected_contribution - joint.expected_contribution) < 0.5) : undefined;
  return (
    <Card
      title="Expected contribution by strategy"
      subtitle={
        (mode === "gain"
          ? `Bars show each strategy's gain over do nothing (${usd(none.expected_contribution)}). `
          : "Bars show total expected contribution from zero. ") + "Same bookings and demand scenarios in all four, with no approvals or rejections applied."
      }
      aside={
        <div className="seg" role="group" aria-label="Bar scale">
          <button type="button" className={mode === "gain" ? "on" : ""} onClick={() => setMode("gain")}>Gain</button>
          <button type="button" className={mode === "total" ? "on" : ""} onClick={() => setMode("total")}>Total</button>
        </div>
      }
    >
      <StrategyBars strategies={s} mode={mode} />
      {match && (
        <p className="note">
          Joint matches {match.label.toLowerCase()} here: the other levers add nothing on these inputs, so the joint plan is not shown winning.
        </p>
      )}
      <table className="tbl compact">
        <thead>
          <tr>
            <th>Strategy</th>
            <th className="r">Contribution</th>
            <th className="r">vs do nothing</th>
            <th className="r">Actions</th>
            <th>Status · gap</th>
          </tr>
        </thead>
        <tbody>
          {s.map((x) => (
            <tr key={x.id} className={x.id === "joint" ? "strong" : ""}>
              <td>{x.label}</td>
              <td className="r n">{usd(x.expected_contribution)}</td>
              <td className="r n">{x.id === "none" ? "—" : <Delta value={x.expected_contribution - none.expected_contribution} />}</td>
              <td className="r n">{x.action_count}</td>
              <td><StatusBadge status={x.status} gap={x.gap} short /></td>
            </tr>
          ))}
        </tbody>
      </table>
    </Card>
  );
}

function ConditionalCard() {
  const { resultRequest, result } = useStore();
  const [data, setData] = useState<ConditionalResponse | null>(null);
  useEffect(() => {
    let live = true;
    setData(null);
    if (resultRequest) getConditional(resultRequest).then((d) => live && setData(d));
    return () => {
      live = false;
    };
    // Re-ask only when a new solve has landed.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [result]);
  if (!data) return null;
  const better = data.incentive_first.expected_value - data.haul_now.expected_value;
  return (
    <Card title="Incentive first, haul if needed" subtitle="One scripted comparison for a single shortage, not a solver feature. The fallback uses only what is known on day 3.">
      <table className="tbl compact">
        <tbody>
          {[data.haul_now, data.incentive_first].map((p) => (
            <tr key={p.label}>
              <td>{p.label}{p.note ? <div className="fine">{p.note}</div> : null}</td>
              <td className="r n">{usd(p.expected_value)}</td>
            </tr>
          ))}
          <tr className="strong">
            <td>Incentive first against haul now</td>
            <td className="r n"><Delta value={better} /></td>
          </tr>
        </tbody>
      </table>
    </Card>
  );
}

/** Everything that backs the recommendations, one click away from every view. */
export function EvidenceDrawer() {
  const { evidenceOpen, setEvidenceOpen, result, solving } = useStore();
  const closeRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    if (!evidenceOpen) return;
    closeRef.current?.focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setEvidenceOpen(false);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [evidenceOpen, setEvidenceOpen]);

  if (!evidenceOpen) return null;
  const net = result ? result.bridge.end - result.bridge.start : 0;

  return (
    <div className="drawer-wrap no-print">
      <div className="scrim" onClick={() => setEvidenceOpen(false)} />
      <aside className="drawer" role="dialog" aria-modal="true" aria-label="Evidence">
        <header className="drawer-head">
          <div>
            <h1>Why trust this?</h1>
            <p className="why">The evidence behind the recommendations: how the strategies compare, where the money comes from, how the plan holds up if demand differs, and every assumption.</p>
          </div>
          <button type="button" className="btn btn-small" ref={closeRef} onClick={() => setEvidenceOpen(false)}>Close</button>
        </header>

        {!result ? (
          <p className="empty-line">The evidence appears once the plan has been solved.</p>
        ) : (
          <div className={`drawer-body ${solving ? "is-refreshing" : ""}`}>
            <Summary result={result} />
            <StrategyCard result={result} />
            <Card
              title="Plan against do nothing"
              subtitle={`Contribution bridge for the current plan: from ${usd(result.bridge.start)} to ${usd(result.bridge.end)}, a net change of ${signedUsd(net)}. This is the only breakdown that sums to the total.`}
            >
              <div className="legend">
                <span><i style={{ background: C.up }} />Raises contribution (+)</span>
                <span><i style={{ background: C.down }} />Lowers it (−)</span>
              </div>
              <BridgeChart bridge={result.bridge} />
              <p className="fine">The vertical axis is the change from the do-nothing total, so the steps are readable; the two totals are printed in full.</p>
            </Card>
            <Card
              title="The plan in low, base and high demand"
              subtitle="The plan is fixed across scenarios; rentals served adapt to what shows up. Labels give the current plan's difference from do nothing in the same scenario."
            >
              <div className="legend">
                <span><i style={{ background: C.nothing }} />Do nothing</span>
                <span><i style={{ background: C.plan }} />The plan</span>
              </div>
              <DownsideChart rows={result.downside} />
              <p className="fine">Three scenarios at 80%, 100% and 120% of forecast: an illustration, not a calibrated distribution. Only demand is uncertain.</p>
            </Card>
            <ConditionalCard />
          </div>
        )}
        <AssumptionsPanel />
      </aside>
    </div>
  );
}
