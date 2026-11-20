import { Bar, BarChart, CartesianGrid, Cell, LabelList, ReferenceLine, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";
import type { Bridge } from "../../api/types";
import { compactUsd, signedUsd, usd } from "../../lib/format";
import { TipBox } from "./ChartTooltip";
import { C, niceTicks, tickStyle } from "./theme";

interface Row {
  name: string;
  kind: "start" | "step" | "end";
  range: [number, number];
  delta: number;
  running: number;
  label: string;
}

function TwoLineTick(props: { x?: number; y?: number; payload?: { value: string } }) {
  const { x = 0, y = 0, payload } = props;
  const words = (payload?.value ?? "").split(" ");
  const lines = words.length > 1 ? [words[0], words.slice(1).join(" ")] : words;
  return (
    <text x={x} y={y + 12} textAnchor="middle" fontSize={12} fill={C.ink2}>
      {lines.map((l, i) => (
        <tspan key={i} x={x} dy={i === 0 ? 0 : 14}>
          {l}
        </tspan>
      ))}
    </text>
  );
}

/**
 * Waterfall from do nothing to the plan. The axis is the change from the do-nothing
 * total (not dollars from zero), because the steps are a few percent of the total
 * and would be invisible on a zero-based axis. The two totals are printed in full.
 */
export function BridgeChart({ bridge }: { bridge: Bridge }) {
  const rows: Row[] = [];
  rows.push({ name: "Do nothing", kind: "start", range: [0, 0], delta: 0, running: bridge.start, label: usd(bridge.start) });
  let run = 0;
  for (const s of bridge.steps) {
    const next = run + s.delta;
    rows.push({ name: s.label, kind: "step", range: [Math.min(run, next), Math.max(run, next)], delta: s.delta, running: bridge.start + next, label: signedUsd(s.delta) });
    run = next;
  }
  const net = bridge.end - bridge.start;
  rows.push({ name: "The plan", kind: "end", range: [Math.min(0, net), Math.max(0, net)], delta: net, running: bridge.end, label: usd(bridge.end) });

  const fill = (r: Row) => (r.kind === "end" ? C.plan : r.kind === "start" ? C.nothing : r.delta >= 0 ? C.up : C.down);
  const lo = Math.min(0, ...rows.map((r) => r.range[0]));
  const hi = Math.max(0, ...rows.map((r) => r.range[1]));
  // Head-room so the value label above the tallest bar stays inside the plot.
  const ticks = niceTicks(lo, hi + Math.max((hi - lo) * 0.08, 20), 5);

  return (
    <ResponsiveContainer width="100%" height={280}>
      <BarChart data={rows} margin={{ top: 18, right: 12, bottom: 20, left: 4 }} barCategoryGap="22%">
        <CartesianGrid vertical={false} stroke={C.grid} />
        <XAxis dataKey="name" tick={<TwoLineTick />} interval={0} axisLine={false} tickLine={false} height={34} />
        <YAxis domain={[ticks[0], ticks[ticks.length - 1]]} ticks={ticks} tickFormatter={(v: number) => compactUsd(v, true)} tick={tickStyle} axisLine={false} tickLine={false} width={52} />
        <ReferenceLine y={0} stroke={C.axis} />
        <Tooltip
          cursor={{ fill: "rgba(11,11,11,0.04)" }}
          content={({ active, payload }) => {
            if (!active || !payload?.length) return null;
            const r = payload[0].payload as Row;
            if (r.kind === "start") return <TipBox title="Do nothing" rows={[{ label: "Expected contribution", value: usd(bridge.start), swatch: C.nothing }]} />;
            if (r.kind === "end")
              return (
                <TipBox
                  title="The plan"
                  rows={[
                    { label: "Expected contribution", value: usd(bridge.end), swatch: C.plan },
                    { label: "Against do nothing", value: signedUsd(net) },
                  ]}
                />
              );
            return (
              <TipBox
                title={r.name}
                rows={[
                  { label: "Effect on contribution", value: signedUsd(r.delta), swatch: fill(r) },
                  { label: "Running total", value: usd(r.running) },
                ]}
              />
            );
          }}
        />
        <Bar dataKey="range" maxBarSize={40} radius={3} isAnimationActive={false} minPointSize={2}>
          {rows.map((r) => (
            <Cell key={r.name} fill={fill(r)} />
          ))}
          <LabelList
            dataKey="label"
            content={(p) => {
              const x = Number(p.x ?? 0);
              const y = Number(p.y ?? 0);
              const w = Number(p.width ?? 0);
              const h = Number(p.height ?? 0);
              const top = Math.min(y, y + h);
              const total = p.index === 0 || p.index === rows.length - 1;
              return (
                <text x={x + w / 2} y={top - 6} textAnchor="middle" fontSize={12} fontWeight={total ? 600 : 400} fill={total ? C.ink : C.ink2}>
                  {String(p.value ?? "")}
                </text>
              );
            }}
          />
        </Bar>
      </BarChart>
    </ResponsiveContainer>
  );
}
