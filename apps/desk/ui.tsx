// The PocketDeck UI kit. One rule on every page:
//   read-only  → terminal: square 1 px frames with the title in the border, mono type,
//                block bars (████░░) and sparklines (▁▃▅▇)            — TBox, TBar, TSpark
//   touchable  → rounded: pills, chips, segmented switches, toggles, sliders, sheets
//                                                                      — Btn, Chip, Seg, Toggle, Slider, Sheet
// Icons are single-colour Nerd Font glyphs (nf.ts) drawn as mono text  — Icon
//
// Geometry: panes are PW × PH logical px and start at screen (PANE_X, PANE_Y): the strip left of
// PANE_X is the rail over the damaged panel area (rail.tsx), the nav strip is above PANE_Y.
// Components that hit-test touches themselves (Slider) need their screen position.

import { For, Show, createSignal, type JSX } from "solid-js";
import { Text, View, type NodeMirror } from "@pocketjs/framework/components";
import { onFrame } from "@pocketjs/framework/lifecycle";
import { jump, spring } from "@pocketjs/framework/animation";
import { cancelTouchTap, touches } from "@pocketjs/framework/input";
import { gesture } from "./pager.tsx";
import { glyph } from "./nf.ts";
import { SAFE_X, PANE_TOP } from "./damage.ts";
import { ON_ACCENT, accent } from "./theme.ts";

// ---- geometry and tokens --------------------------------------------------------------

export const PANE_X = SAFE_X; // 106
export const PANE_Y = PANE_TOP; // 29
export const PW = 512 - SAFE_X; // 406
export const PH = 300 - PANE_TOP; // 271

export const C = {
  ground: "#070707", // screen / pane background; TBox titles sit on it
  bg: "#0a0a0a",
  card: "#141414",
  raised: "#1d1d1d", // rounded controls
  line: "#222222",
  line2: "#363636", // rounded control outline
  frame: "#3a3a3a", // terminal frame
  dim: "#3a3a3a", // empty bar cells
  mute: "#8a8a8a",
  soft: "#b3b3b3",
  fg: "#ededed",
  wait: "#ffd27a",
  ok: "#9ee6c3",
  rose: "#ffb4a8",
  onWait: "#2b1e05",
  onRose: "#2b0f0b",
} as const;

// Text sizes the fonts are baked at (class strings must be literals).
type Size = "xs" | "sm" | "base" | "lg" | "xl" | "2xl" | "4xl";
const MONO: Record<Size, string> = {
  xs: "text-xs font-bold",
  sm: "text-sm font-bold",
  base: "text-base font-bold",
  lg: "text-lg font-bold",
  xl: "text-xl font-bold",
  "2xl": "text-2xl font-bold",
  "4xl": "text-4xl font-bold",
};

// ---- icons ------------------------------------------------------------------------------

/** A Nerd Font icon, tinted like text. `name` is an nf.ts key (unknown names draw a dot). */
export function Icon(props: { name: string; size?: Size; color?: string }) {
  return (
    <Text class={MONO[props.size ?? "base"]} style={{ textColor: props.color ?? C.fg }}>
      {glyph(props.name)}
    </Text>
  );
}

// ---- terminal (read-only) ---------------------------------------------------------------------

/** Square frame with its title cut into the top border (and an optional right label / icon).
 *  Read-only content only. `bg` must be the surface the frame sits on (the title's backing). */
export function TBox(props: {
  title?: string;
  right?: string;
  rightIcon?: string;
  hot?: boolean;
  color?: string; // frame + title colour when hot (default accent)
  w?: number;
  h?: number;
  grow?: boolean;
  bg?: string;
  pad?: number;
  children?: JSX.Element;
}) {
  const col = () => (props.hot ? props.color ?? accent() : C.frame);
  const ttl = () => (props.hot ? props.color ?? accent() : C.mute);
  const pad = props.pad ?? 7;
  return (
    <View
      class={props.grow ? "relative flex-1" : "relative"}
      style={{ ...(props.w ? { width: props.w } : {}), ...(props.h ? { height: props.h } : {}), paddingT: 6 }}
    >
      <View class="flex-1 flex-col border" style={{ borderColor: col(), paddingL: pad, paddingR: pad, paddingT: pad + 1, paddingB: pad - 1 }}>
        {props.children}
      </View>
      <Show when={props.title}>
        <View class="absolute flex-row" style={{ insetT: 0, insetL: 6, bgColor: props.bg ?? C.ground, paddingL: 4, paddingR: 4 }}>
          <Text class="text-xs font-bold tracking-wide" style={{ textColor: ttl() }}>{props.title}</Text>
        </View>
      </Show>
      <Show when={props.right || props.rightIcon}>
        <View class="absolute flex-row items-center gap-[3]" style={{ insetT: 0, insetR: 6, bgColor: props.bg ?? C.ground, paddingL: 4, paddingR: 4 }}>
          <Show when={props.right}>
            <Text class="text-xs font-bold" style={{ textColor: C.mute }}>{props.right}</Text>
          </Show>
          <Show when={props.rightIcon}>
            <Icon name={props.rightIcon!} size="xs" color={C.mute} />
          </Show>
        </View>
      </Show>
    </View>
  );
}

const FULL = "█";
const EMPTY = "░";
/** Block bar: `cells` characters, the first value×cells filled. Fixed width (no relayout on change). */
export function TBar(props: { value: () => number; cells: number; size?: Size; color?: string }) {
  const n = () => Math.max(0, Math.min(props.cells, Math.round(props.value() * props.cells)));
  const cls = MONO[props.size ?? "xs"];
  return (
    <View class="flex-row">
      <Text class={cls} style={{ textColor: props.color ?? accent() }}>{FULL.repeat(n()) || " "}</Text>
      <Text class={cls} style={{ textColor: C.dim }}>{EMPTY.repeat(props.cells - n()) || " "}</Text>
    </View>
  );
}

const SPARK = "▁▂▃▄▅▆▇█";
/** One-line sparkline from values (0..max), newest last. */
export function TSpark(props: { values: () => number[]; max: number; size?: Size; color?: string }) {
  const s = () => {
    const vs = props.values();
    if (!vs.length) return " ";
    let out = "";
    for (const v of vs) out += SPARK[Math.max(0, Math.min(7, Math.round((v / (props.max || 1)) * 7)))];
    return out;
  };
  return (
    <Text class={MONO[props.size ?? "sm"]} style={{ textColor: props.color ?? accent() }}>
      {s()}
    </Text>
  );
}

/** A key → value row in mono (`soc   44 °C`). */
export function KV(props: { k: string; v: string; kw?: number; color?: string }) {
  return (
    <View class="flex-row">
      <Text class="text-xs font-bold" style={{ width: props.kw ?? 42, textColor: C.mute }}>{props.k}</Text>
      <Text class="text-xs font-bold" style={{ textColor: props.color ?? C.fg }}>{props.v}</Text>
    </View>
  );
}

// ---- rounded (touchable) ---------------------------------------------------------------------

/** Squish feedback shared by the touchables. */
function squish(n: NodeMirror | undefined, to = 0.92) {
  if (!n) return;
  jump(n, "scale", to);
  spring(n, "scale", 1);
}

export type BtnKind = "default" | "primary" | "warn" | "danger" | "wait" | "ghost";
/** Rounded pill button: label and/or icon. `danger` is the filled rose confirm button. */
export function Btn(props: {
  label?: string;
  icon?: string;
  kind?: BtnKind;
  w?: number;
  h?: number;
  grow?: boolean;
  onPress: () => void;
}) {
  let n: NodeMirror | undefined;
  const k = () => props.kind ?? "default";
  const fill = () => ({ default: C.raised, primary: accent(), warn: C.raised, danger: C.rose, wait: C.wait, ghost: "#00000000" })[k()];
  const edge = () => ({ default: C.line2, primary: accent(), warn: "#5a3a36", danger: C.rose, wait: C.wait, ghost: "#00000000" })[k()];
  const ink = () => ({ default: C.fg, primary: ON_ACCENT, warn: C.rose, danger: C.onRose, wait: C.onWait, ghost: C.soft })[k()];
  const h = props.h ?? 26;
  return (
    <View
      ref={(x: NodeMirror) => (n = x)}
      class={props.grow ? "flex-1 flex-row rounded-[999] border items-center justify-center gap-[6] px-3" : "flex-row rounded-[999] border items-center justify-center gap-[6] px-3"}
      style={{ height: h, ...(props.w ? { width: props.w } : {}), ...(props.grow ? { basis: 0 } : {}), bgColor: fill(), borderColor: edge() }}
      focusable
      onPress={() => {
        squish(n);
        props.onPress();
      }}
    >
      <Show when={props.icon}>
        <Icon name={props.icon!} size={h >= 36 ? "xl" : "base"} color={ink()} />
      </Show>
      <Show when={props.label}>
        <Text class={h >= 34 ? "text-base" : "text-sm"} style={{ textColor: ink() }}>{props.label}</Text>
      </Show>
    </View>
  );
}

/** Rounded selectable chip (sessions, filters). */
export function Chip(props: { label: string; on?: boolean; color?: string; dot?: string; note?: string; onPress: () => void }) {
  let n: NodeMirror | undefined;
  const col = () => props.color;
  return (
    <View
      ref={(x: NodeMirror) => (n = x)}
      class="flex-row items-center gap-[6] rounded-[999] border px-[10]"
      style={{ height: 22, bgColor: props.on ? C.raised : C.bg, borderColor: col() ?? (props.on ? "#4a4a4a" : C.line2) }}
      focusable
      onPress={() => {
        squish(n, 0.94);
        props.onPress();
      }}
    >
      <Show when={props.dot}>
        <View class="w-[7] h-[7] rounded-[2]" style={{ bgColor: props.dot! }} />
      </Show>
      <Text class="text-sm" style={{ textColor: col() ?? (props.on ? "#ffffff" : C.soft) }}>{props.label}</Text>
      <Show when={props.note}>
        <Text class="text-xs font-bold" style={{ textColor: col() ?? C.mute }}>{props.note}</Text>
      </Show>
    </View>
  );
}

/** Rounded segmented switch. */
export function Seg(props: { options: string[]; value: () => string; onChange: (v: string) => void }) {
  return (
    <View class="flex-row rounded-[999] border overflow-hidden" style={{ height: 22, borderColor: C.line2 }}>
      <For each={props.options}>
        {(o) => (
          <View
            class="h-full items-center justify-center px-[10]"
            style={{ bgColor: props.value() === o ? C.raised : "#00000000" }}
            focusable
            onPress={() => props.onChange(o)}
          >
            <Text class="text-xs font-bold" style={{ textColor: props.value() === o ? C.fg : C.soft }}>{o}</Text>
          </View>
        )}
      </For>
    </View>
  );
}

/** Rounded on/off toggle. */
export function Toggle(props: { on: () => boolean; onChange: (v: boolean) => void }) {
  let knob: NodeMirror | undefined;
  let shown: boolean | undefined;
  onFrame(() => {
    const v = props.on();
    if (v !== shown && knob) {
      shown = v;
      spring(knob, "translateX", v ? 13 : 0);
    }
  });
  return (
    <View
      class="rounded-[999] justify-center"
      style={{ width: 30, height: 17, paddingL: 2, bgColor: props.on() ? accent() : "#2a2a2a" }}
      focusable
      onPress={() => props.onChange(!props.on())}
    >
      <View
        ref={(x: NodeMirror) => (knob = x)}
        class="rounded-[999]"
        style={{ width: 13, height: 13, translateX: 0, bgColor: props.on() ? ON_ACCENT : "#6a6a6a" }}
      />
    </View>
  );
}

/** Rounded slider (0..1). Hit-tests touches itself, so it needs its SCREEN position (x, y) and size;
 *  a drag claims the gesture so the pager doesn't swipe. `onChange` fires on release with the final
 *  value (`onInput` while dragging). */
export function Slider(props: {
  x: number;
  y: number;
  w: number;
  value: () => number;
  onInput?: (v: number) => void;
  onChange: (v: number) => void;
  active: () => boolean;
}) {
  const H = 24; // touch band height around the 6 px track
  const [drag, setDrag] = createSignal<number | null>(null);
  let held = false;
  const v = () => drag() ?? props.value();
  const at = (tx: number) => Math.max(0, Math.min(1, (tx - props.x) / props.w));
  onFrame(() => {
    if (!props.active()) return;
    const t = touches()[0];
    if (t) {
      if (!held && gesture.owner === "" && t.x >= props.x - 8 && t.x < props.x + props.w + 8 && t.y >= props.y && t.y < props.y + H) {
        held = true;
        gesture.owner = "slider";
        cancelTouchTap();
      }
      if (held) {
        const nv = at(t.x);
        setDrag(nv);
        props.onInput?.(nv);
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
  const fillW = () => Math.max(3, Math.round(v() * props.w));
  return (
    <View class="relative justify-center" style={{ width: props.w, height: H }}>
      <View class="absolute rounded-[3]" style={{ insetL: 0, insetT: 9, width: props.w, height: 6, bgColor: "#2a2a2a" }} />
      <View class="absolute rounded-[3]" style={{ insetL: 0, insetT: 9, width: fillW(), height: 6, bgColor: accent() }} />
      <View class="absolute rounded-[999]" style={{ insetT: 3, insetL: Math.round(v() * (props.w - 18)), width: 18, height: 18, bgColor: C.fg }} />
    </View>
  );
}

/** Rounded bottom sheet over the pane (confirmations). Springs in when `open()`. */
export function Sheet(props: { open: () => boolean; color?: string; children: JSX.Element }) {
  let n: NodeMirror | undefined;
  let shown = false;
  onFrame(() => {
    const want = props.open();
    if (want !== shown && n) {
      shown = want;
      spring(n, "translateY", want ? 0 : 160);
    }
  });
  return (
    <View class="absolute" style={{ insetL: 8, insetR: 8, insetB: 8 }}>
      <View
        ref={(x: NodeMirror) => (n = x)}
        class="w-full rounded-[22] border flex-row items-center gap-3 p-3"
        style={{ translateY: 160, bgColor: C.card, borderColor: props.color ?? accent() }}
      >
        {props.children}
      </View>
    </View>
  );
}
