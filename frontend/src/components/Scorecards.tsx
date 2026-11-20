import type { BranchScorecard, CentralAccount } from "../api/types";
import { num, pct, usd } from "../lib/format";
import { useLookups } from "../state/store";
import { Delta } from "./ui";

/** Actual impact against do nothing under current scorecard rules. Nothing is adjusted here. */
export function ActualImpact({ card }: { card: BranchScorecard }) {
  return (
    <table className="tbl compact scorecard">
      <thead>
        <tr>
          <th>Current rules</th>
          <th className="r">Do nothing</th>
          <th className="r">Under the plan</th>
          <th className="r">Change</th>
        </tr>
      </thead>
      <tbody>
        <tr>
          <td>Revenue</td>
          <td className="r n">{usd(card.baseline.revenue)}</td>
          <td className="r n">{usd(card.actual.revenue)}</td>
          <td className="r n"><Delta value={card.delta.revenue} /></td>
        </tr>
        <tr>
          <td>Rented truck-days</td>
          <td className="r n">{num(card.baseline.rented_truck_days)}</td>
          <td className="r n">{num(card.actual.rented_truck_days)}</td>
          <td className="r n"><Delta value={card.delta.rented_truck_days} kind="num" /></td>
        </tr>
        <tr>
          <td>Assigned fleet-days</td>
          <td className="r n">{num(card.baseline.assigned_fleet_days)}</td>
          <td className="r n">{num(card.actual.assigned_fleet_days)}</td>
          <td className="r n muted">fixed</td>
        </tr>
        <tr>
          <td>Utilization</td>
          <td className="r n">{pct(card.baseline.utilization)}</td>
          <td className="r n">{pct(card.actual.utilization)}</td>
          <td className="r n"><Delta value={card.delta.utilization} kind="pts" /></td>
        </tr>
      </tbody>
    </table>
  );
}

/** The illustrative hold-harmless scorecard: one whole-plan credit and follow-the-truck fleet-days. */
export function AdjustedScorecardTable({ card }: { card: BranchScorecard }) {
  const a = card.adjusted;
  return (
    <table className="tbl compact scorecard">
      <thead>
        <tr>
          <th>Adjusted rules</th>
          <th className="r">Under the plan</th>
          <th className="r">vs do nothing</th>
        </tr>
      </thead>
      <tbody>
        <tr>
          <td>Actual revenue</td>
          <td className="r n">{usd(a.actual_revenue)}</td>
          <td className="r n"><Delta value={a.actual_revenue - card.baseline.revenue} /></td>
        </tr>
        <tr>
          <td>
            Performance credit
            <div className="fine">Paid by the central HQ rebalancing account</div>
          </td>
          <td className="r n">{a.credit > 0.005 ? `+${usd(a.credit)}` : usd(0)}</td>
          <td className="r n muted">{a.credit > 0.005 ? "one credit, whole plan" : "no shortfall"}</td>
        </tr>
        <tr className="strong">
          <td>Scorecard revenue</td>
          <td className="r n">{usd(a.revenue)}</td>
          <td className="r n"><Delta value={a.revenue - card.baseline.revenue} /></td>
        </tr>
        <tr>
          <td>
            Assigned fleet-days
            <div className="fine">Follow the truck: {num(card.actual.assigned_fleet_days)} under current rules</div>
          </td>
          <td className="r n">{num(a.assigned_fleet_days)}</td>
          <td className="r n"><span className="plain-delta">{signed(a.assigned_fleet_days - card.baseline.assigned_fleet_days)}</span></td>
        </tr>
        <tr>
          <td>Rented truck-days</td>
          <td className="r n">{num(a.rented_truck_days)}</td>
          <td className="r n"><Delta value={a.rented_truck_days - card.baseline.rented_truck_days} kind="num" /></td>
        </tr>
        <tr className="strong">
          <td>
            Utilization
            <div className="fine">{pct(card.actual.utilization)} under current rules</div>
          </td>
          <td className="r n">{pct(a.utilization)}</td>
          <td className="r n"><Delta value={a.utilization - card.baseline.utilization} kind="pts" /></td>
        </tr>
      </tbody>
    </table>
  );
}

// Fleet-days moving is neither good nor bad on its face, so it gets a sign but no colour.
function signed(n: number): string {
  const r = Number(n.toFixed(1));
  if (r === 0) return "0";
  return `${r > 0 ? "+" : "−"}${num(Math.abs(r))}`;
}

export function CentralAccountNote({ central }: { central: CentralAccount }) {
  const { branchName } = useLookups();
  const credited = Object.entries(central.credits_by_branch).filter(([, v]) => v > 0.005);
  return (
    <div className="central">
      <div className="central-title">Central HQ rebalancing account</div>
      <dl className="central-grid">
        <div>
          <dt>Credits it funds</dt>
          <dd>{usd(central.total_credits)}</dd>
        </div>
        <div>
          <dt>Transit fleet-days it holds</dt>
          <dd>{num(central.transit_fleet_days)}</dd>
        </div>
      </dl>
      <p className="fine">
        {credited.length > 0
          ? `Credited: ${credited.map(([id, v]) => `${branchName(id)} ${usd(v)}`).join(", ")}. `
          : "No branch falls below its do-nothing revenue, so no credit is paid. "}
        Receiving branches are not charged, and no share of the uplift goes to the donor. Company contribution is the same with or without this policy.
      </p>
    </div>
  );
}

/** Stated plainly, as the planning doc requires. */
export function DoesNotFix() {
  return (
    <div className="caveat">
      <div className="caveat-title">What the adjustment does not fix</div>
      <ul>
        <li>It protects revenue against the baseline. It does not protect utilization.</li>
        <li>A receiving branch can earn more and still see utilization fall, because its assigned fleet-days grow faster than its rentals.</li>
        <li>Credited revenue is scorecard accounting. Total credited revenue exceeds actual revenue by the central account's balance.</li>
        <li>The claim is that the policy removes one reason to resist a move, not every reason.</li>
      </ul>
    </div>
  );
}
