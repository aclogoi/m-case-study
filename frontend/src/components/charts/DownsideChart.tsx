import { Bar, BarChart, CartesianGrid, LabelList, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";
import type { DownsideRow } from "../../api/types";
import { compactUsd, signedUsd, usd } from "../../lib/format";
import { TipBox } from "./ChartTooltip";
import { C, labelStyle, tickStyle } from "./theme";

interface Row extends DownsideRow {
  name: string;
  diff: string;
}

function ScenarioTick(props: { x?: number; y?: number; payload?: { value: string } }) {
  const { x = 0, y = 0, payload } = props;
  const [label, weight] = (payload?.value ?? "").split("|");
  return (
    <text x={x} y={y + 14} textAnchor="middle" fontSize={12}>
      <tspan x={x} fill={C.ink2}>{label}</tspan>
      <tspan x={x} dy={14} fill={C.muted}>{weight}</tspan>
    </text>
  );
}

/** The plan beside do nothing in each demand scenario. Zero-based, so bar lengths compare honestly. */
export function DownsideChart({ rows }: { rows: DownsideRow[] }) {
  const data: Row[] = rows.map((r) => ({ ...r, name: `${r.label}|weight ${Math.round(r.weight * 100)}%`, diff: signedUsd(r.plan - r.do_nothing) }));
  return (
    <ResponsiveContainer width="100%" height={262}>
      <BarChart data={data} margin={{ top: 20, right: 12, bottom: 0, left: 4 }} barGap={2} barCategoryGap="30%">
        <CartesianGrid vertical={false} stroke={C.grid} />
        <XAxis dataKey="name" tick={<ScenarioTick />} interval={0} height={40} axisLine={{ stroke: C.axis }} tickLine={false} />
        <YAxis tickFormatter={(v: number) => compactUsd(v)} tick={tickStyle} axisLine={false} tickLine={false} width={52} tickCount={5} />
        <Tooltip
          cursor={{ fill: "rgba(11,11,11,0.04)" }}
          content={({ active, payload }) => {
            if (!active || !payload?.length) return null;
            const r = payload[0].payload as Row;
            return (
              <TipBox
                title={`${r.label} · weight ${Math.round(r.weight * 100)}%`}
                rows={[
                  { label: "The plan", value: usd(r.plan), swatch: C.plan },
                  { label: "Do nothing", value: usd(r.do_nothing), swatch: C.nothing },
                  { label: "Difference", value: signedUsd(r.plan - r.do_nothing) },
                ]}
              />
            );
          }}
        />
        <Bar dataKey="do_nothing" name="Do nothing" fill={C.nothing} barSize={24} radius={[4, 4, 0, 0]} isAnimationActive={false} />
        <Bar dataKey="plan" name="The plan" fill={C.plan} barSize={24} radius={[4, 4, 0, 0]} isAnimationActive={false}>
          <LabelList dataKey="diff" position="top" style={labelStyle} />
        </Bar>
      </BarChart>
    </ResponsiveContainer>
  );
}
