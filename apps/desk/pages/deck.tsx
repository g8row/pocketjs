// DECK: the stream-deck grid. Tiles come from deckd (`desk.deck.tiles`, edited in deck studio) and are
// packed into a 4×3 grid; tapping one calls `act(tile.id)`. Every tile is drawn by what it is:
//   split pill   consecutive tiles sharing a `group` (vertical when tall); a full-height split column
//                is a narrow rail, and a 2-member rail with a live `level` shows it between the halves
//   circle       shape "circle" (the mic): big icon + state
//   pill         a tile with something to say (`sub`, a live value) or ≥ 2 cells wide: icon + text
//   icon tile    everything else: just the icon
//
// Style (DESIGN.md §2): every tile is touchable, so rounded, dark (C.raised, 1 px #262626 outline) with a
// single-colour Nerd Font icon. Colour means state only: an `on` / `fill` tile (or a running live value)
// takes its tile colour as outline + ink over a faint tint of the same colour. Readouts are mono.
//
// The core has one radius per box, so a split pill's segment is a full pill with a tight-radius box over
// its inner end ("round outside, tight in the middle"). The outline is drawn as two opaque layers (outline
// colour, then the fill inset by 1 px) so the overlapping boxes leave no seams.

import { For, Show, createMemo } from "solid-js";
import { Text, View, type NodeMirror } from "@pocketjs/framework/components";
import { jump, spring } from "@pocketjs/framework/animation";
import { act, desk } from "../link.ts";
import { TILE_HEX, accent } from "../theme.ts";
import { C, Icon, PH, PW, TBox } from "../ui.tsx";

type Active = () => boolean;
type Tile = any;

const EDGE = "#262626"; // off tile outline
const GREY = "#8a8a8a";
const lower = (s: unknown) => (typeof s === "string" ? s.toLowerCase() : "");
const clip = (s: string, n: number) => (s.length > n ? `${s.slice(0, Math.max(1, n - 1))}…` : s);
const hex = (t: Tile): string => TILE_HEX[t.color] ?? GREY;
const iconOf = (t: Tile): string => (t.on && t.iconOn ? t.iconOn : t.icon);
const focusRunning = (t: Tile) => t.live === "focus" && desk.focus?.mode === "running";
const isOn = (t: Tile) => !!t.on || !!t.fill || focusRunning(t);

/** `hex` over `base` at alpha `a`, as an opaque #rrggbb (stacked boxes must not double the tint). */
function mix(fg: string, base: string, a: number): string {
  const p = (s: string, i: number) => parseInt(s.slice(1 + i * 2, 3 + i * 2), 16);
  let out = "#";
  for (let i = 0; i < 3; i++) out += Math.round(p(fg, i) * a + p(base, i) * (1 - a)).toString(16).padStart(2, "0");
  return out;
}
/** A tile's paint: fill, outline, ink (icon/text) and note (small mono text). */
function paint(t: Tile, on: boolean) {
  if (!on) return { fill: C.raised, edge: EDGE, ink: C.fg, note: C.mute };
  const h = hex(t);
  return { fill: mix(h, C.ground, 0.15), edge: h, ink: h, note: h };
}

// ---- packing (pure; copied from the old deck) ----------------------------------------------

const COLS = 4;
const ROWS = 3;
interface Item {
  tiles: Tile[];
  col: number;
  row: number;
  w: number;
  h: number;
}
interface Box {
  x: number;
  y: number;
  w: number;
  h: number;
}

/** Group consecutive same-`group` tiles, then place each item at the first free cell (row-major) where
 *  its span fits; one that fits nowhere is tried as 1×1, then dropped. */
function pack(tiles: Tile[]): Item[] {
  const items: { tiles: Tile[]; w: number; h: number }[] = [];
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

// Page geometry: 8 px margin (the nav rule is right above), 8 px gaps, 58 px rails.
const PAD = 8;
const GAP = 8;
const RAIL = 58;

/** A column holding only one full-height split pill is a rail. */
const isRailCol = (items: Item[], c: number) => {
  const inCol = items.filter((it) => it.col <= c && c < it.col + it.w);
  return inCol.length === 1 && inCol[0]!.w === 1 && inCol[0]!.h === ROWS && inCol[0]!.tiles.length > 1;
};

/** Pixel boxes for the packed items (page coordinates). */
function layout(items: Item[], W: number, H: number): Box[] {
  const rails = Array.from({ length: COLS }, (_, c) => isRailCol(items, c));
  const free = W - 2 * PAD - GAP * (COLS - 1) - rails.filter(Boolean).length * RAIL;
  const flex = rails.filter((r) => !r).length;
  const cw = rails.map((r) => (r ? RAIL : free / flex));
  const cx = cw.map((_, c) => PAD + cw.slice(0, c).reduce((a, b) => a + b, 0) + GAP * c);
  const rh = (H - 2 * PAD - GAP * (ROWS - 1)) / ROWS;
  const ry = (r: number) => PAD + r * (rh + GAP);
  const R = Math.round;
  return items.map((it) => {
    const x = cx[it.col]!;
    const x2 = cx[it.col + it.w - 1]! + cw[it.col + it.w - 1]!;
    const y = ry(it.row);
    const y2 = ry(it.row + it.h - 1) + rh;
    return { x: R(x), y: R(y), w: R(x2) - R(x), h: R(y2) - R(y) };
  });
}

// ---- pieces ----------------------------------------------------------------------------------

/** A pressable box that squishes on tap and runs the tile's action. */
function Press(props: { id: string; style: Record<string, number | string>; row?: boolean; children?: any }) {
  let n: NodeMirror | undefined;
  return (
    <View
      ref={(x: NodeMirror) => (n = x)}
      class={props.row ? "absolute flex-row items-center" : "absolute items-center justify-center"}
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

/** The tile's icon, or its label when it has none. */
function Glyph(props: { t: Tile; ink: string; size: "lg" | "xl" | "2xl" | "4xl"; chars: number }) {
  return (
    <Show when={props.t.icon} fallback={<Text class="text-base" style={{ textColor: props.ink }}>{clip(lower(props.t.label) || " ", props.chars)}</Text>}>
      <Icon name={iconOf(props.t)} size={props.size} color={props.ink} />
    </Show>
  );
}

const TIGHT = 8; // inner-end radius of a split segment

/** One member of a split pill. Outer end(s) fully round, inner end(s) tight; outline via two layers. */
function Segment(props: { t: Tile; box: Box; vertical: boolean; first: boolean; last: boolean }) {
  const p = () => paint(props.t, isOn(props.t));
  const { w, h } = props.box;
  const rad = Math.floor(Math.min(w, h) / 2);
  const len = props.vertical ? h : w;
  const half = Math.floor(Math.min(rad + 1, len / 2));
  const solo = props.first && props.last;
  const mid = !props.first && !props.last;
  // the tight box over the inner end (none for a lone segment; a middle one is tight all over)
  const cover: Box | null = solo || mid ? null
    : props.vertical ? (props.first ? { x: 0, y: h - half, w, h: half } : { x: 0, y: 0, w, h: half })
    : props.first ? { x: w - half, y: 0, w: half, h } : { x: 0, y: 0, w: half, h };
  const baseR = mid ? TIGHT : rad;
  return (
    <Press id={props.t.id} style={{ insetL: props.box.x, insetT: props.box.y, width: w, height: h }}>
      <View class="absolute" style={{ insetL: 0, insetT: 0, width: w, height: h, radius: baseR, bgColor: p().edge }} />
      <Show when={cover}>
        {(c) => <View class="absolute" style={{ insetL: c().x, insetT: c().y, width: c().w, height: c().h, radius: TIGHT, bgColor: p().edge }} />}
      </Show>
      <View class="absolute" style={{ insetL: 1, insetT: 1, width: w - 2, height: h - 2, radius: baseR - 1, bgColor: p().fill }} />
      <Show when={cover}>
        {(c) => <View class="absolute" style={{ insetL: c().x + 1, insetT: c().y + 1, width: c().w - 2, height: c().h - 2, radius: TIGHT - 1, bgColor: p().fill }} />}
      </Show>
      <Glyph t={props.t} ink={p().ink} size={Math.min(w, h) >= 56 ? "4xl" : "2xl"} chars={Math.max(3, Math.floor((w - 12) / 9))} />
    </Press>
  );
}

const METER = 8; // cells in the rail's level meter
const CELL = "▃▃"; // one meter cell: lower blocks, so stacked lines leave a gap

/** The read-only level between a rail's halves: the number and a vertical block meter. Square frame
 *  (terminal style), since it isn't a button. */
function Level(props: { level: () => number; box: Box }) {
  const n = () => Math.max(0, Math.min(METER, Math.round((props.level() / 100) * METER)));
  return (
    <View
      class="absolute flex-col items-center justify-center border gap-[3]"
      style={{ insetL: props.box.x, insetT: props.box.y, width: props.box.w, height: props.box.h, borderColor: C.frame }}
    >
      <Text class="text-base font-bold" style={{ textColor: C.fg }}>{`${Math.round(props.level())}`}</Text>
      <View class="flex-col items-center">
        <For each={Array.from({ length: METER }, (_, i) => METER - 1 - i)}>
          {(i) => (
            <Text class="text-xs font-bold leading-[7]" style={{ textColor: i < n() ? accent() : C.dim }}>
              {CELL}
            </Text>
          )}
        </For>
      </View>
    </View>
  );
}

const SEG_GAP = 6; // between a split pill's members (touch targets ≥ 6 px apart)
const LV = 108; // the level readout between a rail's halves

function SplitPill(props: { tiles: Tile[]; b: Box }) {
  const vertical = props.b.h > props.b.w;
  const level = () => props.tiles.find((t) => typeof t.level === "number")?.level as number | undefined;
  const withLevel = vertical && props.tiles.length === 2 && typeof props.tiles.find((t) => typeof t.level === "number")?.level === "number";
  const segs = createMemo(() => {
    const n = props.tiles.length;
    const { x, y, w, h } = props.b;
    const lv = withLevel ? LV + SEG_GAP : 0;
    const len = ((vertical ? h : w) - lv - SEG_GAP * (n - 1)) / n;
    const R = Math.round;
    return props.tiles.map((t, i) => {
      const a = R(i * (len + SEG_GAP) + (i > 0 ? lv : 0));
      const b = R(i * (len + SEG_GAP) + (i > 0 ? lv : 0) + len);
      const box = vertical ? { x, y: y + a, w, h: b - a } : { x: x + a, y, w: b - a, h };
      return { t, box, first: i === 0, last: i === n - 1 };
    });
  });
  const lvBox = (): Box => {
    const s0 = segs()[0]!.box;
    const y = s0.y + s0.h + SEG_GAP;
    return { x: props.b.x, y, w: props.b.w, h: segs()[1]!.box.y - SEG_GAP - y };
  };
  return (
    <>
      <For each={segs()}>{(s) => <Segment t={s.t} box={s.box} vertical={vertical} first={s.first} last={s.last} />}</For>
      <Show when={withLevel}>
        <Level level={() => level() ?? 0} box={lvBox()} />
      </Show>
    </>
  );
}

function Circle(props: { t: Tile; b: Box }) {
  const d = (Math.min(props.b.w, props.b.h) - 4) & ~1; // even → whole-px radius
  const on = () => isOn(props.t);
  const p = () => paint(props.t, on());
  const word = () => clip(lower(props.t.sub || props.t.label) || " ", Math.floor((d - 30) / 7));
  return (
    <Press
      id={props.t.id}
      style={{
        insetL: Math.round(props.b.x + (props.b.w - d) / 2),
        insetT: Math.round(props.b.y + (props.b.h - d) / 2),
        width: d,
        height: d,
        radius: d / 2,
        bgColor: p().fill,
        borderColor: p().edge,
        borderWidth: 1,
      }}
    >
      <View class="flex-col items-center gap-[6]">
        <Show when={props.t.icon} fallback={<Text class="text-xl" style={{ textColor: p().ink }}>{clip(lower(props.t.label) || " ", Math.floor(d / 12))}</Text>}>
          <Icon name={iconOf(props.t)} size={d >= 90 ? "4xl" : "2xl"} color={p().ink} />
        </Show>
        <View class="flex-row items-center gap-[5]">
          <Text class="text-xs font-bold" style={{ textColor: on() ? p().ink : C.soft }}>●</Text>
          <Text class="text-xs font-bold" style={{ textColor: p().note }}>{word()}</Text>
        </View>
      </View>
    </Press>
  );
}

/** [headline, note] of a pill. A focus tile reads deckd's focus state (it ticks every second). */
function texts(t: Tile, wide: boolean): [string, string] {
  if (t.live === "focus") {
    const f = desk.focus;
    if (f && f.left) return [f.left, f.mode === "running" ? "focus" : f.mode === "paused" ? "paused" : lower(t.label)];
    return [lower(t.sub) || "--:--", lower(t.label)];
  }
  if (!wide && t.sub) return [lower(t.sub), lower(t.label)];
  return [lower(t.label), lower(t.sub || "")];
}

/** The head line of a pill: mono for a clock, Geist otherwise. */
function Head(props: { text: string; ink: string; clock: boolean; big: boolean }) {
  return (
    <Show
      when={props.clock}
      fallback={
        <Show when={props.big} fallback={<Text class="text-lg" style={{ textColor: props.ink }}>{props.text}</Text>}>
          <Text class="text-xl" style={{ textColor: props.ink }}>{props.text}</Text>
        </Show>
      }
    >
      <Show when={props.big} fallback={<Text class="text-base font-bold" style={{ textColor: props.ink }}>{props.text}</Text>}>
        <Text class="text-xl font-bold" style={{ textColor: props.ink }}>{props.text}</Text>
      </Show>
    </Show>
  );
}

function PillTile(props: { t: Tile; b: Box; wide: boolean }) {
  const on = () => isOn(props.t);
  const p = () => paint(props.t, on());
  const { w, h } = props.b;
  const clock = () => props.t.live === "focus";
  const tx = () => texts(props.t, props.wide);
  const icon = () => (props.t.icon ? iconOf(props.t) : "dot");
  const frame = {
    insetL: props.b.x,
    insetT: props.b.y,
    width: w,
    height: h,
    radius: Math.floor(Math.min(w, h) / 2),
    borderWidth: 1,
  };
  if (!props.wide) {
    // one cell: an oval; icon + head line across its widest part, the note centred below
    const room = w - 20 - 22;
    const head = () => clip(tx()[0] || " ", Math.max(3, Math.floor(room / (clock() ? 9.6 : 9.5))));
    const note = () => clip(tx()[1], Math.max(3, Math.floor((w - 30) / 7.3)));
    return (
      <Press id={props.t.id} style={{ ...frame, bgColor: p().fill, borderColor: p().edge }}>
        <View class="flex-col items-center gap-[1]">
          <View class="flex-row items-center gap-[6]">
            <Icon name={icon()} size="2xl" color={p().ink} />
            <Head text={head()} ink={p().ink} clock={clock()} big={false} />
          </View>
          <Show when={tx()[1]}>
            <Text class="text-xs font-bold" style={{ textColor: p().note }}>{note()}</Text>
          </Show>
        </View>
      </Press>
    );
  }
  // ≥ 2 cells: a pill with the icon in a round chip, text beside it
  const chip = Math.min(h - 18, 50) & ~1;
  const room = w - chip - (h - chip) / 2 - 12 - h / 4; // text width up to where the round end starts to bite
  const head = () => clip(tx()[0] || " ", Math.max(3, Math.floor(room / (clock() ? 12 : 11))));
  const note = () => clip(tx()[1], Math.max(3, Math.floor(room / 7.3)));
  return (
    <Press id={props.t.id} row style={{ ...frame, bgColor: p().fill, borderColor: p().edge, paddingL: Math.round((h - chip) / 2), gap: 12 }}>
      <View
        class="items-center justify-center border"
        style={{ width: chip, height: chip, radius: chip / 2, bgColor: on() ? mix(hex(props.t), C.ground, 0.28) : C.card, borderColor: on() ? p().edge : EDGE }}
      >
        <Icon name={icon()} size="4xl" color={p().ink} />
      </View>
      <View class="flex-col">
        <Head text={head()} ink={p().ink} clock={clock()} big />
        <Show when={tx()[1]}>
          <Text class="text-xs font-bold" style={{ textColor: p().note }}>{note()}</Text>
        </Show>
      </View>
    </Press>
  );
}

function IconTile(props: { t: Tile; b: Box }) {
  const p = () => paint(props.t, isOn(props.t));
  return (
    <Press
      id={props.t.id}
      style={{
        insetL: props.b.x,
        insetT: props.b.y,
        width: props.b.w,
        height: props.b.h,
        radius: Math.min(20, Math.floor(Math.min(props.b.w, props.b.h) / 2)),
        bgColor: p().fill,
        borderColor: p().edge,
        borderWidth: 1,
      }}
    >
      <Glyph t={props.t} ink={p().ink} size="4xl" chars={Math.max(3, Math.floor((props.b.w - 16) / 9))} />
    </Press>
  );
}

// ---- page ------------------------------------------------------------------------------------

export function DeckPage(props: { active: Active }) {
  void props; // no per-frame work: tiles repaint from the store
  // Re-pack only when ids/spans/groups/kinds change: live fields (on, sub text, level) are read from the
  // store proxies inside each tile, so a state push repaints a label instead of rebuilding the page.
  const sig = (xs: Item[]) =>
    xs.map((it) => `${it.tiles.map((t) => `${t.id}:${t.shape ?? ""}:${t.sub ? 1 : 0}:${t.live ?? ""}:${t.icon ? 1 : 0}`).join("+")}@${it.col},${it.row},${it.w},${it.h}`).join("|");
  const items = createMemo(() => pack((desk.deck?.tiles ?? []).slice(0, 12)), [], { equals: (a, b) => sig(a) === sig(b) });
  const boxes = createMemo(() => layout(items(), PW, PH));
  return (
    <View class="relative" style={{ width: PW, height: PH }}>
      <Show
        when={items().length > 0}
        fallback={
          <View class="absolute" style={{ insetL: PAD, insetT: PAD, width: PW - 2 * PAD, height: PH - 2 * PAD }}>
            <TBox title="DECK" right="0 tiles" grow>
              <View class="flex-1 flex-col items-center justify-center gap-[6]">
                <Icon name="grid" size="2xl" color={C.mute} />
                <Text class="text-xs font-bold" style={{ textColor: C.soft }}>no tiles yet</Text>
                <Text class="text-xs font-bold" style={{ textColor: C.mute }}>add tiles in deck studio</Text>
              </View>
            </TBox>
          </View>
        }
      >
        <For each={items()}>
          {(it, i) => {
            const b = () => boxes()[i()]!;
            const t = it.tiles[0];
            if (it.tiles.length > 1) return <SplitPill tiles={it.tiles} b={b()} />;
            if (t.shape === "circle") return <Circle t={t} b={b()} />;
            if (it.w >= 2 || t.sub || t.live) return <PillTile t={t} b={b()} wide={it.w >= 2} />;
            return <IconTile t={t} b={b()} />;
          }}
        </For>
      </Show>
    </View>
  );
}
