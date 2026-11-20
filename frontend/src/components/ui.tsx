import type { ReactNode } from "react";
import type { SolverStatus } from "../api/types";
import { gapText, signedNum, signedPts, signedUsd, tone } from "../lib/format";
import { useLookups, useStore } from "../state/store";

export function Card({ title, subtitle, aside, children, className }: { title?: ReactNode; subtitle?: ReactNode; aside?: ReactNode; children: ReactNode; className?: string }) {
  return (
    <section className={`card ${className ?? ""}`}>
      {(title || aside) && (
        <header className="card-head">
          <div>
            {title && <h2>{title}</h2>}
            {subtitle && <p className="card-sub">{subtitle}</p>}
          </div>
          {aside && <div className="card-aside">{aside}</div>}
        </header>
      )}
      {children}
    </section>
  );
}

/** A signed change where higher is better: colour plus an explicit + or − sign. */
export function Delta({ value, kind = "usd" }: { value: number; kind?: "usd" | "num" | "pts" }) {
  const text = kind === "usd" ? signedUsd(value) : kind === "pts" ? signedPts(value) : signedNum(value);
  const eps = kind === "usd" ? 0.5 : kind === "pts" ? 0.0005 : 0.05;
  return <span className={`delta ${tone(value, eps)}`}>{text}</span>;
}

export function BranchChips({ ids, current }: { ids: string[]; current?: string }) {
  const { branchName } = useLookups();
  const { selectBranch } = useStore();
  return (
    <span className="chips">
      {ids.map((id) => (
        <button
          key={id}
          type="button"
          className={`chip ${id === current ? "chip-current" : ""}`}
          title={`Open ${branchName(id)} in the branch view`}
          onClick={(e) => {
            e.stopPropagation();
            selectBranch(id, true);
          }}
        >
          {branchName(id)}
        </button>
      ))}
    </span>
  );
}

const STATUS_TEXT: Record<SolverStatus, string> = {
  optimal: "Proven optimal",
  time_limit: "Time limit reached: best found, not proven optimal",
  infeasible: "Infeasible",
};
const STATUS_SHORT: Record<SolverStatus, string> = { optimal: "Optimal", time_limit: "Time limit", infeasible: "Infeasible" };

export function StatusBadge({ status, gap, short }: { status: SolverStatus; gap: number | null; short?: boolean }) {
  return (
    <span className={`status status-${status}`}>
      <span className="status-dot" aria-hidden="true" />
      {short ? STATUS_SHORT[status] : STATUS_TEXT[status]}
      {status !== "infeasible" && <span className="status-gap"> · {short ? gapText(gap).replace("gap ", "") : gapText(gap)}</span>}
    </span>
  );
}

export function Spinner({ label }: { label: string }) {
  return (
    <div className="loading" role="status">
      <span className="spinner" aria-hidden="true" />
      {label}
    </div>
  );
}

export function Kv({ k, children }: { k: ReactNode; children: ReactNode }) {
  return (
    <div className="kv">
      <dt>{k}</dt>
      <dd>{children}</dd>
    </div>
  );
}

/** An action's name for a list of changes. Moves carry their leave date: two moves on one lane differ only by day. */
export function ActionName({ action }: { action: { label: string; type: string; dispatch_day: number | null } }) {
  const L = useLookups();
  return (
    <>
      <strong>{action.label}</strong>
      {action.type === "move" && action.dispatch_day !== null && <span className="unit"> · leaves {L.date(action.dispatch_day)}</span>}
    </>
  );
}
