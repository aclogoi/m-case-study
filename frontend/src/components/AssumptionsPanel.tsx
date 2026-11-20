import type { Lane, Params } from "../api/types";
import { pct, usd } from "../lib/format";
import { useStore, type SliderKey } from "../state/store";

const ASSUMPTIONS = [
  "Objective: expected network contribution over 14 days (rental and fee revenue, less variable cost, incentive payments and transport). Branch incentives never enter it.",
  "Daily buckets; moves are dispatched on days 1 to 5 and charged at full cost. Nothing is valued after day 14, so late-paying moves are undervalued.",
  "Five Northeast branches, two classes (16 ft box, 26 ft moving). Rentals last 2 days local and 3 days one-way.",
  "Confirmed bookings have fixed prices and must be served; a broken commitment carries a $1,000 penalty, reported separately.",
  "New demand has low, base and high scenarios (80 / 100 / 120% of forecast, weighted 25 / 50 / 25). The plan is fixed; rentals served adapt.",
  "Rate tiers (−20%, −10%, 0, +10%) apply to new local rentals with constant elasticity.",
  "Drop-fee tiers (+$0, +$50, +$100) apply to new one-way rentals into a branch; 40% of deterred rentals book to the nearest other branch.",
  "Return-incentive tiers ($0, $40, $80) redirect confirmed one-way returns from the nearest neighbor; uptake is modeled at its expected share.",
  "Each rental is affected by exactly one lever. Any rate, fee or incentive change carries a $50 change cost.",
  "Staff drive: arrives next day, up to 150 miles, at most 2 per branch per day. Hauler: arrives in 2 days, any distance.",
  "Rental revenue is booked at the origin branch, drop-fee revenue at the destination. HQ sets all prices.",
  "Utilization is rented truck-days over assigned fleet-days; under current rules assigned fleet does not change when HQ moves a truck.",
  "Not modeled: competitor pricing, substitution between classes, maintenance downtime, hauler batching, fleet purchases, repeat business.",
];

interface SliderDef {
  key: SliderKey;
  label: string;
  min: number;
  max: number;
  step: number;
}

// Ranges are the bounds ParamOverrides accepts in schemas.py.
const SLIDERS: SliderDef[] = [
  { key: "elasticity_scale", label: "Rate elasticity", min: 0.25, max: 2.5, step: 0.05 },
  { key: "fee_deterrence_scale", label: "Fee deterrence", min: 0, max: 2.5, step: 0.05 },
  { key: "incentive_uptake_scale", label: "Incentive uptake", min: 0, max: 2, step: 0.05 },
  { key: "move_cost_multiplier", label: "Move cost", min: 0.25, max: 10, step: 0.25 },
];

const cap = (x: number) => Math.min(1, Math.max(0, x));

/** Sliders that are off their default, as "Move cost ×2.00". Empty when the plan rests on the stated assumptions. */
export function useChangedAssumptions(): string[] {
  const { scenario, overrides } = useStore();
  const p = scenario?.params;
  return SLIDERS.filter((s) => overrides[s.key] !== undefined && overrides[s.key] !== (p ? p[s.key] : 1)).map((s) => `${s.label} ×${(overrides[s.key] ?? 1).toFixed(2)}`);
}

function staffCost(l: Lane, p: Params, mult: number) {
  return ((2 * l.miles) / p.staff_speed_mph * p.staff_hourly + 2 * l.miles * p.staff_per_mile) * mult;
}
function haulerCost(l: Lane, p: Params, mult: number) {
  return (p.hauler_load_fee + l.miles * p.hauler_per_mile) * mult;
}

export function AssumptionsPanel() {
  const { scenario, overrides, setOverride, resetOverrides } = useStore();
  const p = scenario?.params;
  const name = (id: string) => scenario?.branches.find((b) => b.id === id)?.short_name ?? id;
  const dirty = useChangedAssumptions().length > 0;

  function effective(key: SliderKey, v: number): string[] {
    if (!p || !scenario) return [];
    switch (key) {
      case "elasticity_scale":
        return [
          `${(p.elasticity_default * v).toFixed(2).replace("-", "−")} network`,
          ...Object.entries(p.elasticity_by_branch).map(([b, e]) => `${(e * v).toFixed(2).replace("-", "−")} ${name(b)}`),
        ];
      case "fee_deterrence_scale":
        return p.fee_tiers.map((f, i) => (f > 0 ? `${pct(cap(p.fee_deterrence[i] * v), 0)} deterred at +$${f}` : "")).filter(Boolean);
      case "incentive_uptake_scale":
        return p.incentive_tiers.map((a, i) => (a > 0 ? `${pct(cap(p.incentive_uptake[i] * v), 0)} uptake at $${a}` : "")).filter(Boolean);
      case "move_cost_multiplier": {
        const staff = scenario.lanes.filter((l) => l.staff_allowed).sort((a, b) => a.miles - b.miles)[0];
        const haul = [...scenario.lanes].sort((a, b) => b.miles - a.miles)[0];
        const out: string[] = [];
        if (staff) out.push(`${usd(staffCost(staff, p, v))} staff drive ${name(staff.origin)} to ${name(staff.dest)}`);
        if (haul) out.push(`${usd(haulerCost(haul, p, v))} hauler ${name(haul.origin)} to ${name(haul.dest)}`);
        return out;
      }
    }
  }

  return (
    <div className="assumptions-panel">
      <div className="side-section" id="assumptions">
        <div className="side-head">
          <span className="side-label">Sensitivity</span>
          <button type="button" className="link" onClick={resetOverrides} disabled={!dirty}>Reset</button>
        </div>
        <p className="fine">Each slider re-solves the plan: what would be recommended if an assumption were different. Approvals stay pinned as approved.</p>
        {SLIDERS.map((s) => {
          const base = p ? p[s.key] : 1;
          const v = overrides[s.key] ?? base;
          const changed = overrides[s.key] !== undefined && overrides[s.key] !== base;
          return (
            <div className="slider" key={s.key}>
              <div className="slider-top">
                <label htmlFor={s.key}>{s.label}</label>
                <span className={`slider-value ${changed ? "changed" : ""}`}>×{v.toFixed(2)}</span>
              </div>
              <input id={s.key} type="range" min={s.min} max={s.max} step={s.step} value={v} disabled={!p} onChange={(e) => setOverride(s.key, Number(e.target.value))} />
              <ul className="effective">
                {effective(s.key, v).map((t) => (
                  <li key={t}>{t}</li>
                ))}
              </ul>
            </div>
          );
        })}
      </div>

      <div className="side-section">
        <span className="side-label">Modeling assumptions</span>
        <p className="synthetic">All figures are synthetic. The result is the best plan the solver found for this model, not a claim about a real business.</p>
        <ol className="assumptions">
          {ASSUMPTIONS.map((a) => (
            <li key={a}>{a}</li>
          ))}
        </ol>
      </div>
    </div>
  );
}
