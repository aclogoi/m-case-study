// Chart colours by role (dataviz reference palette, light surface).
// "The plan" is blue and "do nothing" is neutral grey in every chart.
export const C = {
  plan: "#2a78d6",
  planSoft: "#86b6ef", // the restricted strategies: same hue, a lighter step
  nothing: "#a3a199",
  up: "#0ca30c",
  down: "#d03b3b",
  grid: "#e1e0d9",
  axis: "#c3c2b7",
  ink: "#0b0b0b",
  ink2: "#52514e",
  muted: "#898781",
};

export const tickStyle = { fontSize: 12, fill: C.muted } as const;
export const labelStyle = { fontSize: 12, fill: C.ink2, fontVariantNumeric: "tabular-nums" } as const;

/** Round axis ticks covering [lo, hi] in about `count` steps of 1, 2, 2.5 or 5 times a power of ten. */
export function niceTicks(lo: number, hi: number, count = 5): number[] {
  const span = Math.max(hi - lo, 1);
  const raw = span / count;
  const mag = Math.pow(10, Math.floor(Math.log10(raw)));
  const step = [1, 2, 2.5, 5, 10].map((m) => m * mag).find((s) => s >= raw) ?? raw;
  const start = Math.floor(lo / step) * step;
  const end = Math.ceil(hi / step) * step;
  const out: number[] = [];
  for (let v = start; v <= end + step / 2; v += step) out.push(Math.round(v * 100) / 100);
  return out;
}
