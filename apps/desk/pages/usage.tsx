// USAGE page: today's Claude Code token usage on the host (the old PULSE page, redone).
// All read-only → terminal frames (TBox) with ASCII charts; the one control is the rounded
// today / 7d switch. Brief: apps/desk/DESIGN.md.
//
//   ┌ OUTPUT · TODAY ───── opus-5-5 ┐  ( today | 7d )
//   │ 143.9k             41.2k last h│
//   │ 39.3m read · 99% cached · 144  │
//   ┌ BY HOUR ─────── peak 134.5k · 14h ┐   (7d: BY DAY, a bar per day, value on top)
//   │ ▁ ▂ ▃ █ █ █ ▇ ▂ ...               │
//   │ 0     6     12  now    18         │
//   ┌ PROJECTS ─────────────────────────┐
//   │ pocketdeck ███████░░░ 128.2k  89% │
//
// Data: desk.usage (DESIGN.md §5). Optional keys this page reads beyond §5:
//   projects7d[]  { name, out, pct } for the 7d PROJECTS frame (falls back to today's, titled so)
//   _range        "7d" → start on the 7d view (preview mocks only; deckd never sends it)

import { For, Show, createMemo, createSignal } from "solid-js";
import { Text, View } from "@pocketjs/framework/components";
import { desk } from "../link.ts";
import { accent } from "../theme.ts";
import { C, PW, PH, Seg, TBar, TBox } from "../ui.tsx";

// ---- numbers ------------------------------------------------------------------------------

/** "143.9k" / "39.32m" / 1234 → tokens. Unknown → 0. */
function tok(v: unknown): number {
  if (typeof v === "number") return Number.isFinite(v) ? Math.max(0, v) : 0;
  if (typeof v !== "string") return 0;
  const m = /^\s*([\d.,]+)\s*([kmb]?)/i.exec(v);
  if (!m) return 0;
  const n = parseFloat(m[1]!.replace(/,/g, ""));
  if (!Number.isFinite(n)) return 0;
  const mul = { "": 1, k: 1e3, m: 1e6, b: 1e9 }[m[2]!.toLowerCase()] ?? 1;
  return n * mul;
}

/** Compact, ≤ 5 chars: 950 · 9.5k · 95.4k · 954k · 9.5m · 954m · 9.5b. */
function short(n: number): string {
  if (n < 1e3) return String(Math.round(n));
  if (n < 1e5) return `${(n / 1e3).toFixed(1)}k`;
  if (n < 1e6 - 500) return `${Math.round(n / 1e3)}k`;
  if (n < 1e8) return `${(n / 1e6).toFixed(1)}m`;
  if (n < 1e9 - 5e5) return `${Math.round(n / 1e6)}m`;
  return `${(n / 1e9).toFixed(1)}b`;
}

/** Headline, ≤ 6 chars: 143.9k · 1.24m · 12.4m · 124m · 1.24b. */
function big(n: number): string {
  if (n < 1e3) return String(Math.round(n));
  if (n < 1e6 - 50) return `${(n / 1e3).toFixed(1)}k`;
  if (n < 1e7) return `${(n / 1e6).toFixed(2)}m`;
  if (n < 1e8) return `${(n / 1e6).toFixed(1)}m`;
  if (n < 1e9 - 5e5) return `${Math.round(n / 1e6)}m`;
  return `${(n / 1e9).toFixed(2)}b`;
}

const int = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? Math.max(0, Math.round(v)) : 0);
const count = (n: number) => (n >= 1e4 ? short(n) : String(n));
const clip = (s: unknown, n: number): string => {
  const str = (typeof s === "string" ? s : "").toLowerCase() || "?";
  return str.length > n ? `${str.slice(0, n - 1)}…` : str;
};
const padL = (s: string, n: number) => (s.length >= n ? s : " ".repeat(n - s.length) + s);

// ---- ASCII bar chart ----------------------------------------------------------------------
// A chart is ROWS lines of mono text, drawn as three stacked layers so each can take its own
// colour: `base` (dim baseline for empty columns), `bars` (accent) and `hot` (the highlighted
// column, white) plus `note` (mute value labels above bars, 7d only). Every layer is a full grid
// of spaces with its own characters, so the layers line up cell for cell.

const ROWS = 4;
const ROW_H = 12; // px per chart row: the block glyph is taller than this, so stacked rows touch
const EIGHTHS = " ▁▂▃▄▅▆▇█";

type Grid = string[][]; // [row][col] chars, row 0 = top
const grid = (cols: number): Grid => Array.from({ length: ROWS }, () => new Array<string>(cols).fill(" "));

/** Draw a bar `w` cells wide at column x, `lv` eighths tall, into g. */
function drawBar(g: Grid, x: number, w: number, lv: number) {
  for (let r = 0; r < ROWS; r++) {
    const fromBottom = ROWS - 1 - r;
    const e = Math.max(0, Math.min(8, lv - fromBottom * 8));
    if (!e) continue;
    for (let i = 0; i < w; i++) g[r]![x + i] = EIGHTHS[e]!;
  }
}

/** Eighths for v on a 0..max scale: at least one eighth for any non-zero value. */
const level = (v: number, max: number, rows: number) => (v > 0 && max > 0 ? Math.max(1, Math.round((v / max) * rows * 8)) : 0);

interface Chart {
  base: string[];
  bars: string[];
  hot: string[];
  note: string[];
  axis: string; // mute labels
  axisHot: string; // accent label(s), same width
}

const join = (g: Grid) => g.map((r) => r.join("").replace(/\s+$/, "") || " ");

/** 24 hourly bars, one cell each with a one-cell gap; the current hour in white with "now" under it. */
function hourChart(bars: number[], hour: number): Chart {
  const cols = 48;
  const base = grid(cols);
  const bar = grid(cols);
  const hot = grid(cols);
  const max = Math.max(0, ...bars);
  for (let h = 0; h < 24; h++) {
    const v = bars[h] ?? 0;
    const x = h * 2;
    if (v <= 0) {
      base[ROWS - 1]![x] = h === hour ? "▁" : "·";
      continue;
    }
    drawBar(h === hour ? hot : bar, x, 1, level(v, max, ROWS));
  }
  if (hour >= 0 && hour < 24 && (bars[hour] ?? 0) <= 0) {
    // the current hour with nothing yet: mark it in white on the baseline
    hot[ROWS - 1]![hour * 2] = "▁";
    base[ROWS - 1]![hour * 2] = " ";
  }
  // axis: 0 6 12 18, and "now" centred under the current hour (fixed labels it covers are dropped)
  const axis = new Array<string>(cols).fill(" ");
  const axisHot = new Array<string>(cols).fill(" ");
  let nowFrom = -9;
  let nowTo = -9;
  if (hour >= 0 && hour < 24) {
    nowFrom = Math.max(0, Math.min(cols - 3, hour * 2 - 1));
    nowTo = nowFrom + 2;
    for (let i = 0; i < 3; i++) axisHot[nowFrom + i] = "now"[i]!;
  }
  for (const h of [0, 6, 12, 18]) {
    const s = String(h);
    const from = h * 2;
    const to = from + s.length - 1;
    if (to >= nowFrom - 1 && from <= nowTo + 1) continue;
    for (let i = 0; i < s.length; i++) axis[from + i] = s[i]!;
  }
  const line = (a: string[]) => a.join("").replace(/\s+$/, "") || " ";
  return { base: join(base), bars: join(bar), hot: join(hot), note: join(grid(cols)), axis: line(axis), axisHot: line(axisHot) };
}

/** 7 daily bars, DAY_W cells per column (bar BAR_W wide), the value above each bar, today in white. */
const DAY_W = 7;
const BAR_W = 4;
function dayChart(days: { d: string; out: number }[]): Chart {
  const cols = DAY_W * days.length;
  const base = grid(cols);
  const bar = grid(cols);
  const hot = grid(cols);
  const note = grid(cols);
  const max = Math.max(0, ...days.map((d) => d.out));
  const axis = new Array<string>(cols).fill(" ");
  const axisHot = new Array<string>(cols).fill(" ");
  // the top row is kept for the value labels: bars use ROWS - 1 rows
  days.forEach((d, i) => {
    const x = i * DAY_W + Math.floor((DAY_W - BAR_W) / 2);
    const today = i === days.length - 1;
    const lv = level(d.out, max, ROWS - 1);
    if (lv) drawBar(today ? hot : bar, x, BAR_W, lv);
    else for (let k = 0; k < BAR_W; k++) base[ROWS - 1]![x + k] = "·";
    // value label in the row above the bar's top cell
    const topRow = lv ? ROWS - 1 - Math.floor((lv - 1) / 8) - 1 : ROWS - 2;
    const lab = lv ? short(d.out) : "0";
    const lx = i * DAY_W + Math.floor((DAY_W - lab.length) / 2);
    for (let k = 0; k < lab.length; k++) note[topRow]![lx + k] = lab[k]!;
    const name = clip(d.d, 3);
    const nx = i * DAY_W + Math.floor((DAY_W - name.length) / 2);
    for (let k = 0; k < name.length; k++) (today ? axisHot : axis)[nx + k] = name[k]!;
  });
  const line = (a: string[]) => a.join("").replace(/\s+$/, "") || " ";
  return { base: join(base), bars: join(bar), hot: join(hot), note: join(note), axis: line(axis), axisHot: line(axisHot) };
}

/** The chart: ROWS layered rows plus the axis line, all in xs mono. */
function AsciiChart(props: { chart: () => Chart; w: number }) {
  const layer = (txt: () => string, color: string | (() => string)) => (
    <View class="absolute" style={{ insetL: 0, insetT: 0 }}>
      <Text class="text-xs font-bold leading-[12]" style={{ width: props.w, height: ROW_H, textColor: typeof color === "string" ? color : color() }}>
        {txt()}
      </Text>
    </View>
  );
  return (
    <View class="flex-col" style={{ width: props.w }}>
      <For each={Array.from({ length: ROWS }, (_, i) => i)}>
        {(r) => (
          <View class="relative" style={{ width: props.w, height: ROW_H }}>
            {layer(() => props.chart().base[r]!, C.dim)}
            {layer(() => props.chart().bars[r]!, accent)}
            {layer(() => props.chart().hot[r]!, C.fg)}
            {layer(() => props.chart().note[r]!, C.mute)}
          </View>
        )}
      </For>
      <View class="relative" style={{ width: props.w, height: 15, marginT: 2 }}>
        {layer(() => props.chart().axis, C.mute)}
        {layer(() => props.chart().axisHot, accent)}
      </View>
    </View>
  );
}

// ---- projects -------------------------------------------------------------------------------

interface Proj {
  name: string;
  out: number;
  pct: number;
}
const MAX_PROJ = 5;
const NAME_CH = 13;
const CELLS = 27;

/** Top projects; past MAX_PROJ the tail folds into one "+n more" row. */
function topProjects(raw: unknown): Proj[] {
  const ps: Proj[] = (Array.isArray(raw) ? raw : [])
    .map((p: any) => ({ name: clip(p?.name, NAME_CH), out: tok(p?.out), pct: Math.max(0, Math.min(100, Number(p?.pct) || 0)) }))
    .sort((a, b) => b.out - a.out || b.pct - a.pct);
  if (ps.length <= MAX_PROJ) return ps;
  const rest = ps.slice(MAX_PROJ - 1);
  return [
    ...ps.slice(0, MAX_PROJ - 1),
    { name: `+${rest.length} more`, out: rest.reduce((s, p) => s + p.out, 0), pct: Math.min(100, rest.reduce((s, p) => s + p.pct, 0)) },
  ];
}

function ProjectRow(props: { p: Proj; first: boolean; more: boolean }) {
  const ink = () => (props.more ? C.mute : props.first ? C.fg : C.soft);
  return (
    <View class="flex-row items-center" style={{ height: 15 }}>
      <Text class="text-xs font-bold" style={{ width: 98, textColor: ink() }}>{props.p.name}</Text>
      <TBar value={() => (props.p.pct > 0 ? Math.max(props.p.pct / 100, 1 / CELLS) : 0)} cells={CELLS} color={props.more ? C.mute : props.first ? accent() : C.soft} />
      <Text class="text-xs font-bold" style={{ width: 50, textColor: ink() }}>{padL(short(props.p.out), 6)}</Text>
      <Text class="text-xs font-bold" style={{ width: 36, textColor: C.mute }}>{padL(`${Math.round(props.p.pct)}%`, 5)}</Text>
    </View>
  );
}

// ---- page -----------------------------------------------------------------------------------

const GAP = 8;
const SEG_W = 96; // today | 7d
const CHART_W = 48 * 7.2; // 48 mono cells at xs (Geist Mono advance 0.6 em)

export function UsagePage(props: { active: () => boolean }) {
  void props.active; // nothing animates here: the page is static between deckd pushes
  const u = () => (desk.usage ?? {}) as Record<string, any>;
  const [pick, setPick] = createSignal<string | null>(null);
  const range = () => pick() ?? (u()._range === "7d" ? "7d" : "today");
  const week = () => range() === "7d";

  // today
  const bars = createMemo(() => {
    const b = Array.isArray(u().bars) ? (u().bars as unknown[]) : [];
    return Array.from({ length: 24 }, (_, i) => Math.max(0, Number(b[i]) || 0));
  });
  const hour = () => {
    const h = Number(u().hour);
    return Number.isInteger(h) && h >= 0 && h < 24 ? h : -1;
  };
  const out = () => tok(u().output);
  const idleToday = () => out() <= 0 && bars().every((v) => v <= 0);
  const peakHour = () => {
    let best = -1;
    bars().forEach((v, i) => {
      if (v > 0 && (best < 0 || v > bars()[best]!)) best = i;
    });
    return best;
  };

  // week
  const days = createMemo(() => {
    const ds = Array.isArray(u().days) ? (u().days as any[]) : [];
    return ds.slice(-7).map((d) => ({ d: typeof d?.d === "string" ? d.d : "?", out: tok(d?.out) }));
  });
  const weekTotal = () => days().reduce((s, d) => s + d.out, 0);
  const busiest = (): { d: string; out: number } | null => days().reduce<{ d: string; out: number } | null>((b, d) => (d.out > 0 && (!b || d.out > b.out) ? d : b), null);
  const activeDays = () => days().filter((d) => d.out > 0).length;
  const idleWeek = () => weekTotal() <= 0;

  const idle = () => (week() ? idleWeek() : idleToday());
  const chart = createMemo(() => {
    const c = week() ? dayChart(days()) : hourChart(bars(), hour());
    // nothing used: no "0" labels, the overlay message sits over the empty rows
    return idle() ? { ...c, note: c.note.map(() => " ") } : c;
  });

  const projects = createMemo(() => topProjects(week() && Array.isArray(u().projects7d) ? u().projects7d : u().projects));
  const projTitle = () => (!week() ? "PROJECTS" : Array.isArray(u().projects7d) ? "PROJECTS · 7D" : "PROJECTS · TODAY");

  // headline
  const headTitle = () => (week() ? "OUTPUT TOKENS · 7 DAYS" : "OUTPUT TOKENS · TODAY");
  const headNum = () => (week() ? big(weekTotal()) : big(out()));
  const headSide = (): [string, string] =>
    week()
      ? [`${short(weekTotal() / Math.max(1, days().length))}/day`, `${activeDays()} active days`]
      : [`${short(tok(u().lastHour))} last h`, `${int(u().sessions)} ${int(u().sessions) === 1 ? "session" : "sessions"}`];
  const headLine = () => {
    if (week()) {
      const b = busiest();
      const ds = days();
      return weekTotal() > 0 ? `today ${short(ds.at(-1)?.out ?? 0)} · since ${clip(ds[0]?.d, 3)}` : "no claude code use this week";
    }
    if (idleToday()) return "no claude code use yet today";
    return `${short(tok(u().input))} read · ${int(u().cacheHit)}% cached · ${count(int(u().messages))} msgs`;
  };
  const model = () => (typeof u().model === "string" && u().model ? clip(u().model, 12) : undefined);

  const chartTitle = () => (week() ? "BY DAY" : "BY HOUR");
  const chartRight = () => {
    if (idle()) return "idle";
    if (week()) {
      const b = busiest();
      return b ? `busiest ${clip(b.d, 3)} ${short(b.out)}` : "idle";
    }
    const p = peakHour();
    const peak = tok(u().peak);
    return `peak ${peak > 0 ? big(peak) : "–"}${p >= 0 ? ` · ${p}h` : ""}`;
  };

  return (
    <View class="flex-col" style={{ width: PW, height: PH, gap: GAP }}>
      {/* headline + range switch */}
      <View class="flex-row items-start" style={{ gap: 10 }}>
        <TBox title={headTitle()} right={model()} w={PW - 10 - SEG_W}>
          <View class="flex-row items-end justify-between">
            <Text class="text-4xl leading-[38]" style={{ height: 38, textColor: idle() ? C.mute : accent() }}>
              {headNum()}
            </Text>
            <View class="flex-col items-end" style={{ paddingB: 3 }}>
              <Text class="text-xs font-bold" style={{ textColor: idle() ? C.mute : C.soft }}>{headSide()[0]}</Text>
              <Text class="text-xs font-bold" style={{ textColor: C.mute }}>{headSide()[1]}</Text>
            </View>
          </View>
          <Text class="text-xs font-bold" style={{ textColor: C.mute }}>{headLine()}</Text>
        </TBox>
        <View class="flex-col items-end" style={{ width: SEG_W, paddingT: 6 }}>
          <Seg options={["today", "7d"]} value={range} onChange={(v) => setPick(v)} />
        </View>
      </View>

      {/* by hour / by day */}
      <TBox title={chartTitle()} right={chartRight()}>
        <View class="relative flex-row justify-center">
          <AsciiChart chart={chart} w={CHART_W} />
          <Show when={idle()}>
            <View class="absolute items-center justify-center" style={{ insetL: 0, insetR: 0, insetT: 0, height: ROWS * ROW_H }}>
              <Text class="text-xs font-bold" style={{ textColor: C.mute }}>
                {week() ? "a quiet week" : "nothing yet · the bars fill as you work"}
              </Text>
            </View>
          </Show>
        </View>
      </TBox>

      {/* projects */}
      <TBox title={projTitle()} right={projects().length ? `${projectCount(week() && Array.isArray(u().projects7d) ? u().projects7d : u().projects)}` : undefined} grow>
        <Show
          when={projects().length}
          fallback={
            <View class="flex-1 items-center justify-center">
              <Text class="text-xs font-bold" style={{ textColor: C.mute }}>no projects yet</Text>
            </View>
          }
        >
          <View class="flex-col" style={{ paddingT: 2 }}>
            <For each={projects()}>{(p, i) => <ProjectRow p={p} first={i() === 0} more={p.name.startsWith("+")} />}</For>
          </View>
        </Show>
      </TBox>
    </View>
  );
}

const projectCount = (raw: unknown) => {
  const n = Array.isArray(raw) ? raw.length : 0;
  return `${n} ${n === 1 ? "project" : "projects"}`;
};
