// The new panes: PULSE (Claude usage today as ASCII instruments), BOARD (a
// Cloudflare-style ops grid of every live number) and FOCUS (a timer whose
// Material-3 shape morphs from squircle to scallop as the time runs out).

import { For, createEffect, createMemo, on } from "solid-js";
import { Text, View, type NodeMirror } from "@pocketjs/framework/components";
import { onFrame } from "@pocketjs/framework/lifecycle";
import { jump } from "@pocketjs/framework/animation";
import { act, desk, linkConnected } from "./link.ts";
import { Mark, Morph, Trace, createHistory } from "./shapes.tsx";
import { ON_ACCENT, T, accent } from "./theme.ts";
import { decorPhase } from "./clock.ts";

type Active = () => boolean;
const lower = (s: unknown) => (typeof s === "string" ? s.toLowerCase() : "");
const clip = (s: unknown, n: number): string => {
  const str = typeof s === "string" ? s : "";
  return str.length > n ? `${str.slice(0, n - 1)}…` : str;
};

/** Live activity 0..1 across Claude sessions: working sessions + tool-call rate. */
function createActivity() {
  let lastTools = -1;
  let burst = 0;
  return () => {
    const ss = (desk.claude?.sessions ?? []) as any[];
    let tools = 0;
    let working = 0;
    let waiting = 0;
    for (const s of ss) {
      tools += s.toolCount ?? 0;
      if (s.state === "working") working++;
      if (s.state === "waiting") waiting++;
    }
    if (lastTools >= 0 && tools > lastTools) burst = Math.min(1, burst + (tools - lastTools) * 0.35);
    lastTools = tools;
    burst *= 0.985;
    return Math.min(1, working * 0.28 + waiting * 0.15 + burst * 0.6);
  };
}

// ---- PULSE ----------------------------------------------------------------------

const HOURS = "0     6     12    18    ";

export function PulsePage(props: { active: Active }) {
  const u = () => desk.usage ?? {};
  const activity = createActivity();
  // 24-hour bars, 1 char per hour, 6 rows; the current hour drawn in accent.
  const barRows = createMemo(() => {
    const bars: number[] = u().bars ?? new Array(24).fill(0);
    const hour = u().hour ?? -1;
    const rows: { dim: string; hot: string }[] = [];
    for (let y = 5; y >= 0; y--) {
      let dim = "";
      let hot = "";
      for (let h = 0; h < 24; h++) {
        const v = Math.round(((bars[h] ?? 0) * 6) / 8);
        const ch = v > y ? (v === y + 1 ? "=" : "#") : y === 0 ? "." : " ";
        if (h === hour && v > y) {
          dim += " ";
          hot += ch;
        } else {
          dim += ch;
          hot += " ";
        }
      }
      rows.push({ dim, hot: hot.trimEnd() || " " });
    }
    return rows;
  });
  const projBars: NodeMirror[] = [];
  createEffect(
    on(
      () => (u().projects ?? []).map((p: any) => p.pct).join(","),
      () => {
        const ps = u().projects ?? [];
        // jump, not spring: a springing width has fractional edges every
        // frame → op-count changes → full-screen repaints for ~0.5 s
        projBars.forEach((n, i) => jump(n, "scaleX", ps[i] ? Math.max(0.03, (ps[i].pct ?? 0) / 100) : 0));
      },
    ),
  );
  return (
    <View class="h-full flex-col" style={{ width: 512 }}>
      <View class="flex-row px-4 pt-3 justify-between">
        <View class="flex-col">
          <Text class={T.eyebrow}>CLAUDE TODAY · OUTPUT TOKENS</Text>
          <View class="flex-row items-end gap-3">
            <Text class="text-4xl leading-[40]" style={{ textColor: accent() }}>
              {u().output ?? "–"}
            </Text>
            <Text class="text-sm text-[#8a8a8a] pb-1">{`${u().input ?? "–"} read · ${u().cacheHit ?? 0}% cached`}</Text>
          </View>
        </View>
        <View class="flex-col items-end gap-1">
          <Morph size={34} layers={3} spin={() => 0.4 + activity() * 6} morph={() => 0.3 + activity() * 0.7} active={props.active} />
          <Text class={T.monoSm}>{`${u().messages ?? 0} msgs · ${u().sessions ?? 0} sessions`}</Text>
        </View>
      </View>
      {/* live activity seismograph */}
      <View class="flex-col px-4 pt-2">
        <View class="flex-row justify-between">
          <Text class={T.monoSm}>live activity</Text>
          <Text class={T.monoSm}>{`${desk.claude?.counts?.working ?? 0} working · ${u().lastHour ?? "0"} this hour`}</Text>
        </View>
        <Trace cols={66} rows={5} level={activity} every={8} step={2} active={props.active} />
      </View>
      <View class="h-[1] mx-4 bg-[#222222]" />
      <View class="flex-1 flex-row px-4 pt-2 gap-4">
        {/* hourly bars */}
        <View class="flex-col">
          <Text class={T.monoSm}>{`by hour · peak ${u().peak ?? "–"}`}</Text>
          <View class="flex-col pt-1">
            <For each={barRows()}>
              {(r) => (
                <View class="h-[10] relative">
                  <Text class="text-xs font-bold text-[#5a5a5a] leading-[10]">{r.dim}</Text>
                  <View class="absolute inset-0">
                    <Text class="text-xs font-bold leading-[10]" style={{ textColor: accent() }}>
                      {r.hot}
                    </Text>
                  </View>
                </View>
              )}
            </For>
            <Text class="text-xs font-bold text-[#5a5a5a] leading-[12]">{HOURS}</Text>
          </View>
        </View>
        {/* projects */}
        <View class="flex-1 flex-col gap-[5]">
          <Text class={T.monoSm}>{`projects · ${clip(u().model ?? "", 18)}`}</Text>
          <For each={[0, 1, 2, 3]}>
            {(i) => (
              <View class="flex-col gap-[2]">
                <View class="flex-row justify-between">
                  <Text class="text-xs font-bold text-[#ededed]">{lower(clip(u().projects?.[i]?.name ?? "·", 18))}</Text>
                  <Text class={T.monoSm}>{u().projects?.[i]?.out ?? ""}</Text>
                </View>
                <View class="w-full h-[4] rounded-[2] bg-[#1d1d1d]">
                  <View ref={(n: NodeMirror) => projBars.push(n)} class="w-full h-[4]" style={{ originX: -0.5, scaleX: 0, bgColor: accent() }} />
                </View>
              </View>
            )}
          </For>
        </View>
      </View>
    </View>
  );
}

// ---- BOARD ----------------------------------------------------------------------

const SPARK = 18;
const CW = 128;
const CH = 90;

function Spark(props: { values: () => number[]; max: number }) {
  const bars: NodeMirror[] = [];
  createEffect(
    on(props.values, (vs) => {
      // whole-pixel heights, set once (see BoardPage's runners for why)
      vs.forEach((v, i) => bars[i] && jump(bars[i]!, "scaleY", Math.max(1, Math.round(Math.min(1, v / props.max) * 22)) / 22));
    }),
  );
  return (
    <View class="h-[22] flex-row items-end gap-[2]">
      <For each={Array.from({ length: SPARK })}>
        {(_, i) => (
          <View
            ref={(n: NodeMirror) => bars.push(n)}
            class="w-[3] h-[22]"
            style={{ originY: 0.5, scaleY: 0.05, bgColor: i() === SPARK - 1 ? accent() : "#4a4a4a" }}
          />
        )}
      </For>
    </View>
  );
}

function Gauge(props: { value: () => number; size: number }) {
  let arc: NodeMirror | undefined;
  // jump, not spring: an arc's op count changes with its sweep, and the core
  // repaints the full screen whenever the DrawList's op sequence changes
  // shape — a spring would cost ~20 full-screen frames per update.
  createEffect(on(props.value, (v) => arc && jump(arc, "arcSweep", Math.max(1, Math.min(1, v) * 270))));
  return (
    <View class="relative" style={{ width: props.size, height: props.size }}>
      <View class="absolute inset-0 arc-start-[225] arc-sweep-[270] arc-width-[4] bg-[#262626]" />
      <View ref={(n: NodeMirror) => (arc = n)} class="absolute inset-0 arc-start-[225] arc-sweep-[1] arc-width-[4]" style={{ bgColor: accent() }} />
    </View>
  );
}

function BCell(props: { label: string; value: string; sub?: string; children?: any; hot?: boolean }) {
  return (
    <View class="flex-col justify-between bg-[#0a0a0a] p-2" style={{ width: CW - 1, height: CH - 1 }}>
      <View class="flex-row justify-between items-center">
        <Text class={T.eyebrow}>{props.label}</Text>
      </View>
      <View class="flex-row items-end justify-between">
        <View class="flex-col">
          <Text class="text-xl leading-[22]" style={{ textColor: props.hot ? accent() : "#ededed" }}>
            {props.value}
          </Text>
          <Text class={T.monoSm}>{props.sub ?? ""}</Text>
        </View>
        {props.children}
      </View>
    </View>
  );
}

export function BoardPage(props: { active: Active; fps: () => number }) {
  const cpu = createHistory(SPARK);
  const mem = createHistory(SPARK);
  // Sample every 2 s (deskd's sys cadence), not on change: a steady value
  // (RAM at 79%) never changes, so change-driven history stayed empty.
  let sampleAt = 0;
  onFrame(() => {
    if (++sampleAt % 120 !== 0 || !desk.sys) return;
    cpu.push(desk.sys.cpu ?? 0);
    mem.push(desk.sys.mem ?? 0);
  });
  const tab = () => desk.tablet ?? {};
  const c = () => desk.claude ?? {};
  const toolsTotal = () => ((c().sessions ?? []) as any[]).reduce((a, s) => a + (s.toolCount ?? 0), 0);
  const f = () => desk.focus ?? {};
  const m = () => desk.music ?? {};
  // a travelling accent segment on the rules — the board's heartbeat
  let runner: NodeMirror | undefined;
  let runner2: NodeMirror | undefined;
  let x = 0;
  onFrame(() => {
    if (!props.active() || !decorPhase(4)) return; // 15 Hz, shared phase
    // Whole pixels only: a fractional edge is emitted as extra AA span ops,
    // and when the op count changes the core repaints the full screen
    // (this pair of 1 px lines alone cost ~7 ms/frame at 1.6 px steps).
    x = (x + 6) % 560;
    if (runner) jump(runner, "translateX", x - 48);
    if (runner2) jump(runner2, "translateX", 512 - x);
  });
  const marks: [number, number][] = [];
  for (let i = 1; i < 4; i++) for (let j = 1; j < 3; j++) marks.push([i * CW, j * CH]);
  return (
    <View class="h-full relative overflow-hidden" style={{ width: 512 }}>
      <View class="absolute inset-0 flex-row flex-wrap bg-[#222222]" style={{ gap: 1 }}>
        <BCell label="MAC CPU" value={`${desk.sys?.cpu ?? "–"}%`} sub="2 s samples">
          <Spark values={cpu.values} max={100} />
        </BCell>
        <BCell label="MAC RAM" value={`${desk.sys?.mem ?? "–"}%`} sub="in use">
          <Spark values={mem.values} max={100} />
        </BCell>
        <BCell label="CLAUDE" value={`${c().counts?.working ?? 0} / ${(c().sessions ?? []).length}`} sub={c().counts?.waiting ? `${c().counts.waiting} need you` : "working / live"} hot={(c().counts?.waiting ?? 0) > 0}>
          <Morph size={30} layers={2} spin={() => ((c().counts?.working ?? 0) > 0 ? 3 : 0.3)} active={props.active} color={() => ((c().counts?.waiting ?? 0) > 0 ? accent() : "#363636")} />
        </BCell>
        <BCell label="TOKENS" value={desk.usage?.output ?? "–"} sub={`${toolsTotal()} tool calls`} />
        <BCell label="BATTERY" value={tab().battery !== undefined ? `${tab().battery}%` : "–"} sub={tab().charging ? "charging" : "tablet"}>
          <Gauge value={() => (tab().battery ?? 0) / 100} size={34} />
        </BCell>
        <BCell label="TAB RAM" value={tab().memFreeMb ? `${tab().memFreeMb}` : "–"} sub="mb free">
          <Gauge value={() => (tab().memFreeMb ?? 0) / (tab().memTotalMb || 1)} size={34} />
        </BCell>
        <BCell label="FOCUS" value={f().left ?? "--:--"} sub={`${f().mode ?? "idle"} · ${f().rounds ?? 0} done`} hot={f().mode === "running"}>
          <Gauge value={() => f().progress ?? 0} size={34} />
        </BCell>
        <BCell label="LINK" value={linkConnected() ? `${props.fps()}fps` : "off"} sub={tab().uptime ? `up ${tab().uptime}` : "usb"} />
        <BCell label="NOW" value={clip(lower(m().title || "silence"), 11)} sub={clip(lower(m().artist ?? ""), 16)} hot={m().state === "playing"} />
        <BCell label="CLOCK" value={desk.clock?.h !== undefined ? `${String(desk.clock.h).padStart(2, "0")}:${String(desk.clock.m).padStart(2, "0")}` : "--:--"} sub={lower(desk.clock?.date ?? "")} />
        <BCell label="CACHE" value={`${desk.usage?.cacheHit ?? 0}%`} sub="prompt cache hit">
          <Gauge value={() => (desk.usage?.cacheHit ?? 0) / 100} size={34} />
        </BCell>
        <BCell label="FAILS" value={`${((c().sessions ?? []) as any[]).reduce((a, s) => a + (s.failCount ?? 0), 0)}`} sub="tool errors" />
      </View>
      {/* travelling segments on two horizontal rules */}
      <View ref={(n: NodeMirror) => (runner = n)} class="absolute w-[48] h-[1]" style={{ insetT: CH - 1, insetL: 0, bgColor: accent() }} />
      <View ref={(n: NodeMirror) => (runner2 = n)} class="absolute w-[48] h-[1]" style={{ insetT: CH * 2 - 1, insetL: 0, bgColor: accent() }} />
      <For each={marks}>{([mx, my]) => <Mark x={mx - 1} y={my - 1} />}</For>
    </View>
  );
}

// ---- FOCUS ----------------------------------------------------------------------

export function FocusPage(props: { active: Active }) {
  const f = () => desk.focus ?? { mode: "idle", left: "--:--", progress: 0, total: 25, rounds: 0 };
  const running = () => f().mode === "running";
  let ring: NodeMirror | undefined;
  let shown = -1;
  onFrame(() => {
    if (!props.active() || !ring) return;
    const want = (1 - (f().progress ?? 0)) * 360;
    // Each arc update is a full-screen repaint (see Gauge), so step the ring
    // in 2° jumps (every ~8 s of a 25 min round) instead of springing per tick.
    if (Math.abs(want - shown) >= 2 || (want >= 359.5 && shown < 359.5)) {
      shown = want;
      jump(ring, "arcSweep", Math.max(0.5, want));
    }
  });
  const label = () => ({ idle: "ready", running: "focus", paused: "paused", done: "break time" })[f().mode as string] ?? "focus";
  return (
    <View class="h-full flex-row items-center gap-4 px-4" style={{ width: 512 }}>
      <View class="relative items-center justify-center" style={{ width: 236, height: 236 }}>
        <View class="absolute inset-0 arc-start-[0] arc-sweep-[360] arc-width-[3] bg-[#1d1d1d]" />
        <View ref={(n: NodeMirror) => (ring = n)} class="absolute inset-0 arc-start-[0] arc-sweep-[360] arc-width-[3]" style={{ bgColor: accent() }} />
        <Morph
          size={172}
          layers={4}
          morph={() => (f().mode === "idle" ? 0 : 0.15 + (f().progress ?? 0) * 0.85)}
          // A 196 px shape costs ~10+ ms to re-raster, so it holds still while
          // idle/running (it still fans out with progress) and only turns at
          // break time.
          spin={() => (f().mode === "done" ? 0.8 : 0)}
          breathe={() => (f().mode === "done" ? 0.05 : f().mode === "paused" ? 0.02 : 0)}
          active={props.active}
        >
          <Text class="text-4xl leading-[40]" style={{ textColor: ON_ACCENT }}>
            {f().left}
          </Text>
          <Text class="text-xs font-bold" style={{ textColor: ON_ACCENT }}>
            {label()}
          </Text>
        </Morph>
      </View>
      <View class="flex-1 flex-col gap-3">
        <View class="flex-col">
          <Text class={T.eyebrow}>FOCUS TIMER</Text>
          <Text class="text-2xl text-[#ededed]">{`${f().total ?? 25} minute round`}</Text>
          <Text class={T.monoSm}>the shape fans out as the time runs down</Text>
        </View>
        <View class="h-[44] rounded-[999] items-center justify-center" style={{ bgColor: accent() }} focusable onPress={() => act("focus.toggle")}>
          <Text class="text-base" style={{ textColor: ON_ACCENT }}>
            {running() ? "pause" : f().mode === "paused" ? "resume" : "start"}
          </Text>
        </View>
        <View class="flex-row gap-2">
          <View class="flex-1 h-[34] rounded-[999] border border-[#363636] items-center justify-center active:bg-[#1d1d1d]" style={{ basis: 0 }} focusable onPress={() => act("focus.add")}>
            <Text class="text-sm text-[#ededed]">+5 min</Text>
          </View>
          <View class="flex-1 h-[34] rounded-[999] border border-[#363636] items-center justify-center active:bg-[#1d1d1d]" style={{ basis: 0 }} focusable onPress={() => act("focus.reset")}>
            <Text class="text-sm text-[#ededed]">reset</Text>
          </View>
        </View>
        <View class="flex-row gap-2">
          <For each={[15, 25, 50]}>
            {(min) => (
              <View class="flex-1 h-[28] rounded-[10] bg-[#141414] border border-[#222222] items-center justify-center active:bg-[#1d1d1d]" style={{ basis: 0 }} focusable onPress={() => act("focus.start", { min })}>
                <Text class={T.mono}>{`${min}m`}</Text>
              </View>
            )}
          </For>
        </View>
        <View class="flex-row items-center gap-2">
          <Text class={T.monoSm}>today</Text>
          <For each={[0, 1, 2, 3, 4, 5, 6, 7]}>
            {(i) => <View class="w-[10] h-[10] rounded-[3]" style={{ bgColor: i < (f().rounds ?? 0) ? accent() : "#262626" }} />}
          </For>
        </View>
      </View>
    </View>
  );
}
