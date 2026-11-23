// MUSIC: now playing on the host computer (deckd `music`, cover blob `music.art`).
//
//   ┌────────────┐  ┌─ NOW PLAYING ──────────── 󰝚 ┐   read-only → terminal frame:
//   │   cover    │  │ title (Geist lg, ≤ 2 lines)  │   title, artist · album, player · os,
//   │ or a shape │  │ artist · album (mono soft)   │   ASCII progress bar + times
//   │            │  │ 󰌽 spotify · linux            │
//   └────────────┘  │ ██████████░░░░░░░░░░░░░░░░   │
//   (shuf) (rep)    │ 2:41                   6:07  │
//                   └──────────────────────────────┘
//   󰕾 ═══●══ 62     ════════●═════════  (seek)       touchable → rounded:
//                   ( prev ) ( play ) ( next )        sliders, pill buttons
//
// The cover is the real album art when deckd has pushed one; otherwise a single-colour shape
// picked per track (hash of title + artist) from a small set: Morph squircle / 8- / 12-point
// cookies and plain primitives (squircle, pill, plus, flower, clover, sun, orbit). It turns and breathes
// while playing (paint-only whole-pixel translates, ≤ 15 Hz commits), holds still when paused, and every
// hook idles while the page is off screen.

import { Show, createEffect, createMemo, createSignal } from "solid-js";
import { Image, Text, View, type NodeMirror } from "@pocketjs/framework/components";
import { onFrame } from "@pocketjs/framework/lifecycle";
import { createJumpBatch } from "@pocketjs/framework/animation";
import { act, blobSrc, desk } from "../link.ts";
import { accent } from "../theme.ts";
import { DECOR_STEP, decorFrame, decorPhase } from "../clock.ts";
import { Btn, C, Icon, PANE_X, PANE_Y, PH, PW, Slider, TBox } from "../ui.tsx";

type Active = () => boolean;

// ---- geometry (page px; the page is PW × PH = 406 × 271) --------------------------------------

const P = 8; // outer padding
const COVER = 164; // cover / shape square
const LX = P;
const RX = LX + COVER + 10; // 182: right column
const RW = PW - P - RX; // 216
const BOX_H = 176; // NOW PLAYING frame (incl. its 6 px title band)
const SEEK_Y = P + BOX_H + 6; // 190: seek slider touch band (24 px)
const CTRL_H = 40; // transport buttons
const CTRL_Y = PH - P - CTRL_H; // 223
const TOG_Y = P + COVER + 10; // 182: shuffle / repeat
const TOG_H = 30;
const VOL_Y = CTRL_Y + (CTRL_H - 24) / 2; // 231: volume slider band, centred on the transport row
const VOL_ICON = 18;
const VOL_NUM = 22;
const VOL_W = COVER - VOL_ICON - VOL_NUM - 12; // 112
const IN_W = RW - 2 - 14; // text width inside the frame (border + 7 px padding each side)
const CELLS = 27; // TBar cells (mono xs ≈ 7.2 px each)

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
function ShapeCover(props: { seed: () => string; playing: () => boolean; idle: () => boolean; active: Active }) {
  const h = createMemo(() => hash(props.seed()));
  const kind = createMemo(() => KINDS[h() % KINDS.length]!);
  const color = () => ((h() >>> 8) % 3 === 2 ? C.soft : accent());
  const S = COVER - 20;
  return (
    <View class="relative items-center justify-center rounded-[14]" style={{ width: COVER, height: COVER, bgColor: C.bg }}>
      <Show
        when={!props.idle()}
        fallback={
          <View class="items-center justify-center rounded-[38]" style={{ width: r0(S * 0.8), height: r0(S * 0.8), bgColor: "#1a1a1a" }}>
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

/** The kit's TBar, except an empty filled part is left out instead of drawn as " " (TBar's
 *  placeholder space shifts the empty cells one column right at 0 %). Fixed width. */
function Bar(props: { value: () => number; cells: number; color: string }) {
  const n = () => Math.max(0, Math.min(props.cells, Math.round(props.value() * props.cells)));
  return (
    <View class="flex-row" style={{ height: 16 }}>
      <Show when={n() > 0}>
        <Text class="text-xs font-bold" style={{ textColor: props.color }}>{"█".repeat(Math.max(1, n()))}</Text>
      </Show>
      <Show when={n() < props.cells}>
        <Text class="text-xs font-bold" style={{ textColor: C.dim }}>{"░".repeat(Math.max(1, props.cells - n()))}</Text>
      </Show>
    </View>
  );
}

// ---- the page -----------------------------------------------------------------------------------

export function MusicPage(props: { active: () => boolean }) {
  const m = (): Music => (desk.music ?? {}) as Music;
  const title = () => str(m().title);
  const idle = () => !title() || (m().state !== "playing" && m().state !== "paused");
  const playing = () => !idle() && m().state === "playing";
  const dur = () => (Number(m().duration) > 0 ? Number(m().duration) : 0);
  const art = () => blobSrc("music.art");
  const os = () => str(desk.host?.os) || "linux";

  // position: deckd sends it on change; extrapolate while playing, redraw once a second
  let basePos = -1;
  let baseAt = 0;
  const [pos, setPos] = createSignal(0);
  const [scrub, setScrub] = createSignal<number | null>(null);
  onFrame(() => {
    if (!props.active() || !decorPhase(10)) return;
    const p = Number(m().position) || 0;
    if (p !== basePos) {
      basePos = p;
      baseAt = Date.now();
    }
    let now = playing() ? basePos + (Date.now() - baseAt) / 1000 : basePos;
    if (dur()) now = Math.min(now, dur());
    const whole = Math.floor(now);
    if (whole !== Math.floor(pos())) setPos(whole);
  });
  const shownPos = () => scrub() ?? pos();
  const progress = () => (dur() ? Math.max(0, Math.min(1, shownPos() / dur())) : 0);

  const [shuffle, setShuffle] = optimistic(() => !!m().shuffle);
  const [repeat, setRepeat] = optimistic<"off" | "all" | "one">(() => (m().repeat === "all" || m().repeat === "one" ? m().repeat! : "off"));
  const [vol, setVol] = optimistic(() => Math.max(0, Math.min(100, Math.round(Number(m().volume ?? 0)))));
  const [volDrag, setVolDrag] = createSignal<number | null>(null);
  const volShown = () => volDrag() ?? vol();

  // text, measured to the frame
  const titleLines = createMemo(() => (idle() ? ["nothing playing"] : wrapLines(title().toLowerCase(), IN_W, 18, 2)));
  const subLines = createMemo(() => {
    if (idle()) return [fit(`start a track on ${os()}`, IN_W, 12, true)];
    const artist = str(m().artist).toLowerCase();
    const album = str(m().album).toLowerCase();
    const both = [artist, album].filter(Boolean).join(" · ");
    if (!both) return ["unknown artist"];
    // "artist · album" on one line if it fits; else artist, then album on its own line
    if (textW(both, 14, true) <= IN_W || titleLines().length > 1 || !artist || !album) return [fit(both, IN_W, 14, true)];
    return [fit(artist, IN_W, 14, true), fit(album, IN_W, 14, true)];
  });
  const source = () => fit([str(m().player).toLowerCase(), os()].filter(Boolean).join(" · "), IN_W - 18, 12, true);
  const boxTitle = () => (idle() ? "MUSIC" : playing() ? "NOW PLAYING" : "PAUSED");

  return (
    <View class="relative" style={{ width: PW, height: PH }}>
      {/* cover: real art, or a shape */}
      <View class="absolute" style={{ insetL: LX, insetT: P, width: COVER, height: COVER }}>
        <Show when={art() !== ""} fallback={<ShapeCover seed={() => `${title()}\u0000${str(m().artist)}`} playing={playing} idle={idle} active={props.active} />}>
          <Image class="w-[164] h-[164] rounded-[14]" src={art()} />
        </Show>
      </View>

      {/* shuffle / repeat */}
      <View class="absolute flex-row gap-[8]" style={{ insetL: LX, insetT: TOG_Y, width: COVER }}>
        <Btn
          icon="shuffle"
          kind={shuffle() ? "primary" : "default"}
          h={TOG_H}
          grow
          onPress={() => {
            setShuffle(!shuffle());
            act("music.shuffle");
          }}
        />
        <Btn
          icon="repeat"
          label={repeat() === "one" ? "1" : undefined}
          kind={repeat() === "off" ? "default" : "primary"}
          h={TOG_H}
          grow
          onPress={() => {
            setRepeat(REPEAT_NEXT[repeat()]);
            act("music.repeat");
          }}
        />
      </View>

      {/* volume */}
      <View class="absolute flex-row items-center gap-[6]" style={{ insetL: LX, insetT: VOL_Y, width: COVER, height: 24 }}>
        <View class="items-center" style={{ width: VOL_ICON }}>
          <Icon name={volShown() === 0 ? "vol-mute" : volShown() < 50 ? "vol-down" : "vol-up"} size="base" color={C.soft} />
        </View>
        <Slider
          x={PANE_X + LX + VOL_ICON + 6}
          y={PANE_Y + VOL_Y}
          w={VOL_W}
          value={() => vol() / 100}
          onInput={(v) => setVolDrag(Math.round(v * 100))}
          onChange={(v) => {
            const n = Math.round(v * 100);
            setVolDrag(null);
            setVol(n);
            act("music.volume", { v: n });
          }}
          active={props.active}
        />
        <Text class="text-xs font-bold text-right" style={{ width: VOL_NUM, textColor: C.mute }}>{String(volShown())}</Text>
      </View>

      {/* track info (read-only) */}
      <View class="absolute" style={{ insetL: RX, insetT: P, width: RW, height: BOX_H }}>
        <TBox title={boxTitle()} rightIcon="music" hot={playing()} h={BOX_H}>
          <View class="flex-1 flex-col justify-between">
            <View class="flex-col gap-[3]">
              <Text class="text-lg" style={{ textColor: idle() ? C.mute : C.fg }}>{titleLines().join("\n")}</Text>
              <Text class={idle() ? "text-xs font-bold" : "text-sm font-bold"} style={{ textColor: idle() ? C.mute : C.soft }}>{subLines().join("\n")}</Text>
              <View class="flex-row items-center gap-[6]" style={{ paddingT: 3 }}>
                <Icon name={OS_ICON[os()] ?? "display"} size="xs" color={C.mute} />
                <Text class="text-xs font-bold" style={{ textColor: C.mute }}>{source()}</Text>
              </View>
            </View>
            <View class="flex-col gap-[1]">
              <Bar value={progress} cells={CELLS} color={playing() ? accent() : C.soft} />
              <View class="flex-row justify-between">
                <Text class="text-xs font-bold" style={{ width: 48, textColor: scrub() !== null ? accent() : C.soft }}>{idle() ? "-:--" : mmss(shownPos())}</Text>
                <Text class="text-xs font-bold text-right" style={{ width: 48, textColor: C.mute }}>{dur() && !idle() ? mmss(dur()) : "-:--"}</Text>
              </View>
            </View>
          </View>
        </TBox>
      </View>

      {/* seek */}
      <View class="absolute" style={{ insetL: RX, insetT: SEEK_Y, width: RW, height: 24 }}>
        <Slider
          x={PANE_X + RX}
          y={PANE_Y + SEEK_Y}
          w={RW}
          value={progress}
          onInput={(v) => (dur() && !idle() ? setScrub(Math.round(v * dur())) : undefined)}
          onChange={(v) => {
            setScrub(null);
            if (!dur() || idle()) return;
            const p = Math.round(v * dur());
            basePos = p; // show it now; deckd's next position wins
            baseAt = Date.now();
            setPos(p);
            act("music.seek", { pos: p });
          }}
          active={props.active}
        />
      </View>

      {/* transport */}
      <View class="absolute flex-row gap-[8]" style={{ insetL: RX, insetT: CTRL_Y, width: RW, height: CTRL_H }}>
        <Btn icon="prev" h={CTRL_H} grow onPress={() => act("music.prev")} />
        <Btn icon={playing() ? "pause" : "play"} kind="primary" h={CTRL_H} w={84} onPress={() => act("music.toggle")} />
        <Btn icon="next" h={CTRL_H} grow onPress={() => act("music.next")} />
      </View>
    </View>
  );
}
