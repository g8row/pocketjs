// CLAUDE page: live Claude Code sessions on the host (deckd hooks).
//
//   [chip][chip][chip asks]                                   ← rounded: pick a session
//   ┌─ POCKETDECK ─────── reply ┐ ┌─ NOW ─── 12s ┐
//   │ you › the last prompt     │ │ editing x.tsx │            ← terminal: read-only
//   │ the reply, wrapped and    │ │ steps         │
//   │ scrollable (tap to read)  │ │ context ████░ │
//   └───────────────────────────┘ └───────────────┘
//   (copy reply) (show reply)                 model · cwd     ← rounded actions, mono meta
//
// A session that needs you (a question, a plan, a permission) takes over the left column with the
// request (terminal frame, wait-yellow) and the right column becomes the decision: a status frame
// plus the rounded buttons that answer it. "show reply" peeks at the conversation. Tapping the
// reply opens reading mode (the reply full width). The app-wide toast and permission sheet live in
// claude-layers.tsx.

import { For, Index, Show, createEffect, createMemo, createSignal, on, type JSX } from "solid-js";
import { Text, View, type NodeMirror } from "@pocketjs/framework/components";
import { onFrame } from "@pocketjs/framework/lifecycle";
import { jump, spring } from "@pocketjs/framework/animation";
import { cancelTouchTap, touches } from "@pocketjs/framework/input";
import { act, desk, linkConnected } from "../link.ts";
import { accent } from "../theme.ts";
import { gesture } from "../pager.tsx";
import { Morph } from "../shapes.tsx";
import { Btn, C, KV, PANE_X, PANE_Y, PH, PW, TBar, TBox } from "../ui.tsx";
import { createCountdown, fit, hostOs, lower, selected, setSelected, setShown, shown, textW, wrapPx } from "./claude-lib.ts";

export { AttentionLayer, PermissionSheet } from "./claude-layers.tsx";

type Active = () => boolean;
type S = () => any;

// ---- geometry (page px) -------------------------------------------------------------------
const PAD = 8;
const IN_W = PW - PAD * 2; // 390
const CHIPS_H = 26; // touch minimum
const BAR_H = 26;
const GAP = 8;
const MAIN_Y = PAD + CHIPS_H + GAP; // 38
const MAIN_H = PH - MAIN_Y - GAP - BAR_H - PAD; // 191
const SIDE_W = 140;
const COL_GAP = 10;
const LEFT_W = IN_W - SIDE_W - COL_GAP; // 240
// TBox: 6 px title band, 1 px frame, 7 px padding (8 on top, 6 at the bottom)
const BOX_T = 6 + 1 + 8; // content top inside a TBox
const BOX_X = 1 + 7; // content left inside a TBox
const BOX_V = BOX_T + 1 + 6; // vertical chrome of a TBox (22)
const LEFT_IN = LEFT_W - BOX_X * 2; // 224
const SIDE_IN = SIDE_W - BOX_X * 2; // 124
const SIDE_CELLS = Math.floor(SIDE_IN / 7); // 17 mono cells
const SCROLL_GUTTER = 8; // scrollbar lane right of scrolled text
const LEAD = 18; // reply line height (text-sm)
const READ_H = PH - PAD - GAP - BAR_H - PAD; // reading mode frame height (221)
/** A text viewport's height snapped to whole lines, so no half line peeks out at the bottom. */
const snap = (h: number) => Math.floor(h / LEAD) * LEAD;
/** From a snapped viewport's bottom to its TBox's bottom border (leftover + 6 px padding). */
const slack = (h: number) => h - snap(h) + 6;

// ---- scroller -----------------------------------------------------------------------------

/** A vertical touch scroller. The content moves by translateY (whole px) inside an
 *  overflow-hidden box; a vertical drag claims `gesture.owner` so the pager never swipes
 *  mid-scroll. `x`/`y` are the viewport's position in the PAGE; touches are hit-tested in screen
 *  coordinates (PANE_X/PANE_Y + page). A tap without a drag fires `onTap`. */
function Scroller(props: {
  x: number;
  y: () => number;
  w: number;
  h: () => number;
  contentH: () => number;
  active: Active;
  reset: () => unknown;
  onTap?: () => void;
  /** px from the viewport's bottom down to the enclosing TBox's bottom border: "↓ more" sits
   *  on that border instead of over the text. Without it, it overlays the viewport's corner. */
  border?: () => number;
  children: JSX.Element;
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
  const max = () => Math.max(0, props.contentH() - props.h());
  const knobH = () => Math.max(16, Math.round((props.h() * props.h()) / Math.max(props.h(), props.contentH())));
  const apply = () => {
    off = Math.max(0, Math.min(max(), off));
    const r = Math.round(off);
    if (r === applied) return;
    applied = r;
    if (content) jump(content, "translateY", -r);
    const m = max();
    if (knob) jump(knob, "translateY", m > 0 ? Math.round((r / m) * (props.h() - knobH())) : 0);
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
  createEffect(
    on(
      () => [props.contentH(), props.h()],
      () => {
        applied = -1;
        apply();
      },
    ),
  );
  onFrame(() => {
    if (!props.active()) return;
    const t = touches()[0];
    const sx = PANE_X + props.x;
    const sy = PANE_Y + props.y();
    if (t) {
      if (!start && !outside) {
        if (t.x >= sx && t.x < sx + props.w && t.y >= sy && t.y < sy + props.h()) {
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
    <View class="relative" style={{ width: props.w, height: props.h() }}>
      <View class="overflow-hidden" style={{ width: props.w, height: props.h() }} focusable={!!props.onTap} onPress={props.onTap}>
        <View ref={(n: NodeMirror) => (content = n)} class="flex-col" style={{ width: props.w - SCROLL_GUTTER, translateY: 0 }}>
          {props.children}
        </View>
        <Show when={max() > 0}>
          <View class="absolute w-[2]" style={{ insetR: 0, insetT: 0, height: props.h(), bgColor: C.line }}>
            <View ref={(n: NodeMirror) => (knob = n)} class="w-[2]" style={{ height: knobH(), translateY: 0, bgColor: C.mute }} />
          </View>
        </Show>
      </View>
      <Show when={more()}>
        <View
          class="absolute"
          style={props.border ? { insetR: 0, insetB: -(props.border() + 8), paddingL: 4, paddingR: 4, bgColor: C.ground } : { insetR: SCROLL_GUTTER, insetB: 0, paddingL: 4, bgColor: C.ground }}
        >
          <Text class="text-xs font-bold" style={{ textColor: accent() }}>
            ↓ more
          </Text>
        </View>
      </Show>
    </View>
  );
}

/** A block of pre-wrapped lines in one Text with a fixed height. */
function Lines(props: { lines: () => string[]; cls: string; lead: number; w: number; color?: string }) {
  return (
    <Text class={props.cls} style={{ width: props.w, height: Math.max(1, props.lines().length) * props.lead, textColor: props.color ?? C.fg }}>
      {props.lines().join("\n") || " "}
    </Text>
  );
}

// ---- state helpers ----------------------------------------------------------------------------

const stateColor = (st: string) => (st === "waiting" ? C.wait : st === "working" ? accent() : st === "done" ? C.ok : "#4a4a4a");

/** Sessions in a stable order (first seen first), so chips never jump under a finger when deckd
 *  re-sorts by state. */
const seen: string[] = [];
function stableSessions(): any[] {
  const list = (desk.claude?.sessions ?? []) as any[];
  for (const s of list) if (!seen.includes(s.id)) seen.push(s.id);
  return list.slice().sort((a, b) => seen.indexOf(a.id) - seen.indexOf(b.id));
}

// ---- chips -----------------------------------------------------------------------------------

const chipName = (s: any): string => lower(s.name) || "session";
const chipNote = (s: any): string => (s.state !== "waiting" ? "" : s.question ? "asks" : s.plan ? "plan" : s.held ? "allow?" : "needs you");

/** A session chip: the kit's Chip, plus a spinning shape while the session works. */
function SessionChip(props: { s: any; on: () => boolean; maxLabel: () => number; active: Active }) {
  let n: NodeMirror | undefined;
  const wait = () => props.s.state === "waiting";
  const note = () => chipNote(props.s);
  return (
    <View
      ref={(x: NodeMirror) => (n = x)}
      class="flex-row items-center gap-[6] rounded-[999] border px-[10]"
      style={{
        height: CHIPS_H,
        bgColor: props.on() ? (wait() ? "#1f1a0e" : C.raised) : C.bg,
        borderColor: wait() ? C.wait : props.on() ? "#4a4a4a" : C.line2,
      }}
      focusable
      onPress={() => {
        if (n) {
          jump(n, "scale", 0.94);
          spring(n, "scale", 1);
        }
        setSelected(props.s.id);
      }}
    >
      <Show when={props.s.state === "working"} fallback={<View class="w-[7] h-[7] rounded-[2]" style={{ bgColor: stateColor(props.s.state) }} />}>
        <Morph size={10} layers={2} spin={() => 4} color={accent} active={props.active} />
      </Show>
      <Text class="text-sm" style={{ textColor: wait() ? C.wait : props.on() ? "#ffffff" : C.soft }}>
        {fit(chipName(props.s), props.maxLabel(), 14)}
      </Text>
      <Show when={note()}>
        <Text class="text-xs font-bold" style={{ textColor: C.wait }}>
          {note()}
        </Text>
      </Show>
    </View>
  );
}

/** Which sessions get a chip. Up to 4 fit the row; with more, 3 chips and a "+N" chip. The
 *  selected session and every waiting session are always among the visible ones (in stable order),
 *  the rest fill up from the first seen. */
function chipSets(selId: string): { vis: any[]; hidden: any[] } {
  const all = stableSessions();
  if (all.length <= 4) return { vis: all, hidden: [] };
  const keep = new Set<string>();
  const add = (id: string) => keep.size < 3 && id && keep.add(id);
  add(selId);
  for (const x of all) if (x.state === "waiting") add(x.id);
  for (const x of all) add(x.id);
  return { vis: all.filter((x) => keep.has(x.id)), hidden: all.filter((x) => !keep.has(x.id)) };
}

const plusLabel = (n: number) => `+${n}`;
const PLUS_W = (n: number) => 22 + 2 + textW(plusLabel(n), 14);

function Chips(props: { sel: S; active: Active; open: () => boolean; setOpen: (v: boolean) => void }) {
  const sets = createMemo(() => chipSets(props.sel()?.id ?? ""));
  const list = () => sets().vis;
  const hidden = () => sets().hidden;
  // label budget: chips keep their natural width while the row fits; otherwise the longest names
  // are capped at one shared width (water-filling). Chrome per chip: padding 20, dot 10, gap 6,
  // border 2, plus the note ("asks") and its gap; the "+N" chip takes its share first.
  const cap = createMemo(() => {
    const l = list();
    const chrome = l.map((x) => 38 + (chipNote(x) ? textW(chipNote(x), 12, true) + 6 : 0));
    const plus = hidden().length ? PLUS_W(hidden().length) + 6 : 0;
    const avail = IN_W - plus - 6 * (l.length - 1) - chrome.reduce((x, y) => x + y, 0);
    const want = l.map((x) => textW(chipName(x), 14));
    let c = Math.max(...want, 0);
    while (c > 24 && want.reduce((x, w) => x + Math.min(w, c), 0) > avail) c -= 2;
    return c;
  });
  const hiddenWait = () => hidden().some((x) => x.state === "waiting");
  let plusN: NodeMirror | undefined;
  return (
    <View class="flex-row gap-[6]" style={{ height: CHIPS_H, width: IN_W }}>
      <For each={list()}>{(x) => <SessionChip s={x} on={() => props.sel()?.id === x.id} maxLabel={cap} active={props.active} />}</For>
      <Show when={hidden().length > 0}>
        <View
          ref={(x: NodeMirror) => (plusN = x)}
          class="flex-row items-center justify-center rounded-[999] border"
          style={{
            height: CHIPS_H,
            width: PLUS_W(hidden().length),
            bgColor: props.open() ? C.raised : C.bg,
            borderColor: hiddenWait() ? C.wait : props.open() ? "#4a4a4a" : C.line2,
          }}
          focusable
          onPress={() => {
            if (plusN) {
              jump(plusN, "scale", 0.94);
              spring(plusN, "scale", 1);
            }
            props.setOpen(!props.open());
          }}
        >
          <Text class="text-sm" style={{ textColor: hiddenWait() ? C.wait : props.open() ? "#ffffff" : C.soft }}>
            {plusLabel(hidden().length)}
          </Text>
        </View>
      </Show>
    </View>
  );
}

const PICK_W = 220;
const PICK_ROW = 30;
const PICK_MAX = 5;

/** The "+N" chooser: a rounded list of the sessions without a chip, dropped under the chip row at
 *  the right edge. Tap one to show it (it then takes a chip); tap outside to close. */
function Chooser(props: { sel: S; open: () => boolean; setOpen: (v: boolean) => void; active: Active }) {
  const hidden = () => chipSets(props.sel()?.id ?? "").hidden.slice(0, PICK_MAX);
  return (
    <Show when={props.open() && hidden().length > 0}>
      <View class="absolute" style={{ insetL: 0, insetT: 0, width: PW, height: PH }} focusable onPress={() => props.setOpen(false)} />
      <View
        class="absolute flex-col rounded-[16] border"
        style={{ insetR: PAD, insetT: PAD + CHIPS_H + 6, width: PICK_W, gap: 6, paddingL: 6, paddingR: 6, paddingT: 6, paddingB: 6, bgColor: C.card, borderColor: C.line2 }}
      >
        <For each={hidden()}>
          {(x) => {
            const wait = () => x.state === "waiting";
            const note = () => chipNote(x) || lower(x.state) || " ";
            return (
              <View
                class="flex-row items-center gap-[8] rounded-[999] border px-[10]"
                style={{ height: PICK_ROW, bgColor: C.raised, borderColor: wait() ? C.wait : C.line2 }}
                focusable
                onPress={() => {
                  setSelected(x.id);
                  props.setOpen(false);
                }}
              >
                <Show when={x.state === "working"} fallback={<View class="w-[7] h-[7] rounded-[2]" style={{ bgColor: stateColor(x.state) }} />}>
                  <Morph size={10} layers={2} spin={() => 4} color={accent} active={props.active} />
                </Show>
                <Text class="text-sm" style={{ textColor: wait() ? C.wait : C.fg }}>
                  {fit(chipName(x), PICK_W - 12 - 20 - 10 - 16 - textW(note(), 12, true) - 4, 14)}
                </Text>
                <View class="flex-1" />
                <Text class="text-xs font-bold" style={{ textColor: wait() ? C.wait : C.mute }}>
                  {note()}
                </Text>
              </View>
            );
          }}
        </For>
      </View>
    </Show>
  );
}

// ---- left column ---------------------------------------------------------------------------

function Conversation(props: { s: S; active: Active; onRead: () => void }) {
  const s = props.s;
  const ask = createMemo(() => wrapPx(`you › ${s().prompt || "–"}`, LEFT_IN, 12, { mono: true, max: 2 }));
  const askH = () => ask().length * 14 + 6;
  const reply = createMemo(() => wrapPx(s().reply || (s().state === "working" ? "…" : "no reply yet"), LEFT_IN - SCROLL_GUTTER, 14, { max: 120 }));
  const title = () => fit((s().name || "session").toUpperCase(), LEFT_W - 90, 12, true);
  return (
    <TBox title={title()} right="reply" w={LEFT_W} h={MAIN_H} color={C.wait} hot={s().state === "waiting"}>
      <Text class="text-xs font-bold leading-[14]" style={{ width: LEFT_IN, height: askH(), textColor: C.mute }}>
        {ask().join("\n")}
      </Text>
      <Scroller
        x={PAD + BOX_X}
        y={() => MAIN_Y + BOX_T + askH()}
        w={LEFT_IN}
        h={() => snap(MAIN_H - BOX_V - askH())}
        contentH={() => reply().length * LEAD}
        active={props.active}
        reset={() => `${s().id}|${s().reply?.length ?? 0}`}
        onTap={props.onRead}
        border={() => slack(MAIN_H - BOX_V - askH())}
      >
        <Lines lines={reply} cls="text-sm leading-[18]" lead={LEAD} w={LEFT_IN - SCROLL_GUTTER} />
      </Scroller>
    </TBox>
  );
}

/** The question flow: one question per screen, picks kept per held request. */
function createAnswers(s: S) {
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
  const q = () => qs()[Math.min(qi(), Math.max(0, qs().length - 1))] ?? { q: "", options: [] };
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
type Answers = ReturnType<typeof createAnswers>;

const OPT_H = 36;
const OPT_GAP = 6;
const OPT_W = LEFT_W - SCROLL_GUTTER;

function QuestionBody(props: { a: Answers; s: S; active: Active }) {
  const a = props.a;
  const qLines = createMemo(() => wrapPx(a.q().q || "a question for you", LEFT_IN, 16, { max: 3 }));
  const boxH = () => BOX_V + qLines().length * 20;
  const title = () => fit(a.q().header ? `CLAUDE ASKS · ${a.q().header.toUpperCase()}` : "CLAUDE ASKS", LEFT_W - 70, 12, true);
  const opts = () => (a.q().options ?? []) as any[];
  return (
    <View class="flex-col" style={{ width: LEFT_W, height: MAIN_H, gap: GAP }}>
      <TBox title={title()} right={a.qs().length > 1 ? `${a.qi() + 1}/${a.qs().length}` : ""} hot color={C.wait} w={LEFT_W} h={boxH()}>
        <Lines lines={qLines} cls="text-base leading-[20]" lead={20} w={LEFT_IN} color="#ffffff" />
      </TBox>
      <Scroller
        x={PAD}
        y={() => MAIN_Y + boxH() + GAP}
        w={LEFT_W}
        h={() => MAIN_H - boxH() - GAP}
        contentH={() => opts().length * (OPT_H + OPT_GAP) - OPT_GAP}
        active={props.active}
        reset={() => `${props.s().id}|${a.qi()}`}
      >
        <View class="flex-col" style={{ gap: OPT_GAP }}>
        <Index each={opts()}>
          {(o, k) => {
            const on_ = () => a.mine().includes(k);
            return (
              <View
                class="flex-row items-center gap-[8] rounded-[12] border px-[10]"
                style={{ width: OPT_W, height: OPT_H, borderColor: on_() ? C.wait : C.line2, bgColor: on_() ? "#1f1a0e" : C.raised }}
                focusable
                onPress={() => a.toggle(k)}
              >
                <View
                  class={a.q().multi ? "w-[12] h-[12] rounded-[3] border" : "w-[12] h-[12] rounded-[999] border"}
                  style={{ borderColor: on_() ? C.wait : "#5a5a5a", bgColor: on_() ? C.wait : "#00000000" }}
                />
                <View class="flex-col">
                  <Text class="text-sm" style={{ textColor: on_() ? C.wait : C.fg }}>
                    {fit(o().label, OPT_W - 44, 14)}
                  </Text>
                  <Show when={!!o().desc}>
                    <Text class="text-xs font-bold" style={{ textColor: C.mute }}>
                      {fit(lower(o().desc), OPT_W - 44, 12, true)}
                    </Text>
                  </Show>
                </View>
              </View>
            );
          }}
        </Index>
        </View>
      </Scroller>
    </View>
  );
}

function PlanBody(props: { s: S; active: Active }) {
  const lines = createMemo(() =>
    wrapPx(props.s().plan || `the plan text didn't come through; read it on ${hostOs()}`, LEFT_IN - SCROLL_GUTTER, 14, { max: 160 }),
  );
  return (
    <TBox title="PLAN" right={`${lines().length} lines`} hot color={C.wait} w={LEFT_W} h={MAIN_H}>
      <Scroller
        x={PAD + BOX_X}
        y={() => MAIN_Y + BOX_T}
        w={LEFT_IN}
        h={() => snap(MAIN_H - BOX_V)}
        contentH={() => lines().length * LEAD}
        active={props.active}
        reset={() => `${props.s().id}|${props.s().plan?.length ?? 0}`}
        border={() => slack(MAIN_H - BOX_V)}
      >
        <Lines lines={lines} cls="text-sm leading-[18]" lead={LEAD} w={LEFT_IN - SCROLL_GUTTER} />
      </Scroller>
    </TBox>
  );
}

function PermissionBody(props: { s: S }) {
  const h = () => props.s().held ?? {};
  const cmd = createMemo(() => wrapPx(h().command || h().summary || "(no details)", LEFT_IN, 12, { mono: true, max: 7 }));
  const why = createMemo(() => wrapPx(h().why ?? "", LEFT_IN, 14, { max: 3 }));
  return (
    <TBox title={fit(`ALLOW ${(h().tool || "tool").toUpperCase()}?`, LEFT_W - 40, 12, true)} hot color={C.wait} w={LEFT_W} h={MAIN_H}>
      <Text class="text-xs font-bold leading-[14]" style={{ width: LEFT_IN, height: cmd().length * 14, textColor: "#ffffff" }}>
        {cmd().join("\n")}
      </Text>
      <Show when={why().length > 0}>
        <View class="h-[8]" />
        <Lines lines={why} cls="text-sm leading-[18]" lead={LEAD} w={LEFT_IN} color={C.soft} />
      </Show>
    </TBox>
  );
}

// ---- right column ---------------------------------------------------------------------------

function Ctx(props: { s: S }) {
  const pct = () => Math.max(0, Math.min(100, props.s().contextPct ?? 0));
  return (
    <View class="flex-col gap-[2]">
      <View class="flex-row justify-between" style={{ width: SIDE_IN }}>
        <Text class="text-xs font-bold" style={{ textColor: C.mute }}>
          context
        </Text>
        <Text class="text-xs font-bold" style={{ textColor: C.mute }}>
          {fit((props.s().ctx || "–").replace(/\s+/g, ""), SIDE_IN - 56, 12, true)}
        </Text>
      </View>
      <TBar value={() => pct() / 100} cells={SIDE_CELLS} color={pct() > 80 ? C.wait : accent()} />
    </View>
  );
}

function Steps(props: { rows: () => { t: string; fail?: boolean }[] }) {
  return (
    <View class="flex-col">
      <Index each={props.rows().slice(-4)}>
        {(r) => (
          <Text class="text-xs font-bold leading-[14]" style={{ width: SIDE_IN, height: 14, textColor: r().fail ? C.rose : C.mute }}>
            {fit(`${r().fail ? "× " : "· "}${r().t}`, SIDE_IN, 12, true)}
          </Text>
        )}
      </Index>
    </View>
  );
}

/** The state card for a session that doesn't need a decision: working / waiting / done / idle. */
function NowCard(props: { s: S }) {
  const s = props.s;
  const st = () => s().state as string;
  const done = () => st() === "done";
  const idle = () => st() === "idle";
  const wait = () => st() === "waiting";
  const right = (): string => {
    if (done() || idle()) {
      const ago = desk.claudeTick?.ago?.[s().id];
      return ago ? `${ago} ago` : "";
    }
    return desk.claudeTick?.run?.[s().id] ?? s().up ?? "";
  };
  const head = createMemo(() =>
    wrapPx(done() ? (s().took ? `took ${s().took}` : "finished") : idle() ? "idle" : lower(s().now?.text || s().detail || "working"), SIDE_IN, 16, { max: 2 }),
  );
  const rows = () =>
    done() && s().changed?.length ? (s().changed as string[]).slice(0, 4).map((f) => ({ t: f.split("/").pop() ?? f })) : ((s().steps ?? []) as any[]);
  return (
    <TBox
      title={done() ? "DONE" : idle() ? "IDLE" : wait() ? "WAITING" : "NOW"}
      right={right() || undefined}
      hot={!idle()}
      color={done() ? C.ok : wait() ? C.wait : undefined}
      w={SIDE_W}
      h={MAIN_H}
    >
      <Lines lines={head} cls="text-base leading-[20]" lead={20} w={SIDE_IN} color={wait() ? C.wait : "#ffffff"} />
      <Show when={!done() && !idle() && !!s().now?.sub}>
        <Text class="text-xs font-bold" style={{ textColor: accent() }}>
          {fit(s().now?.sub, SIDE_IN, 12, true)}
        </Text>
      </Show>
      <View class="h-[6]" />
      <Steps rows={rows} />
      <View class="flex-1" />
      <Ctx s={s} />
    </TBox>
  );
}

/** The decision column: a status frame (wait-yellow) and the rounded buttons under it. */
function Decide(props: { title: string; right?: string; lines: () => string[]; frac?: () => number; children?: JSX.Element }) {
  return (
    <View class="flex-col" style={{ width: SIDE_W, height: MAIN_H, gap: 6 }}>
      <TBox title={props.title} right={props.right} hot color={C.wait} w={SIDE_W} grow>
        <Lines lines={props.lines} cls="text-xs font-bold leading-[15]" lead={15} w={SIDE_IN} color={C.soft} />
        <View class="flex-1" />
        <Show when={props.frac}>
          <TBar value={props.frac!} cells={SIDE_CELLS} color={C.wait} />
        </Show>
      </TBox>
      {props.children}
    </View>
  );
}

function QuestionSide(props: { a: Answers; s: S }) {
  const a = props.a;
  const held = () => props.s().held?.kind === "question";
  const cd = createCountdown(() => props.s().id, () => props.s().held);
  const hint = () =>
    !held()
      ? `answer it on ${hostOs()}: the desk gate isn't holding this question.`
      : a.q().multi
        ? `pick any, then ${a.last() ? "submit" : "next"}. ${a.mine().length} selected.`
        : `pick one, then ${a.last() ? "submit" : "next"}.`;
  const lines = createMemo(() => wrapPx(hint(), SIDE_IN, 12, { mono: true, max: 6 }));
  const half = (SIDE_W - 6) / 2;
  return (
    <Decide title="ANSWER" right={held() ? `${cd.left()}s` : undefined} lines={lines} frac={held() ? cd.frac : undefined}>
      <Show when={held()}>
        <View class="flex-row gap-[6]">
          <Show when={a.qi() > 0}>
            <Btn label="back" w={half} onPress={() => a.setQi(a.qi() - 1)} />
          </Show>
          <Btn
            label={a.last() ? "submit" : "next →"}
            kind={a.mine().length ? "wait" : "default"}
            w={a.qi() > 0 ? half : SIDE_W}
            onPress={() => {
              if (!a.mine().length) return;
              if (a.last()) a.submit();
              else a.setQi(a.qi() + 1);
            }}
          />
        </View>
      </Show>
    </Decide>
  );
}

function PlanSide(props: { s: S }) {
  const h = () => props.s().held;
  const held = () => h()?.kind === "plan";
  const cd = createCountdown(() => props.s().id, h);
  const lines = createMemo(() =>
    wrapPx(held() ? "review the plan, then approve or keep planning." : `approve it on ${hostOs()}: the desk gate isn't holding it.`, SIDE_IN, 12, {
      mono: true,
      max: 4,
    }),
  );
  return (
    <Decide title="PLAN READY" right={held() ? `${cd.left()}s` : undefined} lines={lines} frac={held() ? cd.frac : undefined}>
      <Show when={held()}>
        <Btn label="keep planning" w={SIDE_W} onPress={() => act("claude.permit", { id: h().id, allow: false })} />
        <Btn label="auto-accept edits" w={SIDE_W} onPress={() => act("claude.permit", { id: h().id, allow: true, mode: "acceptEdits" })} />
        <Btn label="approve" kind="wait" w={SIDE_W} onPress={() => act("claude.permit", { id: h().id, allow: true })} />
      </Show>
    </Decide>
  );
}

function PermissionSide(props: { s: S }) {
  const h = () => props.s().held ?? {};
  const cd = createCountdown(() => props.s().id, () => props.s().held);
  const lines = createMemo(() =>
    wrapPx(`${lower(props.s().name) || "claude"} wants to run ${lower(h().tool) || "a tool"}.`, SIDE_IN, 12, { mono: true, max: 5 }),
  );
  const half = (SIDE_W - 6) / 2;
  return (
    <Decide title="PERMISSION" right={`${cd.left()}s`} lines={lines} frac={cd.frac}>
      <Btn label="always allow" w={SIDE_W} onPress={() => act("claude.permit", { id: h().id, allow: true, always: true })} />
      <View class="flex-row gap-[6]">
        <Btn label="deny" w={half} onPress={() => act("claude.permit", { id: h().id, allow: false })} />
        <Btn label="allow" kind="wait" w={half} onPress={() => act("claude.permit", { id: h().id, allow: true })} />
      </View>
    </Decide>
  );
}

// ---- bottom bar ---------------------------------------------------------------------------------

function Bar(props: { s: S; reading: () => boolean; setReading: (v: boolean) => void; peekLabel: () => string; peek: () => boolean; setPeek: (v: boolean) => void }) {
  const s = props.s;
  const used = () => (props.reading() ? 90 + 6 : 0) + 112 + (props.peekLabel() ? 6 + 24 + textW(props.peekLabel(), 14) : 0) + 10;
  const meta = () => fit([s().model, s().cwd].filter(Boolean).join(" · "), IN_W - used(), 12, true);
  return (
    <View class="flex-row items-center gap-[6]" style={{ height: BAR_H, width: IN_W }}>
      <Show when={props.reading()}>
        <Btn label="back" icon="arrow-left" onPress={() => props.setReading(false)} />
      </Show>
      <Btn label="copy reply" icon="copy" kind={props.reading() || s().state === "waiting" ? "default" : "primary"} onPress={() => act("claude.copy", { session: s().id })} />
      <Show when={!props.reading() && props.peekLabel()}>
        <Btn label={props.peekLabel()} onPress={() => props.setPeek(!props.peek())} />
      </Show>
      <View class="flex-1 flex-row justify-end">
        <Text class="text-xs font-bold" style={{ textColor: C.mute }}>
          {meta()}
        </Text>
      </View>
    </View>
  );
}

// ---- empty state ----------------------------------------------------------------------------------

function Empty(props: { active: Active }) {
  const hooks = () => desk.claude?.hooks !== false;
  return (
    <View class="flex-col items-center justify-center gap-[10]" style={{ width: PW, height: PH }}>
      <Morph size={44} layers={4} morph={() => 0.5 + 0.5 * Math.sin(Date.now() / 1400)} spin={() => 0.4} color={() => "#262626"} active={props.active} />
      <Text class="text-xl" style={{ textColor: C.fg }}>
        no claude sessions
      </Text>
      <Text class="text-xs font-bold" style={{ textColor: C.mute }}>
        {fit(`start one on ${hostOs()} and it shows up here`, IN_W, 12, true)}
      </Text>
      <View class="h-[2]" />
      <TBox title="DECKD" right={hooks() ? "ok" : "setup"} hot={!hooks()} color={C.wait} w={236}>
        <KV k="hooks" kw={56} v={hooks() ? "installed" : "not installed"} color={hooks() ? C.ok : C.wait} />
        <KV k="host" kw={56} v={fit(`${lower(desk.host?.name) || "–"} · ${hostOs()}`, 150, 12, true)} />
        <KV k="link" kw={56} v={linkConnected() ? "connected" : "offline"} color={linkConnected() ? C.fg : C.rose} />
      </TBox>
    </View>
  );
}

// ---- the page --------------------------------------------------------------------------------------

export function ClaudePage(props: { active: Active }) {
  const sessions = () => (desk.claude?.sessions ?? []) as any[];
  // tapped chip, else a session that needs you, else stay on the one shown
  // (deckd re-sorts by activity; following its first entry made the page jump)
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
  const [picking, setPicking] = createSignal(false);
  // scrollers under the open chooser must not take its touches
  const live = () => props.active() && !picking();
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
  const deciding = () => asking() || planning() || permission();
  const peekLabel = () => (!deciding() ? "" : peek() ? (asking() ? "show question" : planning() ? "show plan" : "show request") : "show reply");
  const readLines = createMemo(() => wrapPx(s().reply || "no reply yet", IN_W - BOX_X * 2 - SCROLL_GUTTER, 14, { max: 200 }));
  const readTitle = () => fit(`${(s().name || "session").toUpperCase()} · REPLY`, IN_W - 120, 12, true);
  return (
    <Show when={sessions().length > 0} fallback={<Empty active={props.active} />}>
      <View class="flex-col" style={{ width: PW, height: PH, paddingL: PAD, paddingR: PAD, paddingT: PAD, paddingB: PAD, gap: GAP }}>
        <Show
          when={reading()}
          fallback={
            <>
              <Chips sel={sel} active={props.active} open={picking} setOpen={setPicking} />
              <View class="flex-row" style={{ height: MAIN_H, gap: COL_GAP }}>
                <Show when={deciding() && !peek()} fallback={<Conversation s={s} active={live} onRead={() => setReading(true)} />}>
                  <Show when={asking()}>
                    <QuestionBody a={a} s={s} active={live} />
                  </Show>
                  <Show when={planning()}>
                    <PlanBody s={s} active={live} />
                  </Show>
                  <Show when={permission()}>
                    <PermissionBody s={s} />
                  </Show>
                </Show>
                <Show when={asking()}>
                  <QuestionSide a={a} s={s} />
                </Show>
                <Show when={planning()}>
                  <PlanSide s={s} />
                </Show>
                <Show when={permission()}>
                  <PermissionSide s={s} />
                </Show>
                <Show when={!deciding()}>
                  <NowCard s={s} />
                </Show>
              </View>
            </>
          }
        >
          {/* reading mode: the reply full width; tap it to go back */}
          <TBox title={readTitle()} right={`context ${s().contextPct ?? 0}%`} w={IN_W} h={READ_H} hot color={s().state === "waiting" ? C.wait : undefined}>
            <Scroller
              x={PAD + BOX_X}
              y={() => PAD + BOX_T}
              w={IN_W - BOX_X * 2}
              h={() => snap(READ_H - BOX_V)}
              contentH={() => readLines().length * LEAD}
              active={props.active}
              reset={() => `${s().id}|${reading()}`}
              onTap={() => setReading(false)}
              border={() => slack(READ_H - BOX_V)}
            >
              <Lines lines={readLines} cls="text-sm leading-[18]" lead={LEAD} w={IN_W - BOX_X * 2 - SCROLL_GUTTER} />
            </Scroller>
          </TBox>
        </Show>
        <Bar s={s} reading={reading} setReading={setReading} peekLabel={peekLabel} peek={peek} setPeek={setPeek} />
        <Show when={!reading()}>
          <Chooser sel={sel} open={picking} setOpen={setPicking} active={props.active} />
        </Show>
      </View>
    </Show>
  );
}

