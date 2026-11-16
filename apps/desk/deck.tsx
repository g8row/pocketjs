// The deck: tiles from desk.config.json packed into a 4×3 grid, every tile
// drawn by what it is rather than one card for everything —
//   split pill   consecutive tiles sharing a `group` (vertical when tall);
//                a member with a live `level` puts it between the halves
//   circle       shape "circle" (the mic): big icon + state
//   pill         a tile with something to say (a subtitle, the focus clock)
//                or ≥ 2 cells wide: colour chip + text
//   icon tile    everything else: just the icon
// Filled with the tile colour when `fill` is set or its live state is "on".
//
// The core has one radius per box, so a split pill's half is a full pill plus
// a same-colour square-ish box over its inner end: the union reads as "round
// outside, tight in the middle". Opaque + same colour → no seam.

import { For, Show, createMemo } from "solid-js";
import { Image, Text, View, type NodeMirror } from "@pocketjs/framework/components";
import { onFrame } from "@pocketjs/framework/lifecycle";
import { jump, spring } from "@pocketjs/framework/animation";
import { act, desk } from "./link.ts";
import { T, TILE_HEX } from "./theme.ts";
import { DECOR_STEP, decorFrame, decorPhase } from "./clock.ts";
import { ICON_FILES } from "./icons.ts";

type Active = () => boolean;
const INK = "#101010";
const DARK = "#1d1d1d";
const lower = (s: unknown) => (typeof s === "string" ? s.toLowerCase() : "");
const clip = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);
const hex = (t: any) => TILE_HEX[t.color] ?? "#8a8a8a";
const isOn = (t: any) => !!t.on || !!t.fill;

// ---- packing (pure) ---------------------------------------------------------------

export const COLS = 4;
export const ROWS = 3;
export interface Item {
  tiles: any[];
  col: number;
  row: number;
  w: number;
  h: number;
}
export interface Box {
  x: number;
  y: number;
  w: number;
  h: number;
}

/** Group consecutive same-`group` tiles, then place each item at the first
 *  free cell (row-major) where its span fits; one that fits nowhere is tried
 *  as 1×1, then dropped. */
export function pack(tiles: any[]): Item[] {
  const items: { tiles: any[]; w: number; h: number }[] = [];
  for (const t of tiles) {
    const last = items[items.length - 1];
    if (t.group && last && last.tiles[0].group === t.group) last.tiles.push(t);
    else items.push({ tiles: [t], w: Math.min(COLS, Math.max(1, t.w | 0 || 1)), h: Math.min(ROWS, Math.max(1, t.h | 0 || 1)) });
  }
  const used = Array.from({ length: ROWS }, () => new Array(COLS).fill(false));
  const fits = (c: number, r: number, w: number, h: number) => {
    if (c + w > COLS || r + h > ROWS) return false;
    for (let y = r; y < r + h; y++) for (let x = c; x < c + w; x++) if (used[y]![x]) return false;
    return true;
  };
  const out: Item[] = [];
  for (const it of items) {
    let placed = false;
    for (const [w, h] of [[it.w, it.h], [1, 1]] as const) {
      for (let i = 0; i < COLS * ROWS && !placed; i++) {
        const c = i % COLS;
        const r = Math.floor(i / COLS);
        if (!fits(c, r, w, h)) continue;
        for (let y = r; y < r + h; y++) for (let x = c; x < c + w; x++) used[y]![x] = true;
        out.push({ tiles: it.tiles, col: c, row: r, w, h });
        placed = true;
      }
      if (placed) break;
    }
  }
  return out;
}

/** Pixel boxes. A column holding only one full-height split pill is a rail. */
export function layout(items: Item[], W: number, H: number, pad = 10, gap = 8, rail = 66): Box[] {
  const isRail = (c: number) => {
    const inCol = items.filter((it) => it.col <= c && c < it.col + it.w);
    return inCol.length === 1 && inCol[0]!.w === 1 && inCol[0]!.h === ROWS && inCol[0]!.tiles.length > 1;
  };
  const rails = Array.from({ length: COLS }, (_, c) => isRail(c));
  const free = W - 2 * pad - gap * (COLS - 1) - rails.filter(Boolean).length * rail;
  const flex = rails.filter((r) => !r).length;
  const cw = rails.map((r) => (r ? rail : free / flex));
  const cx = cw.map((_, c) => pad + cw.slice(0, c).reduce((a, b) => a + b, 0) + gap * c);
  const rh = (H - 2 * pad - gap * (ROWS - 1)) / ROWS;
  const ry = (r: number) => pad + r * (rh + gap);
  const R = Math.round;
  return items.map((it) => {
    const x = cx[it.col]!;
    const x2 = cx[it.col + it.w - 1]! + cw[it.col + it.w - 1]!;
    const y = ry(it.row);
    const y2 = ry(it.row + it.h - 1) + rh;
    return { x: R(x), y: R(y), w: R(x2) - R(x), h: R(y2) - R(y) };
  });
}

// ---- pieces ------------------------------------------------------------------------

function Icon(props: { name?: string; ink: boolean; big?: boolean }) {
  const f = () => ICON_FILES[props.name ?? ""] ?? ICON_FILES.dot!;
  return (
    <Show when={props.big && f().l} fallback={<Image class="w-[32] h-[32]" src={f().s[props.ink ? 1 : 0]} />}>
      <Image class="w-[64] h-[64]" src={f().l![props.ink ? 1 : 0]} />
    </Show>
  );
}
const iconOf = (t: any) => (t.on && t.iconOn ? t.iconOn : t.icon);

/** A pressable box that squishes on tap. */
function Press(props: { id: string; style: Record<string, number | string>; class?: string; children?: any }) {
  let n: NodeMirror | undefined;
  return (
    <View
      ref={(x: NodeMirror) => (n = x)}
      class={props.class ?? "absolute items-center justify-center"}
      style={props.style}
      focusable
      onPress={() => {
        if (n) {
          jump(n, "scale", 0.93);
          spring(n, "scale", 1);
        }
        act(props.id);
      }}
    >
      {props.children}
    </View>
  );
}

/** The tile colour's small rotating mark (the old deck's signature). */
function Mark(props: { color: string; active: Active }) {
  let n: NodeMirror | undefined;
  let a = Math.random() * 90;
  onFrame(() => {
    if (!props.active() || !n || !decorFrame()) return;
    a = (a + 0.5 * DECOR_STEP) % 360;
    if (decorPhase(4)) jump(n, "rotate", a);
  });
  return <View ref={(x: NodeMirror) => (n = x)} class="absolute w-[7] h-[7] rounded-[2]" style={{ insetT: 10, insetR: 10, bgColor: props.color }} />;
}

function SplitPill(props: { tiles: any[]; b: Box }) {
  const vertical = () => props.b.h > props.b.w;
  const level = () => props.tiles.find((t) => typeof t.level === "number")?.level as number | undefined;
  const LV = 24; // the level chip between vertical halves
  const SEG_GAP = 3;
  const segs = createMemo(() => {
    const n = props.tiles.length;
    const { x, y, w, h } = props.b;
    const lv = vertical() && level() !== undefined && n === 2 ? LV + SEG_GAP : 0;
    const len = ((vertical() ? h : w) - lv - SEG_GAP * (n - 1)) / n;
    return props.tiles.map((t, i) => {
      const off = i * (len + SEG_GAP) + (i > 0 ? lv : 0);
      const box = vertical() ? { x, y: y + off, w, h: len } : { x: x + off, y, w: len, h };
      return { t, box, first: i === 0, last: i === n - 1 };
    });
  });
  const R = Math.round;
  return (
    <>
      <For each={segs()}>
        {(s) => {
          const bg = () => (isOn(s.t) ? hex(s.t) : DARK);
          // full round outer end(s) — radius capped by the short side, whole px
          // (half-px radii alias on the core's software path) — and a
          // same-colour cover over the inner end, never reaching the outer one
          const rad = () => Math.floor(Math.min(s.box.w, s.box.h) / 2);
          const cover = () => {
            if (s.first && s.last) return null;
            const len = vertical() ? s.box.h : s.box.w;
            const half = Math.min(rad() + 1, len / 2);
            const { x, y, w, h } = s.box;
            if (vertical()) return s.first ? { x, y: y + h - half, w, h: half } : s.last ? { x, y, w, h: half } : { x, y, w, h };
            return s.first ? { x: x + w - half, y, w: half, h } : s.last ? { x, y, w: half, h } : { x, y, w, h };
          };
          return (
            <>
              <View class="absolute" style={{ insetL: R(s.box.x), insetT: R(s.box.y), width: R(s.box.w), height: R(s.box.h), radius: s.first || s.last ? rad() : 8, bgColor: bg() }} />
              <Show when={cover()}>
                {(c) => <View class="absolute" style={{ insetL: R(c().x), insetT: R(c().y), width: R(c().w), height: R(c().h), radius: 8, bgColor: bg() }} />}
              </Show>
              <Press id={s.t.id} style={{ insetL: R(s.box.x), insetT: R(s.box.y), width: R(s.box.w), height: R(s.box.h) }}>
                <Show when={s.t.icon} fallback={<Text class="text-sm" style={{ textColor: isOn(s.t) ? INK : "#ededed" }}>{lower(clip(s.t.label, 8))}</Text>}>
                  <Icon name={iconOf(s.t)} ink={isOn(s.t)} />
                </Show>
              </Press>
            </>
          );
        }}
      </For>
      <Show when={vertical() && level() !== undefined && props.tiles.length === 2}>
        <View
          class="absolute items-center justify-center rounded-[8] bg-[#141414]"
          style={{ insetL: props.b.x, insetT: R(segs()[0]!.box.y + segs()[0]!.box.h + SEG_GAP), width: props.b.w, height: LV }}
        >
          <Text class={T.monoHi}>{`${level()}`}</Text>
        </View>
      </Show>
    </>
  );
}

function Circle(props: { t: any; b: Box }) {
  const d = () => (Math.min(props.b.w, props.b.h) - 6) & ~1; // even → whole-px radius
  const on = () => isOn(props.t);
  return (
    <Press
      id={props.t.id}
      class="absolute flex-col items-center justify-center gap-1"
      style={{
        insetL: Math.round(props.b.x + (props.b.w - d()) / 2),
        insetT: Math.round(props.b.y + (props.b.h - d()) / 2),
        width: d(),
        height: d(),
        radius: d() / 2,
        bgColor: on() ? hex(props.t) : DARK,
      }}
    >
      <Icon name={iconOf(props.t)} ink={on()} big />
      <Text class="text-xs font-bold" style={{ textColor: on() ? INK : hex(props.t) }}>
        {on() ? lower(props.t.sub || props.t.label).toUpperCase() : `● ${lower(props.t.sub || props.t.label)}`}
      </Text>
    </Press>
  );
}

/** Focus tiles read deskd's focus state directly: it ticks every second. */
function texts(t: any, wide: boolean): [string, string] {
  if (t.live === "focus") {
    const f = desk.focus ?? {};
    return [f.left ?? "--:--", f.mode === "running" ? "focus" : f.mode === "paused" ? "paused" : lower(t.label)];
  }
  if (!wide && t.sub) return [lower(t.sub), lower(t.label)];
  return [lower(t.label), lower(t.sub || "")];
}

function PillTile(props: { t: any; b: Box; wideCells: boolean }) {
  const on = () => isOn(props.t) || (props.t.live === "focus" && desk.focus?.mode === "running");
  const chip = () => Math.min(props.b.h - 12, props.wideCells ? 64 : 50);
  const tx = () => texts(props.t, props.wideCells);
  const maxChars = () => Math.max(4, Math.floor((props.b.w - chip() - 26) / 10));
  return (
    <Press
      id={props.t.id}
      class="absolute flex-row items-center gap-2"
      style={{ insetL: props.b.x, insetT: props.b.y, width: props.b.w, height: props.b.h, radius: Math.floor(props.b.h / 2), bgColor: on() ? hex(props.t) : DARK, paddingL: 6 }}
    >
      <View class="items-center justify-center" style={{ width: chip(), height: chip(), radius: Math.floor(chip() / 2), bgColor: on() ? INK : hex(props.t) }}>
        <Icon name={iconOf(props.t)} ink={!on()} />
      </View>
      <View class="flex-col">
        <Show when={props.wideCells} fallback={<Text class="text-lg" style={{ textColor: on() ? INK : "#ededed" }}>{clip(tx()[0], maxChars())}</Text>}>
          <Text class="text-xl" style={{ textColor: on() ? INK : "#ededed" }}>{clip(tx()[0], maxChars())}</Text>
        </Show>
        <Show when={tx()[1]}>
          <Text class="text-xs font-bold" style={{ textColor: on() ? "#3a3a3a" : props.t.on ? hex(props.t) : "#8a8a8a" }}>{clip(tx()[1], maxChars() + 4)}</Text>
        </Show>
      </View>
    </Press>
  );
}

function IconTile(props: { t: any; b: Box; active: Active }) {
  const on = () => isOn(props.t);
  return (
    <Press
      id={props.t.id}
      style={{ insetL: props.b.x, insetT: props.b.y, width: props.b.w, height: props.b.h, radius: 22, bgColor: on() ? hex(props.t) : "#141414", borderColor: on() ? hex(props.t) : "#222222", borderWidth: 1 }}
    >
      <Show when={props.t.icon} fallback={<Text class="text-lg" style={{ textColor: on() ? INK : "#ededed" }}>{lower(clip(props.t.label, 10))}</Text>}>
        <Icon name={iconOf(props.t)} ink={on()} />
      </Show>
      <Show when={!on()}>
        <Mark color={hex(props.t)} active={props.active} />
      </Show>
    </Press>
  );
}

// ---- page ----------------------------------------------------------------------------

export function DeckPage(props: { active: Active }) {
  const W = 512;
  const H = 271; // 300 minus the 28 px nav strip and its rule
  // Re-pack only when ids/spans/groups change: live fields (on, sub, level)
  // are read from the store proxies inside each tile, so a 5 s state push
  // repaints a label instead of rebuilding the page.
  const sig = (xs: Item[]) => xs.map((it) => `${it.tiles.map((t) => `${t.id}:${t.shape ?? ""}:${t.sub ? 1 : 0}`).join("+")}@${it.col},${it.row},${it.w},${it.h}`).join("|");
  const items = createMemo(() => pack((desk.deck?.tiles ?? []).slice(0, 12)), [], { equals: (a, b) => sig(a) === sig(b) });
  const boxes = createMemo(() => layout(items(), W, H));
  return (
    <View class="h-full relative" style={{ width: W }}>
      <For each={items()}>
        {(it, i) => {
          const b = () => boxes()[i()]!;
          const t = it.tiles[0];
          if (it.tiles.length > 1) return <SplitPill tiles={it.tiles} b={b()} />;
          if (t.shape === "circle") return <Circle t={t} b={b()} />;
          if (it.w >= 2 || t.sub || t.live) return <PillTile t={t} b={b()} wideCells={it.w >= 2} />;
          return <IconTile t={t} b={b()} active={props.active} />;
        }}
      </For>
    </View>
  );
}
