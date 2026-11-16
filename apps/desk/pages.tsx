// The five Desk panes, built from g8row.xyz's components: the hero (lowercase
// display type over the ASCII ridge field, a stats row of ruled cells), small
// project cards, the centuryplay player (device rows + the wave), spec tables
// and the frame-time graph. Every pane keeps something moving — and pauses
// all of it while it's off screen.

import { For, Show, createMemo, createSignal } from "solid-js";
import { Image, Text, View, type NodeMirror } from "@pocketjs/framework/components";
import { onFrame } from "@pocketjs/framework/lifecycle";
import { createJumpBatch, jump, spring } from "@pocketjs/framework/animation";
import { act, blobSrc, desk, linkConnected } from "./link.ts";
import { Ridges } from "./ridges.tsx";
import { T, TILE_HEX, accent } from "./theme.ts";
import { DECOR_STEP, decorFrame, decorPhase, minVisibleDeg } from "./clock.ts";

type Active = () => boolean;
const pad2 = (n: number) => (n < 10 ? `0${n}` : `${n}`);
const clip = (s: unknown, n: number): string => {
  const str = typeof s === "string" ? s : "";
  return str.length > n ? `${str.slice(0, n - 1)}…` : str;
};
const mmss = (s: number) => `${Math.floor(s / 60)}:${pad2(Math.floor(s % 60))}`;
const lower = (s: unknown) => (typeof s === "string" ? s.toLowerCase() : "");

/** Frames per second the guest actually gets (1 s window) + last frame gaps. */
export function createFrameStats() {
  const [fps, setFps] = createSignal(60);
  const gaps: number[] = new Array(40).fill(16.7);
  let n = 0;
  let t0 = Date.now();
  let last = Date.now();
  onFrame(() => {
    const now = Date.now();
    gaps.push(now - last);
    gaps.shift();
    last = now;
    n++;
    if (now - t0 >= 1000) {
      // clamp: 59/60/61 jitter would re-render (and relayout) every
      // fps label once a second for nothing
      setFps(Math.min(60, Math.round((n * 1000) / (now - t0))));
      n = 0;
      t0 = now;
    }
  });
  return { fps, gaps };
}

/** The site's Material-3 "cookie" mark: two rounded squares at 45°, spinning. */
export function Cookie(props: { size: number; speed?: number; active?: Active; dim?: boolean }) {
  const nodes: NodeMirror[] = [];
  let angle = 0;
  let drawn = -999;
  let batch: ReturnType<typeof createJumpBatch> | undefined;
  onFrame(() => {
    if (props.active && !props.active()) return;
    if (!batch && nodes.length === 2) batch = createJumpBatch(nodes.map((n) => [n, "rotate"] as const));
    if (!batch || !decorFrame()) return;
    angle = (angle + (props.speed ?? 0.5) * DECOR_STEP) % 360;
    // repaint only once the pose moved visibly (slow spins are 0.4–0.8°/frame)
    if (Math.abs(angle - drawn) < minVisibleDeg(props.size)) return;
    drawn = angle;
    batch.set(0, angle);
    batch.set(1, angle + 45);
    batch.commit();
  });
  const s = () => props.size * 0.74;
  const cls = () => "absolute";
  return (
    <View class="relative items-center justify-center" style={{ width: props.size, height: props.size }}>
      <View ref={(n: NodeMirror) => nodes.push(n)} class={cls()} style={{ width: s(), height: s(), radius: props.size * 0.24, bgColor: props.dim ? "#363636" : accent() }} />
      <View ref={(n: NodeMirror) => nodes.push(n)} class={cls()} style={{ width: s(), height: s(), radius: props.size * 0.24, bgColor: props.dim ? "#363636" : accent() }} />
    </View>
  );
}

/** One stats cell: tiny lowercase mono label over a sans value. */
function Cell(props: { label: string; value: string; accent?: boolean }) {
  return (
    <View class="flex-1 flex-col justify-center gap-1 px-3" style={{ basis: 0 }}>
      <Text class={T.monoSm}>{props.label}</Text>
      <Text class="text-base" style={{ textColor: props.accent ? accent() : "#ededed" }}>{props.value}</Text>
    </View>
  );
}

// ---- 1. home: the hero ----------------------------------------------------------------

const DAYS = ["sunday", "monday", "tuesday", "wednesday", "thursday", "friday", "saturday"];

export function HomePage(props: { active: Active; fps: () => number }) {
  const clock = () => desk.clock ?? {};
  const m = () => desk.music ?? {};
  const tab = () => desk.tablet ?? {};
  const sessions = () => desk.claude?.sessions ?? [];
  const waiting = () => sessions().filter((s: any) => s.state === "waiting").length;
  const day = () => {
    const d = lower(clock().date).split(" ");
    const full = DAYS.find((x) => x.startsWith(d[0] ?? "~")) ?? d[0] ?? "";
    return { day: full, date: d.slice(1).join(" ") };
  };
  return (
    <View class="h-full flex-col" style={{ width: 512 }}>
      <View class="flex-1 flex-col relative">
        {/* the ridge field sits behind the type, right-aligned like the site */}
        <View class="absolute flex-row justify-end" style={{ insetT: 4, insetR: 6, insetL: 160, insetB: 0 }}>
          <Ridges cols={42} rows={20} ridges={9} every={8} active={props.active} />
        </View>
        <View class="flex-row justify-between px-4 pt-3">
          <Text class={T.monoSm}>desk companion at your mac</Text>
          <Text class={T.monoSm}>{`android · pocketjs · ${props.fps()}fps`}</Text>
        </View>
        <View class="flex-col px-4 pt-3">
          <Text class="text-4xl leading-[38]" style={{ textColor: accent() }}>{clock().h !== undefined ? `${pad2(clock().h)}:${pad2(clock().m)}` : "--:--"}</Text>
          <Text class={T.display}>{day().day || "today"}</Text>
          <Text class={T.display}>{day().date}</Text>
        </View>
        <View class="flex-row px-4 pt-3">
          <Text class={T.body}>{waiting() > 0 ? "claude is waiting for you." : "everything at your desk, one tap away."}</Text>
        </View>
      </View>
      <View class={T.rule} />
      <View class="h-[54] flex-row">
        <Cell label="now" value={m().title ? clip(lower(m().title), 16) : "silence"} accent={m().state === "playing"} />
        <View class={T.vrule} />
        <Cell label="claude" value={waiting() > 0 ? `${waiting()} waiting` : `${sessions().length} ${sessions().length === 1 ? "session" : "sessions"}`} accent={waiting() > 0} />
        <View class={T.vrule} />
        <Cell label="mac" value={desk.sys?.cpu !== undefined ? `${desk.sys.cpu}% cpu` : "–"} />
        <View class={T.vrule} />
        <Cell label="tablet" value={tab().battery !== undefined ? `${tab().battery}%${tab().charging ? " ↑" : ""}` : linkConnected() ? "linked" : "offline"} />
      </View>
    </View>
  );
}

// ---- 2. deck: small project cards (tiles come from desk.config.json) -------------

function Tile(props: { t: any; active: Active; compact: boolean }) {
  let card: NodeMirror | undefined;
  let mark: NodeMirror | undefined;
  let a = Math.random() * 90;
  onFrame(() => {
    if (!props.active() || !mark || !decorFrame()) return;
    a = (a + 0.5 * DECOR_STEP) % 360;
    // a 9 px mark: 2° steps at 15 Hz look the same and repaint 4× less;
    // all tiles step on the same global phase → one posted frame
    if (decorPhase(4)) jump(mark, "rotate", a);
  });
  const press = () => {
    if (card) {
      jump(card, "scale", 0.93);
      spring(card, "scale", 1);
    }
    act(props.t.id);
  };
  const hot = () => props.t.sub === "MUTED";
  return (
    <View
      ref={(n: NodeMirror) => (card = n)}
      class="flex-1 h-full flex-col justify-between rounded-[18] bg-gradient-to-b from-[#161616] to-[#101010] border border-[#222222] p-3 active:border-[#5a5a5a]"
      style={{ basis: 0 }}
      focusable
      onPress={press}
    >
      <View class="flex-row items-center justify-between">
        <Text class="text-base text-[#ededed]">{lower(clip(props.t.label, 12))}</Text>
        <View ref={(n: NodeMirror) => (mark = n)} class="w-[9] h-[9] rounded-[3]" style={{ bgColor: TILE_HEX[props.t.color] ?? "#8a8a8a" }} />
      </View>
      <Show when={!props.compact}>
        <Text class={T.monoSm}>{lower(clip(props.t.sub || props.t.kind || "action", 18))}</Text>
      </Show>
      <View class="flex-row">
        <View class={hot() ? T.chipA : T.chipO}>
          <Text class="text-xs font-bold" style={{ textColor: hot() ? accent() : "#8a8a8a" }}>
            {props.compact ? lower(clip(props.t.sub || props.t.kind, 14)) : lower(props.t.kind ?? "action")}
          </Text>
        </View>
      </View>
    </View>
  );
}

export function DeckPage(props: { active: Active }) {
  const tiles = createMemo<any[]>(() => (desk.deck?.tiles ?? []).slice(0, 12));
  const rows = createMemo(() => Math.max(1, Math.ceil(tiles().length / 3)));
  const row = (i: number) => tiles().slice(i * 3, i * 3 + 3);
  return (
    <View class="h-full flex-col gap-2 p-3" style={{ width: 512 }}>
      <For each={[0, 1, 2, 3]}>
        {(r) => (
          <Show when={r < rows()}>
            <View class="flex-row gap-2 flex-1">
              <For each={row(r)}>{(t) => <Tile t={t} active={props.active} compact={rows() > 2} />}</For>
              <For each={Array.from({ length: 3 - row(r).length })}>{() => <View class="flex-1" style={{ basis: 0 }} />}</For>
            </View>
          </Show>
        )}
      </For>
    </View>
  );
}

// ---- 3. music: the centuryplay card + wave ----------------------------------------------

const WAVE_N = 46;

export function MusicPage(props: { active: Active }) {
  const m = () => desk.music ?? {};
  const playing = () => m().state === "playing";
  const art = () => blobSrc("music.art");
  let basePos = 0;
  let baseAt = 0;
  const [pos, setPos] = createSignal(0);
  const dots: NodeMirror[] = [];
  let batch: ReturnType<typeof createJumpBatch> | undefined;
  let phase = 0;
  let amp = 0;
  onFrame(() => {
    if (!props.active() || !decorFrame()) return;
    const p = m().position ?? 0;
    if (p !== basePos) {
      basePos = p;
      baseAt = Date.now();
    }
    setPos(playing() ? basePos + (Date.now() - baseAt) / 1000 : basePos);
    // the centuryplay wave: a travelling sine that flattens when paused
    amp += ((playing() ? 4 : 0.4) - amp) * 0.16;
    phase += 0.09 * DECOR_STEP;
    if (!batch && dots.length === WAVE_N) batch = createJumpBatch(dots.map((d) => [d, "translateY"] as const));
    if (batch) {
      // whole pixels: fractional offsets add AA span ops, and an op-count
      // change makes the core repaint the full screen
      for (let i = 0; i < WAVE_N; i++) batch.set(i, Math.round(Math.sin(i * 0.55 - phase) * amp));
      batch.commit();
    }
  });
  const progress = () => (m().duration > 0 ? Math.min(1, pos() / m().duration) : 0);
  const playedDots = () => Math.round(progress() * WAVE_N);
  return (
    <View class="h-full flex-row gap-3 p-3" style={{ width: 512 }}>
      <View class="relative items-center justify-center" style={{ width: 196 }}>
        <Show when={art() !== ""} fallback={<Cookie size={120} speed={playing() ? 1.2 : 0.25} active={props.active} />}>
          <Image class="w-[188] h-[188] rounded-[18]" src={art()} />
        </Show>
      </View>
      <View class="rounded-[18] bg-gradient-to-b from-[#161616] to-[#101010] border border-[#222222] overflow-hidden flex-1 flex-col justify-between p-3">
        <View class="flex-row items-center justify-between">
          <View class="flex-row items-center gap-2">
            <Cookie size={18} speed={playing() ? 2 : 0.2} active={props.active} />
            <Text class="text-lg text-[#ededed]">{playing() ? "now playing" : m().state === "paused" ? "paused" : "music"}</Text>
          </View>
          <Text class={T.monoSm}>on mac</Text>
        </View>
        <View class="rounded-[14] bg-[#1d1d1d] border flex-col gap-1 p-3" style={{ borderColor: accent() }}>
          <View class="flex-row items-center gap-2">
            <View class="w-[26] h-[26] rounded-[8] bg-[#141414] items-center justify-center">
              <Cookie size={14} speed={playing() ? 2.5 : 0} active={props.active} />
            </View>
            <View class="flex-1 flex-col">
              <Text class="text-base text-[#ededed]">{lower(clip(m().title || "nothing playing", 26))}</Text>
              <Text class={T.monoSm}>{lower(clip([m().artist, m().album].filter(Boolean).join(" · "), 34))}</Text>
            </View>
          </View>
          <View class="flex-row items-center h-[18] gap-[1]">
            <For each={Array.from({ length: WAVE_N }, (_, i) => i)}>
              {(i) => (
                <View
                  ref={(n: NodeMirror) => dots.push(n)}
                  class="w-[4] h-[2] rounded-[1]"
                  style={{ bgColor: i < playedDots() ? accent() : "#363636" }}
                />
              )}
            </For>
          </View>
          <View class="flex-row justify-between">
            <Text class={T.monoSm}>{mmss(pos())}</Text>
            <Text class={T.monoSm}>{m().duration ? mmss(m().duration) : "--:--"}</Text>
          </View>
        </View>
        <View class="flex-row gap-2">
          <View class="flex-1 h-[34] rounded-[999] border border-[#363636] items-center justify-center active:bg-[#1d1d1d]" style={{ basis: 0 }} focusable onPress={() => act("music.prev")}>
            <Text class="text-sm text-[#ededed]">prev</Text>
          </View>
          <View class="flex-1 h-[34] rounded-[999] items-center justify-center" style={{ basis: 0, bgColor: accent() }} focusable onPress={() => act("music.toggle")}>
            <Text class="text-sm text-[#0b1d33]">{playing() ? "pause" : "play"}</Text>
          </View>
          <View class="flex-1 h-[34] rounded-[999] border border-[#363636] items-center justify-center active:bg-[#1d1d1d]" style={{ basis: 0 }} focusable onPress={() => act("music.next")}>
            <Text class="text-sm text-[#ededed]">next</Text>
          </View>
        </View>
      </View>
    </View>
  );
}

// ---- 5. system: frame-time graph + spec table --------------------------------------------

const BARS = 40;

function SpecRow(props: { k: string; v: string }) {
  return (
    <View class="flex-col">
      <View class="flex-row justify-between py-[5]">
        <Text class={T.monoSm}>{props.k}</Text>
        <Text class="text-sm text-[#b3b3b3]">{props.v}</Text>
      </View>
      <View class={T.rule} />
    </View>
  );
}

export function SystemPage(props: { active: Active; fps: () => number; gaps: number[] }) {
  const bars: NodeMirror[] = [];
  let batch: ReturnType<typeof createJumpBatch> | undefined;
  onFrame(() => {
    if (!props.active()) return;
    if (!batch && bars.length === BARS) batch = createJumpBatch(bars.map((b) => [b, "scaleY"] as const));
    if (!batch) return;
    // 15 Hz is plenty for a frame-time graph, and each update re-rasters
    // the whole plot (it was ~10 ms/frame at 60 Hz)
    if (!decorPhase(4)) return;
    // bar height ∝ frame time; the dashed line marks the 16.7 ms budget (60 Hz)
    for (let i = 0; i < BARS; i++) batch.set(i, Math.max(0.04, Math.min(1, (props.gaps[i] ?? 16.7) / 33.4)));
    batch.commit();
  });
  const tab = () => desk.tablet ?? {};
  return (
    <View class="h-full flex-row gap-3 p-3" style={{ width: 512 }}>
      <View class="rounded-[18] bg-gradient-to-b from-[#161616] to-[#101010] border border-[#222222] overflow-hidden flex-1 flex-col justify-between p-3">
        <View class="flex-row justify-between">
          <Text class={T.monoSm}>desk · 60 hz</Text>
          <Text class={T.monoSm}>pocketjs · software</Text>
        </View>
        <View class="flex-1 flex-col justify-end">
          <View class="relative w-full h-[148] flex-row items-end justify-between">
            <For each={Array.from({ length: BARS })}>
              {() => <View ref={(n: NodeMirror) => bars.push(n)} class="w-[3] h-[148] bg-[#5a5a5a]" style={{ originY: 0.5 }} />}
            </For>
            {/* budget line at 16.7 ms = half the 33.4 ms scale */}
            <View class="absolute flex-row justify-between" style={{ insetL: 0, insetR: 0, insetB: 74 }}>
              <For each={Array.from({ length: 34 })}>{() => <View class="w-[3] h-[1]" style={{ bgColor: accent() }} />}</For>
            </View>
            <View class="absolute" style={{ insetL: 0, insetB: 78 }}>
              <Text class="text-xs font-bold" style={{ textColor: accent() }}>16.7 ms</Text>
            </View>
          </View>
        </View>
        <View class="flex-row justify-between pt-2">
          <Text class={T.monoSm}>frame time</Text>
          <Text class="text-xs font-bold" style={{ textColor: accent() }}>{`${props.fps()} fps`}</Text>
        </View>
      </View>
      <View class="flex-col justify-between" style={{ width: 196 }}>
        <View class="flex-row items-center gap-3 pb-1 pl-1">
          <Cookie size={20} speed={0.6} active={props.active} />
          <View class="flex-col">
            <Text class="text-lg text-[#ededed]">tb-7304x</Text>
            <Text class={T.monoSm}>{`${tab().mode ?? "android"} · rooted · stripped`}</Text>
          </View>
        </View>
        <View class="flex-col">
          <View class={T.rule} />
          <SpecRow k="soc" v="mt6737m · 4×a53" />
          <SpecRow k="cpu" v={tab().cpuMhz ? `${tab().cpuMhz} mhz` : "–"} />
          <SpecRow k="ram free" v={tab().memFreeMb ? `${tab().memFreeMb} / ${tab().memTotalMb} mb` : "–"} />
          <SpecRow k="battery" v={tab().battery !== undefined ? `${tab().battery}%${tab().charging ? " · charging" : ""}` : "–"} />
          <SpecRow k="uptime" v={tab().uptime ?? "–"} />
          <SpecRow k="mac" v={desk.sys ? `${desk.sys.cpu}% cpu · ${desk.sys.mem}% ram` : "–"} />
        </View>
      </View>
    </View>
  );
}
