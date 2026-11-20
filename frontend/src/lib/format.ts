const MINUS = "−";

const usdFmt = new Intl.NumberFormat("en-US", { maximumFractionDigits: 0 });
const usdCentsFmt = new Intl.NumberFormat("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });

/** Totals: whole dollars, true minus sign. */
export function usd(n: number): string {
  const r = Math.round(n);
  return `${r < 0 ? MINUS : ""}$${usdFmt.format(Math.abs(r))}`;
}

/** Small unit amounts (a per-move cost) keep their cents. */
export function usdCents(n: number): string {
  return `${n < 0 ? MINUS : ""}$${usdCentsFmt.format(Math.abs(n))}`;
}

/** Signed delta in whole dollars: +$1,240 / −$440 / $0. */
export function signedUsd(n: number): string {
  const r = Math.round(n);
  if (r === 0) return "$0";
  return `${r > 0 ? "+" : MINUS}$${usdFmt.format(Math.abs(r))}`;
}

export function compactUsd(n: number, signed = false): string {
  const a = Math.abs(n);
  const body = a >= 1000 ? `$${(a / 1000).toFixed(a >= 10000 || a % 1000 === 0 ? 0 : 1)}K` : `$${Math.round(a)}`;
  if (Math.round(n) === 0) return "$0";
  return `${n < 0 ? MINUS : signed ? "+" : ""}${body}`;
}

export function num(n: number, digits = 1): string {
  const s = n.toFixed(digits);
  const trimmed = digits > 0 ? s.replace(/\.0+$/, "") : s;
  return trimmed.startsWith("-") ? MINUS + trimmed.slice(1) : trimmed;
}

export function signedNum(n: number, digits = 1): string {
  const r = Number(n.toFixed(digits));
  if (r === 0) return "0";
  return `${r > 0 ? "+" : MINUS}${num(Math.abs(r), digits)}`;
}

/** Utilization and other 0..1 shares. */
export function pct(fraction: number, digits = 1): string {
  return `${(fraction * 100).toFixed(digits)}%`;
}

/** Percentage-point change given as a fraction (0.02 = +2.0 pts). */
export function signedPts(fraction: number): string {
  const v = Number((fraction * 100).toFixed(1));
  if (v === 0) return "0.0 pts";
  return `${v > 0 ? "+" : MINUS}${Math.abs(v).toFixed(1)} pts`;
}

export function signedPct(fraction: number): string {
  const v = Math.round(fraction * 100);
  if (v === 0) return "0%";
  return `${v > 0 ? "+" : MINUS}${Math.abs(v)}%`;
}

export function gapText(gap: number | null): string {
  if (gap === null) return "no gap reported";
  if (gap <= 1e-6) return "gap 0.00%";
  return `gap ${(gap * 100).toFixed(2)}%`;
}

export type Tone = "pos" | "neg" | "zero";
export function tone(n: number, epsilon = 0.005): Tone {
  return n > epsilon ? "pos" : n < -epsilon ? "neg" : "zero";
}

// ---------------------------------------------------------------- days

function dateOf(startDate: string, day: number): Date {
  const [y, m, d] = startDate.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, d + day - 1));
}

const weekdayFmt = new Intl.DateTimeFormat("en-US", { weekday: "short", timeZone: "UTC" });
const weekdayLongFmt = new Intl.DateTimeFormat("en-US", { weekday: "long", timeZone: "UTC" });
const dateFmt = new Intl.DateTimeFormat("en-GB", { weekday: "short", day: "numeric", month: "short", timeZone: "UTC" });

/** "Tue, day 2": weekday plus the 1-indexed day number of the horizon. */
export function dayLabel(startDate: string, day: number): string {
  return `${weekdayFmt.format(dateOf(startDate, day))}, day ${day}`;
}

export function weekdayLong(startDate: string, day: number): string {
  return weekdayLongFmt.format(dateOf(startDate, day));
}

/** "Tue 24 Nov": the calendar date, for tooltips and headers. */
export function calendarDate(startDate: string, day: number): string {
  return dateFmt.format(dateOf(startDate, day)).replace(",", "");
}

const longDateFmt = new Intl.DateTimeFormat("en-GB", { weekday: "long", day: "numeric", month: "short", timeZone: "UTC" });

/** "Tuesday 24 Nov": for deadlines and the hand-off sheet. */
export function longDate(startDate: string, day: number): string {
  return longDateFmt.format(dateOf(startDate, day)).replace(",", "");
}

/** Whole numbers for counts of rentals and trucks. */
export function whole(n: number): string {
  return usdFmt.format(Math.round(n));
}
