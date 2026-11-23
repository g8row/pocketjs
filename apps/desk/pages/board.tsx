// BOARD — the overview tab: host vitals and the tablet at a glance (brief: apps/desk/DESIGN.md).
// Everything here is read-only (terminal frames) except the history-window switch (rounded).
// The clock, date, Claude status and battery glyph live in the rail; they aren't repeated here.
//
// Data (desk.*): host.os; sys.cpu/mem (%), sys.cores/ghz/memUsedGb/memTotalGb, sys.hist.{cpu,mem}.{1m,10m,1h}
// (30 samples each, %); tablet.battery/charging/memFreeMb/memTotalMb/uptime/tempC/volts/currentMa.
// Every NEW field is optional: without sys.hist the page keeps its own 1m/10m/1h rings from sys.cpu/mem.
// Action: sys.window {w} when the switch changes (deckd may use it to pick its sample cadence).

import { For, createSignal, type Accessor, type JSX } from "solid-js";
import { Text, View, type NodeMirror } from "@pocketjs/framework/components";
import { onFrame } from "@pocketjs/framework/lifecycle";
import { jump, spring } from "@pocketjs/framework/animation";
import { C, PH, PW, TBar, TBox, TSpark } from "../ui.tsx";
import { act, desk, linkConnected } from "../link.ts";

type Win = "1m" | "10m" | "1h";
const WINDOWS: Win[] = ["1m", "10m", "1h"];
const SAMPLES = 30; // per window, as deckd sends them
const STEP_MS: Record<Win, number> = { "1m": 2_000, "10m": 20_000, "1h": 120_000 };

// Layout (page = PW × PH = 406 × 271)
const PAD_X = 8;
const PAD_T = 4;
const PAD_B = 8;
const GAP = 10; // between cells, both ways
const CELL_W = (PW - PAD_X * 2 - GAP) / 2; // 190
const LINK_H = 38;
const CELL_H = Math.floor((PH - PAD_T - PAD_B - LINK_H - GAP * 2) / 2); // 100
const COLS = 21; // sparkline columns = bar cells (text-sm mono: 8 px each → 168 px, inside the 174 px frame)

// ---- data helpers ---------------------------------------------------------------------

const num = (v: unknown): number | undefined => (typeof v === "number" && Number.isFinite(v) ? v : undefined);
const DASH = "–";
const pct = (v: number | undefined) => (v === undefined ? DASH : String(Math.round(Math.max(0, Math.min(100, v)))));
const fix = (v: number, d: number) => v.toFixed(d);
/** Join the known parts with " · "; "–" when none is known. */
const parts = (...p: (string | undefined)[]) => p.filter(Boolean).join(" · ") || DASH;

const OS_LABEL: Record<string, string> = { linux: "LINUX", macos: "MACOS", windows: "WINDOWS" };
const hostLabel = () => {
  const os = desk.host?.os;
  return typeof os === "string" && os ? OS_LABEL[os] ?? os.toUpperCase() : "HOST";
};

/** Resample to exactly `n` columns (bucket means; short series are kept as they are, newest last). */
function fit(vs: number[], n: number): number[] {
  if (vs.length <= n) return vs;
  const out: number[] = [];
  for (let i = 0; i < n; i++) {
    const a = Math.floor((i * vs.length) / n);
    const b = Math.max(a + 1, Math.floor(((i + 1) * vs.length) / n));
    let s = 0;
    for (let j = a; j < b; j++) s += vs[j]!;
    out.push(s / (b - a));
  }
  return out;
}

/** Fallback history for when deckd doesn't send sys.hist: one ring per window, sampled from sys.cpu/mem.
 *  Cheap (a Date.now() compare per frame), and it runs off screen too so the history is there on return. */
function createLocalHist() {
  const rings = {} as Record<Win, { cpu: Accessor<number[]>; mem: Accessor<number[]>; push: (c: number, m: number) => void; at: number }>;
  for (const w of WINDOWS) {
    const [cpu, setCpu] = createSignal<number[]>([]);
    const [mem, setMem] = createSignal<number[]>([]);
    rings[w] = {
      cpu,
      mem,
      at: 0,
      push: (c, m) => {
        setCpu((a) => [...a.slice(a.length >= SAMPLES ? 1 : 0), c]);
        setMem((a) => [...a.slice(a.length >= SAMPLES ? 1 : 0), m]);
      },
    };
  }
  onFrame(() => {
    const s = desk.sys;
    if (!s || s.hist) return;
    const c = num(s.cpu);
    const m = num(s.mem);
    if (c === undefined && m === undefined) return;
    const now = Date.now();
    for (const w of WINDOWS) {
      const r = rings[w];
      if (now - r.at < STEP_MS[w]) continue;
      r.at = now;
      r.push(c ?? 0, m ?? 0);
    }
  });
  return rings;
}

/** UI frame rate, updated once a second while the page is on screen (copied from the old pages.tsx). */
function createFps(active: () => boolean) {
  const [fps, setFps] = createSignal(0);
  let n = 0;
  let t0 = 0;
  onFrame(() => {
    if (!active()) {
      t0 = 0;
      return;
    }
    const now = Date.now();
    if (!t0) {
      t0 = now;
      n = 0;
      return;
    }
    n++;
    if (now - t0 >= 1000) {
      // clamp: 59/60/61 jitter would relayout the label every second for nothing
      setFps(Math.min(60, Math.round((n * 1000) / (now - t0))));
      n = 0;
      t0 = now;
    }
  });
  return fps;
}

// ---- local pieces ---------------------------------------------------------------------

/** Headline: big Geist number with a small mono unit (and an optional marker). Fixed height so a
 *  changing value only relayouts this row. */
function Big(props: { value: string; unit: string; color?: string; mark?: string; markColor?: string }) {
  return (
    <View class="flex-row items-end" style={{ height: 40, gap: 3 }}>
      <Text class="text-4xl" style={{ textColor: props.color ?? C.fg }}>{props.value}</Text>
      <View style={{ paddingB: 6 }}>
        <Text class="text-base font-bold" style={{ textColor: C.mute }}>{props.unit}</Text>
      </View>
      <View style={{ paddingB: 6, paddingL: 2 }}>
        <Text class="text-base font-bold" style={{ textColor: props.markColor ?? C.ok }}>{props.mark || " "}</Text>
      </View>
    </View>
  );
}

/** The mono footnote under a cell. */
function Note(props: { text: string; color?: string }) {
  return (
    <Text class="text-xs font-bold" style={{ textColor: props.color ?? C.mute }}>
      {props.text}
    </Text>
  );
}

/** A vitals cell: frame + headline + one viz row + footnote, all the same size. */
function Cell(props: { title: string; icon: string; hot?: boolean; color?: string; children: JSX.Element }) {
  return (
    <TBox title={props.title} rightIcon={props.icon} hot={props.hot} color={props.color} w={CELL_W} h={CELL_H}>
      <View class="flex-1 flex-col justify-between">{props.children}</View>
    </TBox>
  );
}

/** Rounded segmented switch, 28 px tall (the kit's Seg is 22: under the 26 px touch minimum). */
function WinSeg(props: { value: () => Win; onChange: (w: Win) => void }) {
  return (
    <View class="flex-row rounded-[999] border overflow-hidden" style={{ height: 28, borderColor: C.line2, bgColor: C.bg }}>
      <For each={WINDOWS}>
        {(o) => {
          let n: NodeMirror | undefined;
          return (
            <View
              ref={(x: NodeMirror) => (n = x)}
              class="h-full items-center justify-center rounded-[999]"
              style={{ width: 40, bgColor: props.value() === o ? C.raised : "#00000000" }}
              focusable
              onPress={() => {
                if (n) {
                  jump(n, "scale", 0.92);
                  spring(n, "scale", 1);
                }
                props.onChange(o);
              }}
            >
              <Text class="text-xs font-bold" style={{ textColor: props.value() === o ? C.fg : C.mute }}>{o}</Text>
            </View>
          );
        }}
      </For>
    </View>
  );
}

// ---- page -----------------------------------------------------------------------------

export function BoardPage(props: { active: () => boolean }) {
  const [win, setWin] = createSignal<Win>("10m");
  const local = createLocalHist();
  const fps = createFps(props.active);

  const sys = () => desk.sys ?? {};
  const tab = () => desk.tablet ?? {};

  const hist = (k: "cpu" | "mem"): number[] => {
    const h = sys().hist?.[k]?.[win()];
    const vs = Array.isArray(h) && h.length ? (h as unknown[]).map((v) => num(v) ?? 0) : local[win()][k]();
    return fit(vs, COLS);
  };

  // host CPU — the spark scales to the window's peak (25 / 50 / 100 %) so an idle host still shows shape
  const cpu = () => num(sys().cpu);
  const cpuHist = () => hist("cpu");
  const cpuMax = () => {
    const peak = Math.max(0, ...cpuHist());
    return peak <= 25 ? 25 : peak <= 50 ? 50 : 100;
  };
  const cpuHot = () => (cpu() ?? 0) >= 90;
  const cpuNote = () => {
    const cores = num(sys().cores);
    const ghz = num(sys().ghz);
    return parts(cores !== undefined ? `${cores} cores` : undefined, ghz !== undefined ? `${fix(ghz, 1)} GHz` : undefined);
  };

  // host RAM — 0..100 (memory is a level, not a rate)
  const mem = () => num(sys().mem);
  const memHot = () => (mem() ?? 0) >= 90;
  const memNote = () => {
    const u = num(sys().memUsedGb);
    const t = num(sys().memTotalGb);
    return u !== undefined && t !== undefined ? `${fix(u, 1)} / ${fix(t, 1)} GB` : t !== undefined ? `of ${fix(t, 1)} GB` : DASH;
  };

  // tablet battery
  const batt = () => num(tab().battery);
  const charging = () => tab().charging === true;
  const battLow = () => (batt() ?? 100) <= 15 && !charging();
  const battNote = () => {
    const t = num(tab().tempC);
    const v = num(tab().volts);
    const ma = num(tab().currentMa);
    return parts(
      t !== undefined ? `${Math.round(t)} °C` : undefined,
      v !== undefined ? `${fix(v, 2)} V` : undefined,
      ma !== undefined ? `${ma > 0 ? "+" : ma < 0 ? "−" : ""}${Math.abs(Math.round(ma))} mA` : undefined,
    );
  };

  // tablet RAM
  const free = () => num(tab().memFreeMb);
  const total = () => num(tab().memTotalMb);
  const usedShare = () => {
    const f = free();
    const t = total();
    return f !== undefined && t ? Math.max(0, Math.min(1, 1 - f / t)) : 0;
  };
  const ramTight = () => free() !== undefined && !!total() && usedShare() >= 0.9;

  const choose = (w: Win) => {
    if (w === win()) return;
    setWin(w);
    act("sys.window", { w });
  };

  const accentOr = (hot: boolean, col: string) => (hot ? col : undefined);

  return (
    <View class="flex-col" style={{ width: PW, height: PH, paddingL: PAD_X, paddingR: PAD_X, paddingT: PAD_T, paddingB: PAD_B, gap: GAP }}>
      <View class="flex-row" style={{ gap: GAP }}>
        <Cell title={`${hostLabel()} CPU`} icon="cpu" hot={cpuHot()} color={C.wait}>
          <Big value={pct(cpu())} unit="%" color={accentOr(cpuHot(), C.wait)} />
          <TSpark values={cpuHist} max={cpuMax()} color={cpuHot() ? C.wait : undefined} />
          <Note text={cpuNote()} />
        </Cell>
        <Cell title={`${hostLabel()} RAM`} icon="memory" hot={memHot()} color={C.wait}>
          <Big value={pct(mem())} unit="%" color={accentOr(memHot(), C.wait)} />
          <TSpark values={() => hist("mem")} max={100} color={memHot() ? C.wait : undefined} />
          <Note text={memNote()} />
        </Cell>
      </View>
      <View class="flex-row" style={{ gap: GAP }}>
        <Cell title="TABLET" icon={charging() ? "battery-charging" : "battery"} hot={battLow()} color={C.rose}>
          <Big value={pct(batt())} unit="%" color={accentOr(battLow(), C.rose)} mark={charging() ? "↑" : " "} />
          <TBar value={() => (batt() ?? 0) / 100} cells={COLS} size="sm" color={battLow() ? C.rose : charging() ? C.ok : undefined} />
          <Note text={battNote()} />
        </Cell>
        <Cell title="TABLET RAM" icon="tablet" hot={ramTight()} color={C.wait}>
          <Big value={free() !== undefined ? String(Math.round(free()!)) : DASH} unit="MB" color={accentOr(ramTight(), C.wait)} />
          <TBar value={usedShare} cells={COLS} size="sm" color={ramTight() ? C.wait : undefined} />
          <Note text={total() !== undefined ? `free of ${Math.round(total()!)} MB` : "free"} />
        </Cell>
      </View>
      <View class="flex-row items-end" style={{ gap: GAP }}>
        <TBox title="LINK" h={LINK_H} grow pad={7}>
          <View class="flex-row items-center justify-between">
            <View class="flex-row" style={{ width: 96, gap: 6 }}>
              <Text class="text-xs font-bold" style={{ textColor: linkConnected() ? C.ok : C.rose }}>●</Text>
              <Text class="text-xs font-bold" style={{ textColor: linkConnected() ? C.fg : C.rose }}>
                {linkConnected() ? "usb · ssh" : "offline"}
              </Text>
            </View>
            <View class="flex-1 items-center">
              <Text class="text-xs font-bold" style={{ textColor: C.soft }}>{fps() ? `${fps()} fps` : `${DASH} fps`}</Text>
            </View>
            <View class="items-end" style={{ width: 96 }}>
              <Text class="text-xs font-bold" style={{ textColor: C.mute }}>{tab().uptime ? `up ${tab().uptime}` : `up ${DASH}`}</Text>
            </View>
          </View>
        </TBox>
        <View style={{ paddingB: 1 }}>
          <WinSeg value={win} onChange={choose} />
        </View>
      </View>
    </View>
  );
}
