// Claude pane v5, the "conversation" layout (deskd/mockups/claude-pane.html):
// session chips on top; your last prompt and Claude's last reply in large,
// scrollable type on the left; one side card on the right that IS the state
// (blue = working, amber = needs you, green = done). A question or a plan
// takes over the left column, because answering is the only thing to do.
// Tap the reply to read it full width. Plus two app-wide layers: the
// permission sheet (other panes only) and the attention flash/toast.

import { For, Index, Show, createEffect, createMemo, createSignal, on } from "solid-js";
import { Text, View, type NodeMirror } from "@pocketjs/framework/components";
import { onFrame } from "@pocketjs/framework/lifecycle";
import { jump, spring } from "@pocketjs/framework/animation";
import { cancelTouchTap, touches } from "@pocketjs/framework/input";
import { act, desk } from "./link.ts";
import { Morph } from "./shapes.tsx";
import { gesture } from "./pager.tsx";
import { ON_ACCENT, T, accent } from "./theme.ts";
import { DECOR_STEP, decorFrame } from "./clock.ts";

type Active = () => boolean;
const clip = (s: unknown, n: number): string => {
  const str = typeof s === "string" ? s : "";
  return str.length > n ? `${str.slice(0, n - 1)}…` : str;
};
const lower = (s: unknown) => (typeof s === "string" ? s.toLowerCase() : "");

const WAIT = "#ffd27a";
const ON_WAIT = "#2b1e05";
const OK = "#9ee6c3";

// ---- geometry (logical px; the pane sits under the 28 px nav + 1 px rule) ----
const TOP = 29; // pane origin on screen
const PAD = 8;
const CHIPS_H = 22;
const BAR_H = 26;
const PANE_H = 300 - TOP;
const MAIN_Y = PAD + CHIPS_H + 8; // 38
const MAIN_H = PANE_H - PAD - BAR_H - 8 - MAIN_Y; // 191
const SIDE_W = 158;
const LEFT_W = 512 - PAD * 2 - 10 - SIDE_W; // 328
const ASK_H = 34; // two mono lines + gap
const REPLY_LEAD = 19;
const STRIP_H = 18;

// ---- text measuring (the core has no word wrap; estimate Geist advances) ----
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
const textW = (s: string, size: number, mono = false) => {
  if (mono) return s.length * size * 0.62;
  let w = 0;
  for (const ch of s) w += em(ch);
  return w * size;
};

/** Word-wrap to `px` wide lines. Keeps blank lines between paragraphs and
 *  indents a bullet's continuation lines. */
export function wrapPx(text: string, px: number, size: number, opts: { mono?: boolean; max?: number } = {}): string[] {
  const max = opts.max ?? 200;
  const lim = px * 0.95;
  const out: string[] = [];
  const paras = text.replace(/\n{3,}/g, "\n\n").split("\n");
  for (const para of paras) {
    if (out.length >= max) break;
    if (!para.trim()) {
      if (out.length && out[out.length - 1] !== "") out.push("");
      continue;
    }
    const bullet = /^\s*• /.test(para);
    const indent = bullet ? "  " : "";
    let line = "";
    for (const word of para.trim().split(/\s+/)) {
      const next = line ? `${line} ${word}` : word;
      if (textW(next, size, opts.mono) <= lim) {
        line = next;
        continue;
      }
      if (line) out.push(line);
      line = indent + word;
      // a single over-long word (a path, a URL): hard-cut it
      while (textW(line, size, opts.mono) > lim && line.length > 4) {
        let cut = line.length - 1;
        while (cut > 4 && textW(line.slice(0, cut), size, opts.mono) > lim) cut--;
        out.push(line.slice(0, cut));
        line = indent + line.slice(cut);
      }
      if (out.length >= max) break;
    }
    if (line && out.length < max) out.push(line);
  }
  while (out.length && out[out.length - 1] === "") out.pop();
  const cut = out.length > max || (out.length === max && truncated(text, out));
  const res = out.slice(0, max);
  if (cut && res.length) res[res.length - 1] = fit(`${res[res.length - 1]} …`, px, size, opts.mono);
  return res;
}
/** True if the wrapped lines dropped words from the end of `text`. */
const truncated = (text: string, lines: string[]) => {
  const words = text.trim().split(/\s+/);
  const last = lines[lines.length - 1]?.trim().split(/\s+/).pop() ?? "";
  return words[words.length - 1] !== last;
};
/** One line, clipped by width with "…" (character-level, for labels). */
function fit(s: unknown, px: number, size: number, mono = false): string {
  const str = typeof s === "string" ? s.replace(/\s+/g, " ") : "";
  if (textW(str, size, mono) <= px) return str;
  let n = str.length;
  while (n > 1 && textW(`${str.slice(0, n)}…`, size, mono) > px) n--;
  return `${str.slice(0, n).trimEnd()}…`;
}

// ---- selection --------------------------------------------------------------------

const [selected, setSelected] = createSignal("");
const [shown, setShown] = createSignal("");
/** Select a session from outside (the toast). */
export const selectSession = setSelected;
/** The session the CLAUDE pane currently shows. */
export const shownSession = shown;

// ---- scroller ---------------------------------------------------------------------

/** A vertical touch scroller. The core has no scroll views: the content moves
 *  by translateY inside an overflow-hidden box, in whole pixels, and the drag
 *  claims the gesture (gesture.owner) so the pager never swipes mid-scroll.
 *  `rect` is the viewport in screen coordinates, for hit-testing touches. */
function Scroller(props: {
  x: number;
  y: number;
  w: number;
  h: number;
  contentH: () => number;
  active: Active;
  reset: () => unknown;
  onTap?: () => void;
  children: any;
}) {
  let content: NodeMirror | undefined;
  let knob: NodeMirror | undefined;
  let off = 0;
  let applied = -1;
  let vel = 0;
  let start: { x: number; y: number; off: number } | null = null;
  let outside = false;
  let dragging = false;
  let lastY = 0;
  const [more, setMore] = createSignal(false);
  const max = () => Math.max(0, props.contentH() - props.h);
  const knobH = () => Math.max(16, Math.round((props.h * props.h) / Math.max(props.h, props.contentH())));
  const apply = () => {
    off = Math.max(0, Math.min(max(), off));
    const r = Math.round(off);
    if (r === applied) return;
    applied = r;
    if (content) jump(content, "translateY", -r);
    const m = max();
    if (knob) jump(knob, "translateY", m > 0 ? Math.round((r / m) * (props.h - knobH())) : 0);
    const want = r < m - 2;
    if (want !== more()) setMore(want);
  };
  createEffect(
    on(props.reset, () => {
      off = 0;
      vel = 0;
      applied = -1;
      apply();
    }),
  );
  createEffect(on(props.contentH, () => apply()));
  onFrame(() => {
    if (!props.active()) return;
    const t = touches()[0];
    const sx = props.x;
    const sy = TOP + props.y;
    if (t) {
      if (!start && !outside) {
        if (t.x >= sx && t.x < sx + props.w && t.y >= sy && t.y < sy + props.h) {
          start = { x: t.x, y: t.y, off };
          lastY = t.y;
          vel = 0;
        } else outside = true;
        return;
      }
      if (!start) return;
      const dx = t.x - start.x;
      const dy = t.y - start.y;
      if (!dragging && max() > 0 && gesture.owner === "" && Math.abs(dy) > 6 && Math.abs(dy) > Math.abs(dx) * 1.2) {
        dragging = true;
        gesture.owner = "scroll";
        cancelTouchTap();
      }
      if (dragging) {
        vel = vel * 0.5 + (lastY - t.y) * 0.5;
        lastY = t.y;
        off = start.off - dy;
        apply();
      }
      return;
    }
    start = null;
    outside = false;
    if (dragging) {
      dragging = false;
      if (gesture.owner === "scroll") gesture.owner = "";
    } else if (Math.abs(vel) > 0.4) {
      off += vel;
      vel *= 0.93;
      apply();
      if (off <= 0 || off >= max()) vel = 0;
    } else vel = 0;
  });
  return (
    <View class="overflow-hidden" style={{ width: props.w, height: props.h }} focusable={!!props.onTap} onPress={props.onTap}>
      <View ref={(n: NodeMirror) => (content = n)} class="flex-col" style={{ width: props.w - 8, translateY: 0 }}>
        {props.children}
      </View>
      <Show when={max() > 0}>
        <View class="absolute w-[2] rounded-[1] bg-[#222222]" style={{ insetR: 0, insetT: 0, height: props.h }}>
          <View ref={(n: NodeMirror) => (knob = n)} class="w-[2] rounded-[1] bg-[#8a8a8a]" style={{ height: knobH(), translateY: 0 }} />
        </View>
      </Show>
      <Show when={more()}>
        <View class="absolute" style={{ insetR: 8, insetB: 4 }}>
          <View class="h-[16] px-2 rounded-[999] items-center justify-center" style={{ bgColor: accent() }}>
            <Text class="text-xs font-bold" style={{ textColor: ON_ACCENT }}>
              more ↓
            </Text>
          </View>
        </View>
      </Show>
    </View>
  );
}

/** Multi-line text block for a Scroller. */
function Lines(props: { lines: () => string[]; cls: string; lead: number; w: number; color?: string }) {
  return (
    <Text class={props.cls} style={{ width: props.w, height: Math.max(1, props.lines().length) * props.lead, textColor: props.color ?? "#ededed" }}>
      {props.lines().join("\n") || " "}
    </Text>
  );
}

// ---- small parts ------------------------------------------------------------------

function Pill(props: { label: string; onPress: () => void; kind?: "primary" | "wait" | "ok" | "ghost"; w?: number; h?: number }) {
  let n: NodeMirror | undefined;
  const press = () => {
    if (n) {
      jump(n, "scale", 0.9);
      spring(n, "scale", 1);
    }
    props.onPress();
  };
  const fill = () => (props.kind === "primary" ? accent() : props.kind === "wait" ? WAIT : props.kind === "ok" ? OK : "#00000000");
  const ink = () => (props.kind === "primary" ? ON_ACCENT : props.kind === "wait" ? ON_WAIT : props.kind === "ok" ? "#0b2410" : props.kind === "ghost" ? "#b3b3b3" : "#ededed");
  return (
    <View
      ref={(x: NodeMirror) => (n = x)}
      class="rounded-[999] border items-center justify-center px-2 active:bg-[#1d1d1d]"
      style={{
        height: props.h ?? BAR_H,
        ...(props.w ? { width: Math.round(props.w) } : {}),
        bgColor: fill(),
        borderColor: props.kind === "ghost" ? "#00000000" : props.kind ? fill() : "#363636",
      }}
      focusable
      onPress={press}
    >
      <Text class={props.h && props.h < 22 ? "text-xs" : "text-sm"} style={{ textColor: ink() }}>
        {props.label}
      </Text>
    </View>
  );
}

function Meter(props: { pct: () => number; w: number; color?: () => string }) {
  return (
    <View class="h-[3] rounded-[2] bg-[#262626] overflow-hidden" style={{ width: props.w }}>
      <View class="h-[3] rounded-[2]" style={{ width: Math.max(2, Math.round((props.w * Math.min(100, props.pct())) / 100)), bgColor: props.color?.() ?? accent() }} />
    </View>
  );
}

const SIDE_IN = SIDE_W - 16 - 2; // inner width of the side card

function Ctx(props: { s: () => any }) {
  const pct = () => props.s().contextPct ?? 0;
  return (
    <View class="flex-col gap-[3]">
      <View class="flex-row justify-between">
        <Text class={T.monoSm}>context</Text>
        <Text class={T.monoSm}>{props.s().ctx || "–"}</Text>
      </View>
      <Meter pct={pct} w={SIDE_IN} color={() => (pct() > 80 ? WAIT : accent())} />
    </View>
  );
}

function Head(props: { left: string; right?: string; color: string }) {
  return (
    <View class="flex-row justify-between h-[14]">
      <Text class="text-xs font-bold tracking-wide" style={{ textColor: props.color }}>
        {props.left.toUpperCase()}
      </Text>
      <Text class="text-xs font-bold" style={{ textColor: props.color }}>
        {props.right ?? ""}
      </Text>
    </View>
  );
}

function Steps(props: { rows: () => { t: string; fail?: boolean }[] }) {
  return (
    <View class="flex-col">
      <Index each={props.rows()}>
        {(r) => (
          <Text class="text-xs font-bold leading-[14]" style={{ width: SIDE_IN, height: 14, textColor: r().fail ? "#ffb4a8" : "#8a8a8a" }}>
            {fit(`${r().fail ? "× " : ""}${r().t}`, SIDE_IN, 12, true)}
          </Text>
        )}
      </Index>
    </View>
  );
}

function Side(props: { tone: "work" | "wait" | "ok"; children: any }) {
  const border = () => (props.tone === "wait" ? WAIT : props.tone === "ok" ? "#2f5a45" : "#222222");
  const bg = () => (props.tone === "wait" ? "#17140c" : props.tone === "ok" ? "#0f1613" : "#141414");
  return (
    <View class="rounded-[14] border flex-col gap-[6] p-2" style={{ width: SIDE_W, height: MAIN_H, borderColor: border(), bgColor: bg() }}>
      {props.children}
    </View>
  );
}

// ---- side cards per state -----------------------------------------------------------

function WorkingCard(props: { s: () => any }) {
  const s = props.s;
  const run = () => desk.claudeTick?.run?.[s().id] ?? "";
  const done = () => s().state === "done";
  const idle = () => s().state === "idle";
  const actLines = () => wrapPx(done() && s().took ? `Took ${s().took}` : (s().now?.text ?? ""), SIDE_IN, 14, { max: 3 });
  return (
    <Side tone={done() ? "ok" : "work"}>
      <Head left={done() ? "finished" : idle() ? "idle" : "now"} right={done() || idle() ? `${desk.claudeTick?.ago?.[s().id] ?? ""} ago` : run()} color={done() ? OK : "#8a8a8a"} />
      <Text class="text-sm text-[#ffffff] leading-[17]" style={{ width: SIDE_IN, height: actLines().length * 17 }}>
        {actLines().join("\n")}
      </Text>
      <Show when={!done() && !!s().now?.sub}>
        <Text class="text-xs font-bold" style={{ textColor: accent() }}>
          {fit(s().now?.sub, SIDE_IN, 12, true)}
        </Text>
      </Show>
      <Steps rows={() => (done() && s().changed?.length ? (s().changed as string[]).slice(0, 3).map((f) => ({ t: `edited ${f}` })) : (s().steps ?? []))} />
      <View class="flex-1" />
      <Ctx s={s} />
    </Side>
  );
}

function PermissionCard(props: { s: () => any }) {
  const h = () => props.s().held ?? {};
  const left = () => desk.claudeTick?.held?.[props.s().id] ?? h().left ?? 0;
  // the countdown's full length = the first value seen for this request
  let firstId = "";
  let first = 1;
  const total = () => {
    if (h().id !== firstId) {
      firstId = h().id;
      first = Math.max(1, left());
    }
    return Math.max(first, left());
  };
  return (
    <Side tone="wait">
      <Head left={`allow ${lower(h().tool || "tool")}?`} right={`${left()}s`} color={WAIT} />
      <View class="rounded-[8] bg-[#000000] border border-[#363636] px-[6] py-[4]">
        <Text class="text-xs font-bold text-[#ffffff] leading-[14]" style={{ width: SIDE_IN - 14, height: 42 }}>
          {wrapPx(h().command ?? "", SIDE_IN - 14, 12, { mono: true, max: 3 }).join("\n")}
        </Text>
      </View>
      <Show when={!!h().why}>
        <Text class="text-xs text-[#b3b3b3] leading-[14]" style={{ width: SIDE_IN, height: 28 }}>
          {wrapPx(h().why, SIDE_IN, 12, { max: 2 }).join("\n")}
        </Text>
      </Show>
      <View class="flex-1" />
      <Meter pct={() => (left() / total()) * 100} w={SIDE_IN} color={() => WAIT} />
      <View class="flex-row gap-[6]">
        <Pill label="deny" w={(SIDE_IN - 6) / 2} onPress={() => act("claude.permit", { id: h().id, allow: false })} />
        <Pill label="allow" kind="wait" w={(SIDE_IN - 6) / 2} onPress={() => act("claude.permit", { id: h().id, allow: true })} />
      </View>
      <Pill label="always allow" kind="ghost" w={SIDE_IN} h={20} onPress={() => act("claude.permit", { id: h().id, allow: true, always: true })} />
    </Side>
  );
}

// ---- left column bodies ---------------------------------------------------------------

function Conversation(props: { s: () => any; active: Active; onRead: () => void }) {
  const s = props.s;
  const ask = () => wrapPx(`you › ${s().prompt || "—"}`, LEFT_W, 12, { mono: true, max: 2 });
  const reply = createMemo(() => wrapPx(s().reply || (s().state === "working" ? "…" : "no reply yet"), LEFT_W - 10, 14, { max: 90 }));
  return (
    <View class="flex-col gap-[6]" style={{ width: LEFT_W, height: MAIN_H }}>
      <Text class="text-xs font-bold leading-[14]" style={{ width: LEFT_W, height: 28, textColor: "#8a8a8a" }}>
        {ask().join("\n")}
      </Text>
      <Scroller x={PAD} y={MAIN_Y + ASK_H} w={LEFT_W} h={MAIN_H - ASK_H} contentH={() => reply().length * REPLY_LEAD} active={props.active} reset={() => `${s().id}|${s().reply?.length ?? 0}`} onTap={props.onRead}>
        <Lines lines={reply} cls="text-sm leading-[19]" lead={REPLY_LEAD} w={LEFT_W - 10} />
      </Scroller>
    </View>
  );
}

/** The question flow: one question per screen, picks kept per held request. */
function createAnswers(s: () => any) {
  const [qi, setQi] = createSignal(0);
  const [picks, setPicks] = createSignal<number[][]>([]);
  createEffect(
    on(
      () => `${s().id}|${s().held?.id ?? ""}|${(s().question ?? []).length}`,
      () => {
        setQi(0);
        setPicks([]);
      },
    ),
  );
  const qs = () => (s().question ?? []) as any[];
  const q = () => qs()[qi()] ?? { q: "", options: [] };
  const mine = () => picks()[qi()] ?? [];
  const toggle = (k: number) => {
    const next = picks().slice();
    const cur = next[qi()] ?? [];
    next[qi()] = q().multi ? (cur.includes(k) ? cur.filter((x) => x !== k) : [...cur, k]) : [k];
    setPicks(next);
  };
  const last = () => qi() >= qs().length - 1;
  const submit = () => act("claude.answer", { id: s().held?.id, answers: qs().map((_, i) => picks()[i] ?? []) });
  return { qi, setQi, qs, q, mine, toggle, last, submit };
}

const OPT_H = 34;
const QHEAD_H = 14 + 4 + 38 + 6;

function QuestionBody(props: { a: ReturnType<typeof createAnswers>; active: Active; s: () => any }) {
  const a = props.a;
  return (
    <View class="flex-col" style={{ width: LEFT_W, height: MAIN_H }}>
      <View class="flex-row items-center gap-2 h-[14]">
        <View class="w-[6] h-[6] rounded-[2]" style={{ bgColor: WAIT }} />
        <Text class="text-xs font-bold tracking-wide" style={{ textColor: WAIT }}>
          {`CLAUDE ASKS · ${(a.q().header || "question").toUpperCase()}`}
        </Text>
        <View class="flex-1" />
        <Index each={a.qs()}>{(_, i) => <View class="w-[12] h-[3] rounded-[2]" style={{ bgColor: i <= a.qi() ? WAIT : "#363636" }} />}</Index>
      </View>
      <View class="h-[4]" />
      <Text class="text-base text-[#ffffff] leading-[19]" style={{ width: LEFT_W, height: 38 }}>
        {wrapPx(a.q().q, LEFT_W, 16, { max: 2 }).join("\n")}
      </Text>
      <View class="h-[6]" />
      <Scroller x={PAD} y={MAIN_Y + QHEAD_H} w={LEFT_W} h={MAIN_H - QHEAD_H} contentH={() => (a.q().options?.length ?? 0) * (OPT_H + 4)} active={props.active} reset={() => `${props.s().id}|${a.qi()}`}>
        <Index each={(a.q().options ?? []) as any[]}>
          {(o, k) => {
            const on_ = () => a.mine().includes(k);
            return (
              <View class="flex-row items-center gap-2 rounded-[10] border px-2 mb-[4]" style={{ width: LEFT_W - 8, height: OPT_H, borderColor: on_() ? WAIT : "#363636", bgColor: on_() ? "#1f1a0e" : "#141414" }} focusable onPress={() => a.toggle(k)}>
                <View class={a.q().multi ? "w-[12] h-[12] rounded-[3] border" : "w-[12] h-[12] rounded-[999] border"} style={{ borderColor: on_() ? WAIT : "#5a5a5a", bgColor: on_() ? WAIT : "#00000000" }} />
                <View class="flex-col">
                  <Text class="text-sm text-[#ffffff]">{fit(o().label, LEFT_W - 50, 14)}</Text>
                  <Text class="text-xs text-[#8a8a8a]">{fit(o().desc, LEFT_W - 50, 12)}</Text>
                </View>
              </View>
            );
          }}
        </Index>
      </Scroller>
    </View>
  );
}

function QuestionCard(props: { a: ReturnType<typeof createAnswers>; s: () => any; peek: () => boolean; setPeek: (v: boolean) => void }) {
  const a = props.a;
  const held = () => !!props.s().held && props.s().held.kind === "question";
  const left = () => desk.claudeTick?.held?.[props.s().id] ?? 0;
  const hint = () =>
    !held()
      ? "Answer on the laptop. The desk gate isn't holding this question."
      : a.q().multi
        ? `Pick any. ${a.mine().length} selected.`
        : "Pick one.";
  return (
    <Side tone="wait">
      <Head left={`question ${a.qi() + 1} of ${a.qs().length}`} right={held() ? `${left()}s` : ""} color={WAIT} />
      <Text class="text-xs text-[#b3b3b3] leading-[15]" style={{ width: SIDE_IN, height: 60 }}>
        {wrapPx(hint(), SIDE_IN, 12, { max: 4 }).join("\n")}
      </Text>
      <View class="flex-1" />
      <Pill label={props.peek() ? "show question" : "show reply"} h={22} onPress={() => props.setPeek(!props.peek())} />
      <Show when={held()}>
        <View class="flex-row gap-[6]">
          <Show when={a.qi() > 0}>
            <Pill label="back" w={(SIDE_IN - 6) / 2} onPress={() => a.setQi(a.qi() - 1)} />
          </Show>
          <Pill
            label={a.last() ? "submit" : "next →"}
            kind="wait"
            w={a.qi() > 0 ? (SIDE_IN - 6) / 2 : SIDE_IN}
            onPress={() => {
              if (!a.mine().length) return;
              if (a.last()) a.submit();
              else a.setQi(a.qi() + 1);
            }}
          />
        </View>
      </Show>
    </Side>
  );
}

function PlanBody(props: { s: () => any; active: Active }) {
  const lines = createMemo(() => wrapPx(props.s().plan || "(the plan text didn't come through; read it on the laptop)", LEFT_W - 10, 14, { max: 120 }));
  return (
    <View class="flex-col gap-[4]" style={{ width: LEFT_W, height: MAIN_H }}>
      <View class="flex-row items-center gap-2 h-[14]">
        <View class="w-[6] h-[6] rounded-[2]" style={{ bgColor: WAIT }} />
        <Text class="text-xs font-bold tracking-wide" style={{ textColor: WAIT }}>
          PLAN
        </Text>
      </View>
      <Scroller x={PAD} y={MAIN_Y + 18} w={LEFT_W} h={MAIN_H - 18} contentH={() => lines().length * REPLY_LEAD} active={props.active} reset={() => `${props.s().id}|${props.s().plan?.length ?? 0}`}>
        <Lines lines={lines} cls="text-sm leading-[19]" lead={REPLY_LEAD} w={LEFT_W - 10} />
      </Scroller>
    </View>
  );
}

function PlanCard(props: { s: () => any; peek: () => boolean; setPeek: (v: boolean) => void }) {
  const h = () => props.s().held;
  const held = () => !!h() && h().kind === "plan";
  const left = () => desk.claudeTick?.held?.[props.s().id] ?? 0;
  return (
    <Side tone="wait">
      <Head left="plan ready" right={held() ? `${left()}s` : ""} color={WAIT} />
      <Text class="text-sm text-[#ffffff] leading-[17]" style={{ width: SIDE_IN, height: 34 }}>
        {held() ? "Review the plan" : "Approve it on the laptop"}
      </Text>
      <Text class="text-xs text-[#8a8a8a]">{held() ? "Scroll to read it." : "The desk gate isn't holding it."}</Text>
      <View class="flex-1" />
      <Pill label={props.peek() ? "show plan" : "show reply"} h={22} w={SIDE_IN} onPress={() => props.setPeek(!props.peek())} />
      <Show when={held()}>
        <Pill label="keep planning" w={SIDE_IN} h={24} onPress={() => act("claude.permit", { id: h().id, allow: false })} />
        <Pill label="approve" kind="wait" w={SIDE_IN} h={24} onPress={() => act("claude.permit", { id: h().id, allow: true })} />
        <Pill label="approve, auto-accept edits" kind="ghost" w={SIDE_IN} h={18} onPress={() => act("claude.permit", { id: h().id, allow: true, mode: "acceptEdits" })} />
      </Show>
    </Side>
  );
}

// ---- chips + bar ------------------------------------------------------------------------

/** Sessions in a stable order (first seen first), so chips never jump under a
 *  finger when deskd re-sorts by state. Up to 4 shown. */
const seen: string[] = [];
function stableSessions(): any[] {
  const list = (desk.claude?.sessions ?? []) as any[];
  for (const s of list) if (!seen.includes(s.id)) seen.push(s.id);
  const rank = (id: string) => seen.indexOf(id);
  return list.slice().sort((a, b) => rank(a.id) - rank(b.id));
}

function Chips(props: { sel: () => any; active: Active }) {
  const sessions = () => {
    const all = stableSessions();
    // a session that needs you always makes the cut
    const top = all.slice(0, 4);
    const wait = all.find((s) => s.state === "waiting" && !top.includes(s));
    return wait ? [...top.slice(0, 3), wait] : top;
  };
  return (
    <View class="flex-row gap-[6]" style={{ height: CHIPS_H }}>
      <For each={sessions()}>
        {(s) => {
          const on_ = () => props.sel()?.id === s.id;
          const wait = () => s.state === "waiting";
          const dot = () => (wait() ? WAIT : s.state === "working" ? accent() : s.state === "done" ? OK : "#4a4a4a");
          return (
            <View
              class="flex-row items-center gap-[6] rounded-[999] border px-[10]"
              style={{ height: CHIPS_H, borderColor: wait() ? WAIT : on_() ? "#4a4a4a" : "#363636", bgColor: on_() ? (wait() ? "#1f1a0e" : "#1d1d1d") : "#0a0a0a" }}
              focusable
              onPress={() => setSelected(s.id)}
            >
              <Show when={s.state === "working"} fallback={<View class="w-[7] h-[7] rounded-[2]" style={{ bgColor: dot() }} />}>
                <Morph size={10} layers={2} spin={() => 4} color={accent} active={props.active} />
              </Show>
              <Text class="text-sm" style={{ textColor: wait() ? WAIT : on_() ? "#ffffff" : "#b3b3b3" }}>
                {lower(clip(s.name, 14))}
              </Text>
              <Show when={wait()}>
                <Text class="text-xs font-bold" style={{ textColor: WAIT }}>
                  {s.question ? "asks" : s.plan ? "plan" : "needs you"}
                </Text>
              </Show>
            </View>
          );
        }}
      </For>
    </View>
  );
}

function Bar(props: { s: () => any; reading: () => boolean; setReading: (v: boolean) => void; asking: () => boolean }) {
  const s = props.s;
  const meta = () => fit([s().model, s().cwd].filter(Boolean).join(" · "), 170, 12, true);
  return (
    <View class="flex-row items-center gap-[6]" style={{ height: BAR_H }}>
      <Show when={props.reading()}>
        <Pill label="← back" onPress={() => props.setReading(false)} />
      </Show>
      <Show when={!props.reading()}>
        <Pill label={props.asking() && !s().held ? "answer on laptop" : "open in claude"} kind="primary" onPress={() => act("claude.focus", { session: s().id })} />
        <Pill label="terminal" onPress={() => act("claude.terminal", { session: s().id })} />
      </Show>
      <Pill label="copy reply" onPress={() => act("claude.copy", { session: s().id })} />
      <View class="flex-1" />
      <Text class={T.monoSm}>{meta()}</Text>
    </View>
  );
}

// ---- the page ---------------------------------------------------------------------------

export function ClaudePage(props: { active: Active }) {
  const sessions = () => (desk.claude?.sessions ?? []) as any[];
  // tapped chip, else a session that needs you, else stay on the one shown
  // (deskd re-sorts by activity; following its first entry made the pane jump)
  const sel = createMemo(
    () =>
      sessions().find((s) => s.id === selected()) ??
      sessions().find((s) => s.state === "waiting") ??
      sessions().find((s) => s.id === shown()) ??
      sessions()[0],
  );
  const s = () => sel() ?? {};
  createEffect(() => setShown(sel()?.id ?? ""));
  const [reading, setReading] = createSignal(false);
  const [peek, setPeek] = createSignal(false);
  const a = createAnswers(s);
  // a session that starts needing you pulls you out of reading mode / peeking
  createEffect(
    on(
      () => `${s().id}|${s().state}|${s().held?.id ?? ""}`,
      () => {
        if (s().state === "waiting") setReading(false);
        setPeek(false);
      },
      { defer: true },
    ),
  );
  const asking = () => !!s().question?.length;
  const planning = () => !asking() && !!s().plan;
  const permission = () => !asking() && !planning() && s().held?.kind === "permission";
  const readLines = createMemo(() => wrapPx(s().reply || "no reply yet", 512 - PAD * 2 - 10, 14, { max: 120 }));
  return (
    <View class="h-full flex-col p-2" style={{ width: 512 }}>
      <Show when={sessions().length > 0}>
        <Show
          when={reading()}
          fallback={
            <>
              <Chips sel={sel} active={props.active} />
              <View class="h-[8]" />
              <View class="flex-row gap-[10]" style={{ height: MAIN_H }}>
                <Show when={(asking() || planning()) && !peek()} fallback={<Conversation s={s} active={props.active} onRead={() => setReading(true)} />}>
                  <Show when={asking()} fallback={<PlanBody s={s} active={props.active} />}>
                    <QuestionBody a={a} s={s} active={props.active} />
                  </Show>
                </Show>
                <Show when={asking()}>
                  <QuestionCard a={a} s={s} peek={peek} setPeek={setPeek} />
                </Show>
                <Show when={planning()}>
                  <PlanCard s={s} peek={peek} setPeek={setPeek} />
                </Show>
                <Show when={permission()}>
                  <PermissionCard s={s} />
                </Show>
                <Show when={!asking() && !planning() && !permission()}>
                  <WorkingCard s={s} />
                </Show>
              </View>
            </>
          }
        >
          {/* reading mode: a one-line status strip, the reply full width */}
          <View class="flex-row items-center gap-2" style={{ height: STRIP_H }}>
            <View class="w-[7] h-[7] rounded-[2]" style={{ bgColor: s().state === "waiting" ? WAIT : s().state === "done" ? OK : accent() }} />
            <Text class="text-sm text-[#ffffff]">{lower(clip(s().name, 16))}</Text>
            <Text class={T.monoSm}>{fit(lower(s().now?.text ?? ""), 220, 12, true)}</Text>
            <View class="flex-1" />
            <Text class={T.monoSm}>context</Text>
            <Meter pct={() => s().contextPct ?? 0} w={60} />
          </View>
          <View class="h-[6]" />
          <Scroller x={PAD} y={PAD + STRIP_H + 6} w={512 - PAD * 2} h={PANE_H - PAD * 2 - STRIP_H - 6 - BAR_H - 8} contentH={() => readLines().length * REPLY_LEAD} active={props.active} reset={() => `${s().id}|${reading()}`} onTap={() => setReading(false)}>
            <Lines lines={readLines} cls="text-sm leading-[19]" lead={REPLY_LEAD} w={512 - PAD * 2 - 10} />
          </Scroller>
        </Show>
        <View class="flex-1" />
        <Bar s={s} reading={reading} setReading={setReading} asking={asking} />
      </Show>
      <Show when={sessions().length === 0}>
        <View class="flex-1 items-center justify-center gap-3">
          <Morph size={56} layers={4} morph={() => 0.5 + 0.5 * Math.sin(Date.now() / 1400)} spin={() => 0.4} color={() => "#262626"} active={props.active} />
          <Text class="text-xl text-[#ededed]">no claude sessions right now</Text>
          <Text class={T.monoSm}>start one on the laptop and it shows up here</Text>
          <Text class="text-xs font-bold" style={{ textColor: desk.claude?.hooks === false ? WAIT : OK }}>
            {desk.claude?.hooks === false ? "hooks not installed" : "✓ hooks installed"}
          </Text>
        </View>
      </Show>
    </View>
  );
}

// ---- app-wide layers -------------------------------------------------------------

/** Bottom sheet for a request held by deskd's gate, on panes other than CLAUDE
 *  (there the side card handles it). Questions and plans only offer "open". */
export function PermissionSheet(props: { onClaude: () => boolean; onOpen: () => void }) {
  const p = () => desk.claude?.pending;
  const simple = () => (p()?.kind ?? "permission") === "permission";
  let sheet: NodeMirror | undefined;
  let isShown = false;
  const [vis, setVis] = createSignal(false);
  onFrame(() => {
    const want = !!p() && desk.layout?.approvals !== false && !props.onClaude();
    if (want !== isShown && sheet) {
      isShown = want;
      setVis(want);
      spring(sheet, "translateY", want ? 0 : 140);
    }
  });
  return (
    <View class="absolute" style={{ insetL: 8, insetR: 8, insetB: 8 }}>
      <View ref={(n: NodeMirror) => (sheet = n)} style={{ translateY: 140, borderColor: WAIT }} class="w-full rounded-[22] bg-[#141414] border flex-row items-center gap-3 p-3">
        <Morph size={44} layers={3} spin={() => 2.5} breathe={() => 0.06} color={() => WAIT} active={vis} />
        <View class="flex-1 flex-col gap-[2]">
          <Text class="text-xs font-bold" style={{ textColor: WAIT }}>
            {`${lower(p()?.session ?? "")} ${simple() ? "asks" : p()?.kind === "plan" ? "has a plan" : "asks you"} · ${desk.claudeTick?.left ?? p()?.left ?? 0}s`}
          </Text>
          <Text class="text-base text-[#ededed]">{simple() ? `allow ${lower(p()?.tool ?? "")}?` : p()?.kind === "plan" ? "approve the plan?" : "a question for you"}</Text>
          <Text class={T.monoSm}>{simple() ? clip(lower(p()?.summary ?? ""), 40) : "open the claude pane to answer"}</Text>
        </View>
        <Show
          when={simple()}
          fallback={
            <Pill label="open →" kind="wait" w={96} h={38} onPress={() => props.onOpen()} />
          }
        >
          <Pill label="deny" w={78} h={38} onPress={() => act("claude.permit", { id: p()?.id, allow: false })} />
          <Pill label="allow" kind="wait" w={86} h={38} onPress={() => act("claude.permit", { id: p()?.id, allow: true })} />
        </Show>
      </View>
    </View>
  );
}

/** Accent flash + a toast when a session newly needs you. On CLAUDE the toast
 *  still shows when the alert is for a session other than the one on screen. */
export function AttentionLayer(props: { onOpen: () => void; onClaude: () => boolean }) {
  let flash: NodeMirror | undefined;
  let toast: NodeMirror | undefined;
  let seq = -1;
  let t = 99;
  let toastUntil = 0;
  let toastShown = false;
  const a = () => desk.claude?.alert ?? {};
  const hidden = () => props.onClaude() && a().session === shown();
  onFrame(() => {
    const cur = a().seq ?? 0;
    // don't flash for alerts older than this mount; a deskd restart resets
    // the counter (cur < seq): adopt it silently
    if (seq < 0 || cur < seq) seq = cur;
    if (cur !== seq) {
      seq = cur;
      if (desk.layout?.flash !== false) t = 0;
      if (!hidden()) toastUntil = Date.now() + 9000;
    }
    if (flash && t < 1.6 && decorFrame()) {
      t += DECOR_STEP / 60;
      // three decaying pulses
      jump(flash, "opacity", Math.max(0, Math.sin(t * Math.PI * 1.9) * 0.4 * (1 - t / 1.6)));
      if (t >= 1.6) jump(flash, "opacity", 0);
    }
    const want = Date.now() < toastUntil && !hidden();
    if (toast && want !== toastShown) {
      toastShown = want;
      spring(toast, "translateY", want ? 0 : -90);
    }
  });
  return (
    <>
      <View ref={(n: NodeMirror) => (flash = n)} class="absolute inset-0" style={{ bgColor: WAIT, opacity: 0 }} />
      <View class="absolute flex-row justify-center" style={{ insetL: 0, insetR: 0, insetT: 34 }}>
        <View
          ref={(n: NodeMirror) => (toast = n)}
          style={{ translateY: -90, bgColor: WAIT }}
          class="h-[30] rounded-[999] flex-row items-center gap-2 px-4"
          focusable
          onPress={() => {
            toastUntil = 0;
            if (a().session) setSelected(a().session);
            props.onOpen();
          }}
        >
          <View class="w-[8] h-[8] rounded-[2]" style={{ bgColor: ON_WAIT }} />
          <Text class="text-sm" style={{ textColor: ON_WAIT }}>
            {`${lower(clip(a().name, 18))} ${clip(lower(a().reason || "needs you"), 28)}`}
          </Text>
          <Text class="text-xs font-bold" style={{ textColor: ON_WAIT }}>
            view →
          </Text>
        </View>
      </View>
    </>
  );
}
