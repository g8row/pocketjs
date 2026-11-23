// MUSIC: now playing on the host computer (deckd `music`, cover blob `music.art`).
//
// The cover and the track info carry the page; the controls are quiet. Read-only parts are
// terminal (the NOW PLAYING frame, times); touchables are bare icons with a rounded press state,
// one filled round play/pause, and tappable ASCII block bars (seek and volume: tap or drag on the
// █░ cells; the bar claims the gesture so the pager doesn't swipe).
//
// The cover is the real album art when deckd has pushed one; otherwise a single-colour shape
// picked per track (hash of title + artist): squircle, pill, plus, 8-/12-point cookies, flower,
// clover, sun, orbit. It turns and breathes while playing (whole-pixel translates, ≤ 15 Hz
// commits), holds still when paused, and every hook idles while the page is off screen.

import { Show, createEffect, createMemo, createSignal } from "solid-js";
import { Image, Text, View, type NodeMirror } from "@pocketjs/framework/components";
import { onFrame } from "@pocketjs/framework/lifecycle";
import { createJumpBatch } from "@pocketjs/framework/animation";
import { cancelTouchTap, touches } from "@pocketjs/framework/input";
import { act, blobSrc, desk } from "../link.ts";
import { ON_ACCENT, accent } from "../theme.ts";
import { DECOR_STEP, decorFrame, decorPhase } from "../clock.ts";
import { gesture } from "../pager.tsx";
import { C, Icon, PANE_X, PANE_Y, PH, PW, Slider, TBox, squish } from "../ui.tsx";

type Active = () => boolean;
const P = 8; // margin on every side

// ---- text helpers (the core has no word wrap) -------------------------------------------------

const pad2 = (n: number) => (n < 10 ? `0${n}` : `${n}`);
const mmss = (s: number) => (Number.isFinite(s) && s >= 0 ? `${Math.floor(s / 60)}:${pad2(Math.floor(s % 60))}` : "-:--");
const str = (s: unknown) => (typeof s === "string" ? s.replace(/\s+/g, " ").trim() : "");

/** Approximate Geist advance (em) per character. */
function em(ch: string): number {
  if (ch === " ") return 0.27;
  if ("il.,:;'!|".includes(ch)) return 0.25;
  if ("jI".includes(ch)) return 0.28;
  if ("ft()[]".includes(ch)) return 0.36;
  if (ch === "r" || ch === "-") return 0.4;
  if (ch === "m") return 0.86;
  if (ch === "w") return 0.78;
  if (ch === "M") return 0.88;
  if (ch === "W") return 1.0;
  if (ch >= "A" && ch <= "Z") return 0.66;
  if (ch >= "0" && ch <= "9") return 0.6;
  if (ch >= "a" && ch <= "z") return 0.55;
  return 0.62;
}
const textW = (s: string, size: number, mono: boolean) => {
  if (mono) return s.length * size * 0.6;
  let w = 0;
  for (const ch of s) w += em(ch);
  return w * size;
};
/** One line clipped to `px` with "…". */
function fit(s: string, px: number, size: number, mono = false): string {
  if (!mono) px *= 0.94; // the Geist advance table runs a little narrow
  if (textW(s, size, mono) <= px) return s;
  let n = s.length;
  while (n > 1 && textW(`${s.slice(0, n)}…`, size, mono) > px) n--;
  return `${s.slice(0, n).trimEnd()}…`;
}
/** Word-wrap to ≤ `max` lines of `px`; the last line is clipped with "…" if text is left over. */
function wrapLines(text: string, px: number, size: number, max: number, mono = false): string[] {
  const words = text.split(" ").filter(Boolean);
  const out: string[] = [];
  let line = "";
  let i = 0;
  for (; i < words.length; i++) {
    const w = words[i]!;
    const next = line ? `${line} ${w}` : w;
    if (textW(next, size, mono) <= (mono ? px : px * 0.94)) {
      line = next;
      continue;
    }
    if (!line) {
      // one over-long word: it takes the line (clipped below if it's the last one)
      line = w;
      continue;
    }
    if (out.length === max - 1) break;
    out.push(line);
    line = w;
  }
  if (i < words.length) line = `${line} ${words.slice(i).join(" ")}`;
  out.push(fit(line, px, size, mono));
  return out.map((l) => fit(l, px, size, mono));
}

// ---- data ----------------------------------------------------------------------------------------

type Music = {
  state?: string;
  title?: string;
  artist?: string;
  album?: string;
  position?: number;
  duration?: number;
  player?: string;
  shuffle?: boolean;
  repeat?: "off" | "all" | "one";
  volume?: number;
};
const OS_ICON: Record<string, string> = { linux: "linux", macos: "apple", windows: "windows" };
const OS_LABEL: Record<string, string> = { linux: "linux", macos: "mac", windows: "windows" };
const REPEAT_NEXT = { off: "all", all: "one", one: "off" } as const;

/** A deckd value with an optimistic local override until deckd reports a new value. */
function optimistic<T>(remote: () => T): [() => T, (v: T) => void] {
  const [local, setLocal] = createSignal<{ v: T } | null>(null);
  createEffect(() => {
    remote();
    setLocal(null);
  });
  return [() => (local() ? local()!.v : remote()), (v: T) => setLocal({ v })];
}

// ---- the cover fallback: shapes ---------------------------------------------------------------
//
// Everything here stays AXIS-ALIGNED: the core draws a rotated rounded box as a square fill
// (engine/core/src/draw.rs, "rotated rounded boxes degrade"), so a rotated Morph layer shows
// sharp corners. Scalloped "cookies" and flowers are therefore a core plus N bump discs on a
// ring; "turning" moves the bumps around the ring and "breathing" moves them in and out by a
// couple of px. The plain shapes (squircle, plus, pill) bob up and down instead. All of it is
// whole-pixel translate (paint-only), committed at ≤ 15 Hz and only when something moved.
// Two more core limits shape the set: corner radii > 32 px take an aliased span path (jaggy
// edges; only r ≤ 32 uses the baked anti-aliased disc), so no disc is wider than 64 px and big
// cores are rounded boxes with r = 32 sized to hide under the bumps; and no scale (it also
// knocks the corners off the baked path).

// core: side of the core box (r ≤ 32); ring: bump-centre radius; bump: bump diameter
// (fractions of the shape box S = 144; core edges stay between the bumps' inner and outer valleys)
type Ring = { core: number; ring: number; bump: number; n: number; spin: number };
const SHAPES: Record<string, Ring | null> = {
  squircle: null,
  plus: null,
  pill: null,
  cookie8: { core: 0.64, ring: 0.33, bump: 0.3, n: 8, spin: 0.3 },
  cookie12: { core: 0.67, ring: 0.37, bump: 0.22, n: 12, spin: 0.25 },
  flower: { core: 0.44, ring: 0.25, bump: 0.42, n: 6, spin: 0.35 },
  clover: { core: 0.28, ring: 0.2, bump: 0.44, n: 4, spin: 0.3 },
  sun: { core: 0.44, ring: 0.4, bump: 0.14, n: 10, spin: 0.4 },
  orbit: { core: 0.44, ring: 0.38, bump: 0.2, n: 3, spin: 0.6 },
};
const KINDS = Object.keys(SHAPES);

function hash(s: string): number {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 16777619);
  return h >>> 0;
}

/** One single-colour shape in an S × S box. Turns and breathes while `playing`, eases to rest. */
function Shape(props: { kind: string; size: number; color: () => string; playing: () => boolean; active: Active; phase: number }) {
  const S = props.size;
  const ring = SHAPES[props.kind] ?? null;
  const bumps: NodeMirror[] = [];
  let root: NodeMirror | undefined;
  let batch: ReturnType<typeof createJumpBatch> | undefined;
  let angle = props.phase;
  let t = 0;
  let amp = 0;
  let lastBob = 0;
  let breath = 0;
  const last: number[] = [];
  const r = Math.round;
  const pos = (i: number, a: number) => {
    const th = ((a + (360 / ring!.n) * i) * Math.PI) / 180;
    const rad = ring!.ring * S + breath;
    return [r(Math.cos(th) * rad), r(Math.sin(th) * rad)] as const;
  };
  onFrame(() => {
    if (!props.active() || !root || !decorFrame()) return;
    const n = ring?.n ?? 0;
    if (!batch && bumps.length === n) {
      const pairs: [NodeMirror, "translateX" | "translateY"][] = [[root, "translateY"]];
      for (const b of bumps) pairs.push([b, "translateX"], [b, "translateY"]);
      batch = createJumpBatch(pairs);
    }
    if (!batch) return;
    const on = props.playing();
    amp += ((on ? 1 : 0) - amp) * 0.08;
    if (!on && amp < 0.01) amp = 0;
    t += DECOR_STEP / 60;
    if (ring) angle = (angle + ring.spin * amp * DECOR_STEP) % 360;
    const wave = amp * Math.sin(t * 2.6);
    breath = ring ? 2.4 * wave : 0;
    const bob = ring ? 0 : r(3 * wave);
    if (!decorPhase(4)) return;
    let moved = bob !== lastBob;
    for (let i = 0; i < n; i++) {
      const [x, y] = pos(i, angle);
      if (x !== last[i * 2] || y !== last[i * 2 + 1]) moved = true;
    }
    if (!moved) return;
    lastBob = bob;
    batch.set(0, bob);
    for (let i = 0; i < n; i++) {
      const [x, y] = pos(i, angle);
      last[i * 2] = x;
      last[i * 2 + 1] = y;
      batch.set(1 + i * 2, x);
      batch.set(2 + i * 2, y);
    }
    batch.commit();
  });
  const c = S / 2;
  // a disc of diameter d centred in the box (bumps are moved out by translate)
  const disc = (d: number, ref?: (n: NodeMirror) => void, tx = 0, ty = 0) => (
    <View
      ref={ref}
      class="absolute rounded-[999]"
      style={{ insetL: r(c - d / 2), insetT: r(c - d / 2), width: r(d), height: r(d), translateX: tx, translateY: ty, bgColor: props.color() }}
    />
  );
  const box = (w: number, h: number, rad: number) => (
    <View class="absolute" style={{ insetL: r(c - w / 2), insetT: r(c - h / 2), width: r(w), height: r(h), radius: Math.min(32, r(rad)), bgColor: props.color() }} />
  );
  return (
    <View ref={(n: NodeMirror) => (root = n)} class="relative" style={{ width: S, height: S, translateY: 0 }}>
      {ring ? (
        <>
          {box(ring.core * S, ring.core * S, 32)}
          {Array.from({ length: ring.n }, (_, i) => {
            const [x, y] = pos(i, angle);
            return disc(ring.bump * S, (n) => bumps.push(n), x, y);
          })}
        </>
      ) : props.kind === "plus" ? (
        <>
          {box(S * 0.36, S * 0.88, S * 0.18)}
          {box(S * 0.88, S * 0.36, S * 0.18)}
        </>
      ) : props.kind === "pill" ? (
        <>
          {box(S * 0.42, S * 0.88, S * 0.21)}
        </>
      ) : (
        box(S * 0.8, S * 0.8, 32)
      )}
    </View>
  );
}

/** The per-track fallback cover: shape kind and tint from a hash of title + artist. */
function ShapeCover(props: { size: number; seed: () => string; playing: () => boolean; idle: () => boolean; active: Active }) {
  const h = createMemo(() => hash(props.seed()));
  const kind = createMemo(() => KINDS[h() % KINDS.length]!);
  const color = () => ((h() >>> 8) % 3 === 2 ? C.soft : accent());
  // the shape fractions keep every radius ≤ 32 px (anti-aliased) only up to S = 144
  const S = Math.min(144, props.size - 20);
  return (
    <View class="relative items-center justify-center rounded-[14]" style={{ width: props.size, height: props.size, bgColor: C.bg }}>
      <Show
        when={!props.idle()}
        fallback={
          <View class="items-center justify-center rounded-[32]" style={{ width: r0(S * 0.8), height: r0(S * 0.8), bgColor: "#1a1a1a" }}>
            <Icon name="music" size="4xl" color={C.mute} />
          </View>
        }
      >
        {/* keyed: a new track remounts the shape (and its frame hook) */}
        <Show when={kind()} keyed>
          {(k) => <Shape kind={k} size={S} color={color} playing={props.playing} active={props.active} phase={(h() >>> 12) % 90} />}
        </Show>
      </Show>
    </View>
  );
}
const r0 = Math.round;

// ---- touchables -----------------------------------------------------------------------------------

type BarSize = "xs" | "sm" | "base";
const CELL: Record<BarSize, number> = { xs: 7, sm: 8, base: 10 }; // mono advance (round(size × 0.6))
const BAR_CLS: Record<BarSize, string> = { xs: "text-xs font-bold", sm: "text-sm font-bold", base: "text-base font-bold" };

/** A tappable ASCII block bar (█ filled, ░ empty): tap or drag anywhere on it. Hit-tests touches
 *  itself, so it needs its SCREEN position (x, y = top of the touch band). Claims the gesture while
 *  held; `onInput` while dragging, `onChange` on release. Fixed width = cells × cell advance. */
function BlockBar(props: {
  x: number;
  y: number;
  cells: number;
  size?: BarSize;
  value: () => number;
  color?: string;
  h?: number;
  onInput?: (v: number) => void;
  onChange: (v: number) => void;
  active: Active;
}) {
  const size = props.size ?? "sm";
  const W = props.cells * CELL[size];
  const H = props.h ?? 28;
  const [drag, setDrag] = createSignal<number | null>(null);
  let held = false;
  const at = (tx: number) => Math.max(0, Math.min(1, (tx - props.x) / W));
  onFrame(() => {
    if (!props.active()) return;
    const t = touches()[0];
    if (t) {
      if (!held && gesture.owner === "" && t.x >= props.x - 6 && t.x < props.x + W + 6 && t.y >= props.y && t.y < props.y + H) {
        held = true;
        gesture.owner = "slider";
        cancelTouchTap();
      }
      if (held) {
        const v = at(t.x);
        if (v !== drag()) {
          setDrag(v);
          props.onInput?.(v);
        }
      }
      return;
    }
    if (held) {
      held = false;
      gesture.owner = "";
      const fin = drag();
      setDrag(null);
      if (fin !== null) props.onChange(fin);
    }
  });
  const n = () => Math.max(0, Math.min(props.cells, Math.round((drag() ?? props.value()) * props.cells)));
  return (
    <View class="flex-row items-center" style={{ width: W, height: H }}>
      <Show when={n() > 0}>
        <Text class={BAR_CLS[size]} style={{ textColor: drag() !== null ? C.fg : props.color ?? accent() }}>{"█".repeat(Math.max(1, n()))}</Text>
      </Show>
      <Show when={n() < props.cells}>
        <Text class={BAR_CLS[size]} style={{ textColor: C.dim }}>{"░".repeat(Math.max(1, props.cells - n()))}</Text>
      </Show>
    </View>
  );
}

/** A bare icon button: no fill or outline, a rounded raised fill only while pressed. */
function IconBtn(props: { icon: string; color?: string; size?: "base" | "lg" | "xl" | "2xl"; w?: number; h?: number; onPress: () => void }) {
  return (
    <View
      class="items-center justify-center rounded-[999] active:bg-[#1d1d1d]"
      style={{ width: props.w ?? 36, height: props.h ?? 32 }}
      focusable
      onPress={props.onPress}
    >
      <Icon name={props.icon} size={props.size ?? "lg"} color={props.color ?? C.soft} />
    </View>
  );
}

/** The one filled control: round play/pause. */
function PlayBtn(props: { playing: () => boolean; d: number }) {
  let n: NodeMirror | undefined;
  return (
    <View
      ref={(x: NodeMirror) => (n = x)}
      class="items-center justify-center rounded-[999]"
      style={{ width: props.d, height: props.d, bgColor: accent() }}
      focusable
      onPress={() => {
        squish(n);
        act("music.toggle");
      }}
    >
      <Icon name={props.playing() ? "pause" : "play"} size="xl" color={ON_ACCENT} />
    </View>
  );
}

// ---- the page -----------------------------------------------------------------------------------

/** Everything the layouts share: state, text and handlers. */
function useMusic(active: Active) {
  const m = (): Music => (desk.music ?? {}) as Music;
  const title = () => str(m().title);
  const idle = () => !title() || (m().state !== "playing" && m().state !== "paused");
  const playing = () => !idle() && m().state === "playing";
  const dur = () => (Number(m().duration) > 0 ? Number(m().duration) : 0);
  const osKey = () => str(desk.host?.os) || "linux";
  const os = () => OS_LABEL[osKey()] ?? osKey();

  // position: deckd sends it on change; extrapolate while playing, redraw once a second
  let basePos = -1;
  let baseAt = 0;
  const [pos, setPos] = createSignal(0);
  const [scrub, setScrub] = createSignal<number | null>(null);
  onFrame(() => {
    if (!active() || !decorPhase(10)) return;
    const p = Number(m().position) || 0;
    if (p !== basePos) {
      basePos = p;
      baseAt = Date.now();
    }
    let now = playing() ? basePos + (Date.now() - baseAt) / 1000 : basePos;
    if (dur()) now = Math.min(now, dur());
    const whole = Math.floor(now);
    if (whole !== pos()) setPos(whole);
  });
  const shownPos = () => scrub() ?? pos();
  const progress = () => (dur() ? Math.max(0, Math.min(1, pos() / dur())) : 0);
  const seekInput = (v: number) => (dur() && !idle() ? setScrub(Math.round(v * dur())) : undefined);
  const seek = (v: number) => {
    setScrub(null);
    if (!dur() || idle()) return;
    const p = Math.round(v * dur());
    basePos = p; // show it now; deckd's next position wins
    baseAt = Date.now();
    setPos(p);
    act("music.seek", { pos: p });
  };

  const [shuffle, setShuffle] = optimistic(() => !!m().shuffle);
  const [repeat, setRepeat] = optimistic<"off" | "all" | "one">(() => (m().repeat === "all" || m().repeat === "one" ? m().repeat! : "off"));
  const [vol, setVol] = optimistic(() => Math.max(0, Math.min(100, Math.round(Number(m().volume ?? 0)))));
  const [volDrag, setVolDrag] = createSignal<number | null>(null);
  const volShown = () => volDrag() ?? vol();

  return {
    m,
    title,
    idle,
    playing,
    dur,
    osKey,
    os,
    shownPos,
    scrubbing: () => scrub() !== null,
    progress,
    seekInput,
    seek,
    shuffle,
    toggleShuffle: () => {
      setShuffle(!shuffle());
      act("music.shuffle");
    },
    repeat,
    cycleRepeat: () => {
      setRepeat(REPEAT_NEXT[repeat()]);
      act("music.repeat");
    },
    vol,
    volShown,
    volInput: (v: number) => setVolDrag(Math.round(v * 100)),
    setVolume: (v: number) => {
      const n = Math.round(v * 100);
      setVolDrag(null);
      setVol(n);
      act("music.volume", { v: n });
    },
  };
}
type MusicState = ReturnType<typeof useMusic>;

/** Title (Geist lg), artist / album (mono), source (os icon + player · os), measured to `w`. */
function TrackText(props: { s: MusicState; w: number; titleLines: number }) {
  const s = props.s;
  const titleLines = createMemo(() => (s.idle() ? ["nothing playing"] : wrapLines(s.title().toLowerCase(), props.w, 18, props.titleLines)));
  const subLines = createMemo(() => {
    if (s.idle()) return [fit(`start a track on ${s.os()}`, props.w, 12, true)];
    const artist = str(s.m().artist).toLowerCase();
    const album = str(s.m().album).toLowerCase();
    const both = [artist, album].filter(Boolean).join(" · ");
    if (!both) return ["unknown artist"];
    // "artist · album" on one line if it fits; else artist, then album on its own line
    if (textW(both, 14, true) <= props.w || !artist || !album) return [fit(both, props.w, 14, true)];
    return [fit(artist, props.w, 14, true), fit(album, props.w, 14, true)];
  });
  const source = () => fit([str(s.m().player).toLowerCase(), s.os()].filter(Boolean).join(" · "), props.w - 18, 12, true);
  return (
    <View class="flex-col gap-[3]">
      <Text class="text-lg" style={{ textColor: s.idle() ? C.mute : C.fg }}>{titleLines().join("\n")}</Text>
      <Text class={s.idle() ? "text-xs font-bold" : "text-sm font-bold"} style={{ textColor: s.idle() ? C.mute : C.soft }}>{subLines().join("\n")}</Text>
      <View class="flex-row items-center gap-[6]" style={{ paddingT: 3 }}>
        <Icon name={OS_ICON[s.osKey()] ?? "display"} size="xs" color={C.mute} />
        <Text class="text-xs font-bold" style={{ textColor: C.mute }}>{source()}</Text>
      </View>
    </View>
  );
}

function Cover(props: { s: MusicState; size: number; active: Active }) {
  const art = () => blobSrc("music.art");
  return (
    <Show
      when={art() !== ""}
      fallback={<ShapeCover size={props.size} seed={() => `${props.s.title()}\u0000${str(props.s.m().artist)}`} playing={props.s.playing} idle={props.s.idle} active={props.active} />}
    >
      <Image class="rounded-[14]" style={{ width: props.size, height: props.size }} src={art()} />
    </Show>
  );
}

const Elapsed = (props: { s: MusicState; w?: number; right?: boolean }) => (
  <Text class={props.right ? "text-xs font-bold text-right" : "text-xs font-bold"} style={{ width: props.w ?? 40, textColor: props.s.scrubbing() ? accent() : C.soft }}>
    {props.s.idle() ? "-:--" : mmss(props.s.shownPos())}
  </Text>
);
const Total = (props: { s: MusicState; w?: number }) => (
  <Text class="text-xs font-bold text-right" style={{ width: props.w ?? 40, textColor: C.mute }}>
    {props.s.dur() && !props.s.idle() ? mmss(props.s.dur()) : "-:--"}
  </Text>
);
const boxTitle = (s: MusicState) => (s.idle() ? "MUSIC" : s.playing() ? "NOW PLAYING" : "PAUSED");

function ShuffleRepeat(props: { s: MusicState }) {
  const s = props.s;
  return (
    <>
      <IconBtn icon={s.shuffle() ? "shuffle" : "shuffle-off"} size="base" color={s.shuffle() ? accent() : C.mute} w={32} h={28} onPress={s.toggleShuffle} />
      <IconBtn
        icon={s.repeat() === "one" ? "repeat-once" : s.repeat() === "all" ? "repeat" : "repeat-off"}
        size="base"
        color={s.repeat() === "off" ? C.mute : accent()}
        w={32}
        h={28}
        onPress={s.cycleRepeat}
      />
    </>
  );
}

function Transport(props: { s: MusicState; d?: number }) {
  return (
    <>
      <IconBtn icon="prev" size="xl" color={C.fg} w={44} h={40} onPress={() => act("music.prev")} />
      <PlayBtn playing={props.s.playing} d={props.d ?? 46} />
      <IconBtn icon="next" size="xl" color={C.fg} w={44} h={40} onPress={() => act("music.next")} />
    </>
  );
}

/** Volume icon + the kit's block-bar Slider; (x, y) = the slider's page position. */
function Volume(props: { s: MusicState; x: number; y: number; cells: number; active: Active }) {
  const s = props.s;
  return (
    <View class="absolute flex-row items-center gap-[4]" style={{ insetL: props.x - 20, insetT: props.y, height: 24 }}>
      <View class="items-center" style={{ width: 16 }}>
        <Icon name={s.volShown() === 0 ? "vol-mute" : s.volShown() < 50 ? "vol-down" : "vol-up"} size="sm" color={C.mute} />
      </View>
      <View class="overflow-hidden" style={{ width: props.cells * CELL.xs, height: 24 }}>
        <Slider x={PANE_X + props.x} y={PANE_Y + props.y} w={props.cells * CELL.xs} value={() => s.vol() / 100} onInput={s.volInput} onChange={s.setVolume} active={props.active} />
      </View>
    </View>
  );
}

/** The control row (bottom 46 px): toggles left, transport centred, volume right. */
function ControlRow(props: { s: MusicState; active: Active }) {
  const Y = PH - P - 46;
  return (
    <>
      <View class="absolute flex-row items-center gap-[2]" style={{ insetL: P - 2, insetT: Y + 9, height: 28 }}>
        <ShuffleRepeat s={props.s} />
      </View>
      <View class="absolute flex-row items-center justify-center gap-[10]" style={{ insetL: PW / 2 - 80, insetT: Y, width: 160, height: 46 }}>
        <Transport s={props.s} />
      </View>
      <Volume s={props.s} x={PW - P - 12 * CELL.xs} y={Y + 11} cells={12} active={props.active} />
    </>
  );
}

// One terminal frame holds cover, track and the seek bar; one quiet control row under it.
// (Variants A and B, a big cover with the frame beside it and a full-width seek bar, are in the
// "wip(desk): music layouts A/B/C" commit.)
function Layout(props: { s: MusicState; active: Active }) {
  const s = props.s;
  const BOX_H = 206; // frame 14..214
  const COV = 182; // content top 23
  const TX = P + 8 + COV + 12; // 210
  const TW = PW - P - 8 - TX; // 180
  const CELLS = Math.floor(TW / CELL.xs); // 25
  const BAR_Y = 159;
  return (
    <>
      <View class="absolute" style={{ insetL: P, insetT: P, width: PW - 2 * P, height: BOX_H }}>
        <TBox title={boxTitle(s)} rightIcon="music" hot={s.playing()} w={PW - 2 * P} h={BOX_H}>
          <View class="flex-row gap-[12]">
            <View style={{ marginT: 1 }}>
              <Cover s={s} size={COV} active={props.active} />
            </View>
            <TrackText s={s} w={TW} titleLines={3} />
          </View>
        </TBox>
      </View>
      <View class="absolute" style={{ insetL: TX, insetT: BAR_Y }}>
        <BlockBar x={PANE_X + TX} y={PANE_Y + BAR_Y} cells={CELLS} size="xs" value={s.progress} color={s.playing() ? accent() : C.soft} onInput={s.seekInput} onChange={s.seek} active={props.active} />
      </View>
      <View class="absolute flex-row justify-between" style={{ insetL: TX, insetT: BAR_Y + 28, width: CELLS * CELL.xs }}>
        <Elapsed s={s} />
        <Total s={s} />
      </View>
      <ControlRow s={s} active={props.active} />
    </>
  );
}

export function MusicPage(props: { active: () => boolean }) {
  const s = useMusic(props.active);
  return (
    <View class="relative" style={{ width: PW, height: PH }}>
      <Layout s={s} active={props.active} />
    </View>
  );
}
