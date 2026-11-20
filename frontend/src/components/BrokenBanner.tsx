import type { SolveResponse } from "../api/types";
import { num, usd } from "../lib/format";
import { useLookups } from "../state/store";

/** Shown above everything, on every view, whenever a confirmed booking cannot be served. */
export function BrokenBanner({ result }: { result: SolveResponse }) {
  const L = useLookups();
  const broken = result.plan.broken_commitments;
  if (broken.length === 0) return null;
  const total = broken.reduce((s, b) => s + b.expected_count, 0);
  return (
    <div className="banner banner-critical no-print" role="alert">
      <div className="banner-title">
        <span className="banner-icon" aria-hidden="true">!</span>
        Broken commitments: {num(total)} confirmed {total === 1 ? "booking" : "bookings"} cannot be served under the current decisions
      </div>
      <ul>
        {broken.map((b) => (
          <li key={`${b.booking_id}-${b.start_day}`}>
            {num(b.expected_count)} × {L.className(b.class_id)} at {L.branchName(b.origin)}, starting {L.day(b.start_day)} <span className="unit">(booking {b.booking_id})</span>
          </li>
        ))}
      </ul>
      <p>
        Penalty {usd(result.plan_result.expected_penalty)} at {usd(result.params.broken_commitment_penalty)} each. It is counted in the running tally above; the other contribution figures on this page leave it out.
      </p>
    </div>
  );
}
