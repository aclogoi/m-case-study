import { Bar, BarChart, CartesianGrid, Cell, LabelList, ReferenceLine, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";
import type { StrategyResult } from "../../api/types";
import { compactUsd, signedUsd, usd } from "../../lib/format";
import { TipBox } from "./ChartTooltip";
import { C, labelStyle, tickStyle } from "./theme";

interface Row {
  id: string;
  label: string;
  value: number;
  total: number;
  gain: number;
  actions: number;
  tip: string;
}

/** Four bars, one per strategy. `mode` picks the gain over do nothing or the full total. */
export function StrategyBars({ strategies, mode }: { strategies: StrategyResult[]; mode: "gain" | "total" }) {
  const none = strategies.find((s) => s.id === "none") ?? strategies[0];
  const rows: Row[] = strategies.map((s) => {
    const gain = s.expected_contribution - none.expected_contribution;
    return {
      id: s.id,
      label: s.label,
      value: mode === "gain" ? gain : s.expected_contribution,
      total: s.expected_contribution,
      gain,
      actions: s.action_count,
      tip: mode === "gain" ? (s.id === "none" ? "baseline" : signedUsd(gain)) : usd(s.expected_contribution),
    };
  });
  const fill = (id: string) => (id === "joint" ? C.plan : id === "none" ? C.nothing : C.planSoft);
  const min = Math.min(0, ...rows.map((r) => r.value));

  return (
    <ResponsiveContainer width="100%" height={196}>
      <BarChart layout="vertical" data={rows} margin={{ top: 4, right: 72, bottom: 0, left: 4 }} barCategoryGap={8}>
        <CartesianGrid horizontal={false} stroke={C.grid} />
        <XAxis type="number" domain={[min, "auto"]} tickFormatter={(v: number) => compactUsd(v, mode === "gain")} tick={tickStyle} axisLine={false} tickLine={false} tickCount={5} />
        <YAxis type="category" dataKey="label" width={92} tick={{ fontSize: 13, fill: C.ink2 }} axisLine={false} tickLine={false} />
        <ReferenceLine x={0} stroke={C.axis} />
        <Tooltip
          cursor={{ fill: "rgba(11,11,11,0.04)" }}
          content={({ active, payload }) => {
            if (!active || !payload?.length) return null;
            const r = payload[0].payload as Row;
            return (
              <TipBox
                title={r.label}
                rows={[
                  { label: "Expected contribution", value: usd(r.total), swatch: fill(r.id) },
                  { label: "Against do nothing", value: signedUsd(r.gain) },
                  { label: "Actions", value: r.actions },
                ]}
              />
            );
          }}
        />
        <Bar dataKey="value" barSize={20} radius={[0, 4, 4, 0]} isAnimationActive={false} minPointSize={2}>
          {rows.map((r) => (
            <Cell key={r.id} fill={fill(r.id)} />
          ))}
          <LabelList dataKey="tip" position="right" style={labelStyle} offset={8} />
        </Bar>
      </BarChart>
    </ResponsiveContainer>
  );
}
