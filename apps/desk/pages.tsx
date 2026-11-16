// The five Desk panes. Visual language from g8row.xyz: near-black ground,
// #141414 containers with 1px #222 rules, mono uppercase eyebrows, one accent
// (#a8c7fa), and always-on motion that proves the frame rate.

import { For, Show, createMemo, createSignal } from "solid-js";
import { Image, Text, View, type NodeMirror } from "@pocketjs/framework/components";
import { onFrame } from "@pocketjs/framework/lifecycle";
import { createJumpBatch, jump } from "@pocketjs/framework/animation";
import { act, blobSrc, desk } from "./link.ts";
import { Ridges } from "./ridges.tsx";
import { T } from "./theme.ts";

const pad2 = (n: number) => (n < 10 ? `0${n}` : `${n}`);
const clip = (s: unknown, n: number): string => {
  const str = typeof s === "string" ? s : "";
  return str.length > n ? `${str.slice(0, n - 1)}…` : str;
};
const mmss = (s: number) => `${Math.floor(s / 60)}:${pad2(Math.floor(s % 60))}`;

/** Frames per second as the guest actually sees them (1 s window). */
export function createFps() {
  const [fps, setFps] = createSignal(60);
  let n = 0;
  let t0 = Date.now();
  onFrame(() => {
    n++;
    const now = Date.now();
    if (now - t0 >= 1000) {
      setFps(Math.round((n * 1000) / (now - t0)));
      n = 0;
      t0 = now;
    }
  });
  return fps;
}

/** A Material-3-expressive "cookie": stacked rounded squares, spinning forever. */
export function Cookie(props: { size: number; speed?: number; active?: () => boolean }) {
  const nodes: NodeMirror[] = [];
  let angle = 0;
  const speed = props.speed ?? 0.6;
  let batch: ReturnType<typeof createJumpBatch> | undefined;
  onFrame(() => {
    if (props.active && !props.active()) return;
    if (!batch && nodes.length === 3) batch = createJumpBatch(nodes.map((n) => [n, "rotate"] as const));
    if (!batch) return;
    angle = (angle + speed) % 360;
    batch.set(0, angle);
    batch.set(1, angle + 30);
    batch.set(2, -angle * 1.5 + 60);
    batch.commit();
  });
  return (
    <View class="relative items-center justify-center" style={{ width: props.size, height: props.size }}>
      <View ref={(n: NodeMirror) => nodes.push(n)} class="absolute rounded-[16] bg-[#1d1d1d] border border-[#363636]" style={{ width: props.size * 0.72, height: props.size * 0.72 }} />
      <View ref={(n: NodeMirror) => nodes.push(n)} class="absolute rounded-[16] bg-[#141414] border border-[#363636]" style={{ width: props.size * 0.72, height: props.size * 0.72 }} />
      <View ref={(n: NodeMirror) => nodes.push(n)} class="absolute rounded-[10] bg-[#a8c7fa]" style={{ width: props.size * 0.22, height: props.size * 0.22 }} />
    </View>
  );
}

// ---- 1. home ------------------------------------------------------------------

export function HomePage(props: { active: () => boolean }) {
  const clock = () => desk.clock ?? {};
  const m = () => desk.music ?? {};
  const sessions = () => desk.claude?.sessions ?? [];
  const waiting = () => sessions().filter((s: any) => s.state === "waiting").length;
  return (
    <View class="h-full flex-row" style={{ width: 512 }}>
      <View class="flex-col justify-between p-4" style={{ width: 210 }}>
        <View class="flex-col gap-1">
          <Text class={T.eyebrow}>{clip(clock().date, 22).toUpperCase()}</Text>
          <Text class={T.hero}>{clock().h !== undefined ? `${pad2(clock().h)}:${pad2(clock().m)}` : "--:--"}</Text>
        </View>
        <View class="flex-col gap-2">
          <View class="flex-row items-center gap-2">
            <View class={m().state === "playing" ? "w-2 h-2 rounded-full bg-[#a8c7fa]" : "w-2 h-2 rounded-full bg-[#363636]"} />
            <Text class={T.body}>{m().title ? clip(`${m().title} — ${m().artist ?? ""}`, 26) : "nothing playing"}</Text>
          </View>
          <View class="flex-row items-center gap-2">
            <View class={waiting() > 0 ? "w-2 h-2 rounded-full bg-[#fbbf24]" : "w-2 h-2 rounded-full bg-[#363636]"} />
            <Text class={T.body}>
              {waiting() > 0 ? `claude needs you (${waiting()})` : `${sessions().length} claude sessions`}
            </Text>
          </View>
        </View>
      </View>
      <View class="flex-1 h-full items-center justify-center overflow-hidden">
        <Ridges cols={38} rows={20} ridges={9} every={3} active={props.active} />
      </View>
    </View>
  );
}

// ---- 2. deck ------------------------------------------------------------------

const TILE_ACCENT: Record<string, string> = {
  rose: "w-2 h-2 rounded-full bg-[#fb7185]",
  blue: "w-2 h-2 rounded-full bg-[#a8c7fa]",
  amber: "w-2 h-2 rounded-full bg-[#fbbf24]",
  emerald: "w-2 h-2 rounded-full bg-[#6ee7b7]",
  violet: "w-2 h-2 rounded-full bg-[#c4b5fd]",
  zinc: "w-2 h-2 rounded-full bg-[#8a8a8a]",
};

export function DeckPage() {
  const tiles = createMemo<any[]>(() => (desk.deck?.tiles ?? []).slice(0, 6));
  const row = (i: number) => tiles().slice(i * 3, i * 3 + 3);
  return (
    <View class="h-full flex-col gap-2 p-3" style={{ width: 512 }}>
      <For each={[0, 1]}>
        {(r) => (
          <View class="flex-row gap-2 flex-1">
            <For each={row(r)}>
              {(t) => (
                <View
                  class="flex-1 h-full flex-col justify-between rounded-[18] bg-[#141414] border border-[#222222] p-3 active:bg-[#1d1d1d] active:border-[#a8c7fa] focus:border-[#363636]"
                  style={{ basis: 0 }}
                  focusable
                  onPress={() => act(t.id)}
                >
                  <View class="flex-row items-center justify-between">
                    <View class={TILE_ACCENT[t.color] ?? TILE_ACCENT.zinc} />
                    <Text class={T.monoSm}>{clip(t.id.split(".")[0], 10).toUpperCase()}</Text>
                  </View>
                  <View class="flex-col">
                    <Text class={T.title}>{clip(t.label, 12)}</Text>
                    <Text class={T.monoSm}>{clip(t.sub ?? "", 14)}</Text>
                  </View>
                </View>
              )}
            </For>
          </View>
        )}
      </For>
    </View>
  );
}

// ---- 3. music -----------------------------------------------------------------

export function MusicPage(props: { active: () => boolean }) {
  const m = () => desk.music ?? {};
  const playing = () => m().state === "playing";
  const art = () => blobSrc("music.art");
  // Locally interpolated position so the bar glides between 1 s updates.
  let basePos = 0;
  let baseAt = 0;
  const [pos, setPos] = createSignal(0);
  const bars: NodeMirror[] = [];
  let batch: ReturnType<typeof createJumpBatch> | undefined;
  let f = 0;
  onFrame(() => {
    if (!props.active()) return;
    f++;
    const p = m().position ?? 0;
    if (p !== basePos) {
      basePos = p;
      baseAt = Date.now();
    }
    const live = playing() ? basePos + (Date.now() - baseAt) / 1000 : basePos;
    setPos(live);
    if (!batch && bars.length === 24) batch = createJumpBatch(bars.map((b) => [b, "scaleY"] as const));
    if (batch) {
      for (let i = 0; i < 24; i++) {
        const v = playing()
          ? 0.25 + 0.75 * Math.abs(Math.sin(f * 0.07 + i * 0.6) * Math.sin(f * 0.031 + i * 1.3))
          : 0.08;
        batch.set(i, v);
      }
      batch.commit();
    }
  });
  const progress = () => (m().duration > 0 ? Math.min(1, pos() / m().duration) : 0);
  return (
    <View class="h-full flex-row gap-4 p-4 items-center" style={{ width: 512 }}>
      <View class="relative items-center justify-center" style={{ width: 168, height: 168 }}>
        <Show when={art() !== ""} fallback={<Cookie size={150} speed={playing() ? 1.2 : 0.2} active={props.active} />}>
          <Image class="w-[160] h-[160] rounded-[18]" src={art()} />
        </Show>
      </View>
      <View class="flex-1 h-full flex-col justify-between">
        <View class="flex-col gap-1">
          <Text class={T.eyebrowAccent}>{playing() ? "NOW PLAYING" : m().state === "paused" ? "PAUSED" : "MUSIC"}</Text>
          <Text class="text-2xl text-[#ffffff]">{clip(m().title || "Nothing playing", 20)}</Text>
          <Text class={T.body}>{clip(m().artist, 28)}</Text>
          <Text class={T.monoSm}>{clip(m().album, 30)}</Text>
        </View>
        <View class="flex-row items-end gap-1 h-[40]">
          <For each={Array.from({ length: 24 })}>
            {() => (
              <View ref={(n: NodeMirror) => bars.push(n)} class="w-[6] h-[40] rounded-[2] bg-[#a8c7fa]" style={{ originY: 0.5 }} />
            )}
          </For>
        </View>
        <View class="flex-col gap-1">
          <View class="h-[3] w-full rounded-[2] bg-[#222222]">
            {/* scaleX (paint-only) instead of width: no relayout per frame */}
            <View class="h-[3] w-full rounded-[2] bg-[#a8c7fa]" style={{ originX: -0.5, scaleX: Math.max(0.001, progress()) }} />
          </View>
          <View class="flex-row justify-between">
            <Text class={T.monoSm}>{mmss(pos())}</Text>
            <Text class={T.monoSm}>{m().duration ? mmss(m().duration) : "--:--"}</Text>
          </View>
        </View>
        <View class="flex-row gap-2">
          <View class="flex-1 h-[40] rounded-[999] border border-[#363636] items-center justify-center active:bg-[#1d1d1d]" style={{ basis: 0 }} focusable onPress={() => act("music.prev")}>
            <Text class="text-sm text-[#ededed]">◀◀</Text>
          </View>
          <View class="flex-1 h-[40] rounded-[999] bg-[#a8c7fa] items-center justify-center active:bg-[#7fa7e8]" style={{ basis: 0 }} focusable onPress={() => act("music.toggle")}>
            <Text class="text-sm text-[#0b1d33]">{playing() ? "| |" : "▶"}</Text>
          </View>
          <View class="flex-1 h-[40] rounded-[999] border border-[#363636] items-center justify-center active:bg-[#1d1d1d]" style={{ basis: 0 }} focusable onPress={() => act("music.next")}>
            <Text class="text-sm text-[#ededed]">▶▶</Text>
          </View>
        </View>
      </View>
    </View>
  );
}

// ---- 4. claude ----------------------------------------------------------------

const PILL: Record<string, string> = {
  working: "px-2 rounded-[999] bg-[#a8c7fa1f]",
  waiting: "px-2 rounded-[999] bg-[#fbbf2433]",
  done: "px-2 rounded-[999] bg-[#6ee7b71f]",
  idle: "px-2 rounded-[999] bg-[#1d1d1d]",
};
const PILL_TEXT: Record<string, string> = {
  working: "text-xs font-bold text-[#a8c7fa]",
  waiting: "text-xs font-bold text-[#fbbf24]",
  done: "text-xs font-bold text-[#6ee7b7]",
  idle: "text-xs font-bold text-[#8a8a8a]",
};
const LABEL: Record<string, string> = { working: "WORKING", waiting: "NEEDS YOU", done: "DONE", idle: "IDLE" };

export function ClaudePage(props: { active: () => boolean }) {
  const sessions = createMemo<any[]>(() => (desk.claude?.sessions ?? []).slice(0, 4));
  const dots: NodeMirror[] = [];
  let f = 0;
  onFrame(() => {
    if (!props.active()) return;
    f++;
    const a = 0.35 + 0.65 * (0.5 + 0.5 * Math.sin(f * 0.12));
    for (const d of dots) jump(d, "opacity", a);
  });
  return (
    <View class="h-full flex-col gap-2 p-3" style={{ width: 512 }}>
      <View class="flex-row items-center justify-between px-1">
        <Text class={T.eyebrow}>CLAUDE CODE</Text>
        <Text class={T.monoSm}>
          {desk.claude?.hooks === false ? "hooks not installed" : `${desk.claude?.sessions?.length ?? 0} sessions`}
        </Text>
      </View>
      <For
        each={sessions()}
        fallback={
          <View class="flex-1 items-center justify-center gap-3">
            <Cookie size={64} speed={0.4} active={props.active} />
            <Text class={T.body}>no active sessions</Text>
          </View>
        }
      >
        {(s) => (
          <View class="flex-row items-center gap-3 rounded-[18] bg-[#141414] border border-[#222222] px-3 py-2">
            <Show
              when={s.state === "working"}
              fallback={<View class={s.state === "waiting" ? "w-2 h-2 rounded-full bg-[#fbbf24]" : "w-2 h-2 rounded-full bg-[#363636]"} />}
            >
              <View ref={(n: NodeMirror) => dots.push(n)} class="w-2 h-2 rounded-full bg-[#a8c7fa]" />
            </Show>
            <View class="flex-1 flex-col">
              <Text class="text-base text-[#ededed]">{clip(s.name, 28)}</Text>
              <Text class={T.monoSm}>{clip(s.detail, 52)}</Text>
            </View>
            <View class="flex-col items-end gap-1">
              <View class={PILL[s.state] ?? PILL.idle}>
                <Text class={PILL_TEXT[s.state] ?? PILL_TEXT.idle}>{LABEL[s.state] ?? s.state}</Text>
              </View>
              <Text class={T.monoSm}>{s.ago ?? ""}</Text>
            </View>
          </View>
        )}
      </For>
    </View>
  );
}

// ---- 5. system ----------------------------------------------------------------

function Gauge(props: { label: string; value: () => number | undefined; unit?: string; active: () => boolean }) {
  let arc: NodeMirror | undefined;
  let shown = 0;
  onFrame(() => {
    if (!props.active()) return;
    const v = props.value() ?? 0;
    shown += (v - shown) * 0.12; // ease toward the live value every frame
    if (arc) jump(arc, "arcSweep", Math.max(0.5, shown * 2.7));
  });
  return (
    <View class="flex-1 h-full rounded-[18] bg-[#141414] border border-[#222222] items-center justify-center" style={{ basis: 0 }}>
      <View class="relative items-center justify-center" style={{ width: 112, height: 112 }}>
        <View class="absolute w-[112] h-[112] arc-start-[225] arc-sweep-[270] arc-width-[6] bg-[#222222]" />
        <View ref={(n: NodeMirror) => (arc = n)} class="absolute w-[112] h-[112] arc-start-[225] arc-sweep-[1] arc-width-[6] bg-[#a8c7fa]" />
        <View class="flex-col items-center">
          <Text class="text-2xl font-bold text-[#ededed]">{props.value() !== undefined ? `${props.value()}` : "–"}</Text>
          <Text class={T.eyebrow}>{props.label}</Text>
        </View>
      </View>
    </View>
  );
}

export function SystemPage(props: { fps: () => number; active: () => boolean }) {
  const history: number[] = [];
  const [hist, setHist] = createSignal<number[]>([]);
  let lastCpu: number | undefined;
  onFrame(() => {
    const c = desk.sys?.cpu;
    if (c !== undefined && c !== lastCpu) {
      lastCpu = c;
      history.push(c);
      if (history.length > 28) history.shift();
      setHist([...history]);
    }
  });
  return (
    <View class="h-full flex-row gap-2 p-3" style={{ width: 512 }}>
      <Gauge label="MAC CPU %" value={() => desk.sys?.cpu} active={props.active} />
      <Gauge label="MAC RAM %" value={() => desk.sys?.mem} active={props.active} />
      <View class="flex-1 h-full flex-col justify-between rounded-[18] bg-[#141414] border border-[#222222] p-3" style={{ basis: 0 }}>
        <View class="flex-col">
          <Text class={T.eyebrow}>TABLET UI</Text>
          <View class="flex-row items-end gap-1">
            <Text class="text-4xl font-bold text-[#ededed]">{props.fps()}</Text>
            <Text class={T.monoSm}>fps</Text>
          </View>
        </View>
        <View class="flex-col gap-1">
          <Text class={T.eyebrow}>CPU HISTORY</Text>
          <View class="flex-row items-end gap-[1] h-[48]">
            <For each={hist()}>
              {(v) => <View class="w-[4] rounded-[1] bg-[#a8c7fa]" style={{ height: Math.max(2, Math.round((v / 100) * 48)) }} />}
            </For>
          </View>
        </View>
        <Cookie size={36} speed={1} active={props.active} />
      </View>
    </View>
  );
}
