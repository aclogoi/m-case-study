import type { ReactNode } from "react";

export interface TipRow {
  label: string;
  value: ReactNode;
  swatch?: string;
}

/** Shared tooltip body: values lead, labels follow, identity carried by a swatch. */
export function TipBox({ title, rows, note }: { title: string; rows: TipRow[]; note?: string }) {
  return (
    <div className="tip">
      <div className="tip-title">{title}</div>
      {rows.map((r) => (
        <div className="tip-row" key={r.label}>
          <span className="tip-label">
            {r.swatch && <span className="swatch" style={{ background: r.swatch }} />}
            {r.label}
          </span>
          <span className="tip-value">{r.value}</span>
        </div>
      ))}
      {note && <div className="tip-note">{note}</div>}
    </div>
  );
}
