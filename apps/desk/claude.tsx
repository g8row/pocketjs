// Claude pane v4: a session rail on the left (tap to select), and the selected
// session's detail on the right — header + Cloudflare-style stat cells, three
// tabs (tool timeline with durations, prompt history, last reply), and quick
// actions that run on the Mac. Plus two app-wide layers: the permission sheet
// (allow/deny a held PermissionRequest) and the attention flash/toast.

import { For, Index, Show, createMemo, createSignal } from "solid-js";
import { Text, View, type NodeMirror } from "@pocketjs/framework/components";
import { onFrame } from "@pocketjs/framework/lifecycle";
import { jump, spring } from "@pocketjs/framework/animation";
import { act, desk } from "./link.ts";
import { Morph } from "./shapes.tsx";
import { ON_ACCENT, T, accent, wrap } from "./theme.ts";
import { DECOR_STEP, decorFrame } from "./clock.ts";

type Active = () => boolean;
const clip = (s: unknown, n: number): string => {
  const str = typeof s === "string" ? s : "";
  return str.length > n ? `${str.slice(0, n - 1)}…` : str;
};
const lower = (s: unknown) => (typeof s === "string" ? s.toLowerCase() : "");
const pad = (s: string, n: number) => (s.length >= n ? s.slice(0, n) : s + " ".repeat(n - s.length));

const [selected, setSelected] = createSignal("");
/** Select a session from outside (the toast). */
export const selectSession = setSelected;

const STATE: Record<string, string> = { waiting: "needs you", working: "working", done: "done", idle: "idle" };

function Rail(props: { active: Active; sel: () => any }) {
  const sessions = () => (desk.claude?.sessions ?? []) as any[];
  return (
    <View class="flex-col gap-[3]" style={{ width: 164 }}>
      <View class="flex-row items-center justify-between h-[22] px-1">
        <Text class={T.eyebrow}>SESSIONS</Text>
        <Text class={T.monoSm}>{`${desk.claude?.counts?.working ?? 0}w ${desk.claude?.counts?.waiting ?? 0}!`}</Text>
      </View>
      <View class="flex-col gap-[3]">
        <For each={sessions().slice(0, 6)}>
          {(s) => (
            <View
              class={props.sel()?.id === s.id ? "h-[36] flex-row items-center gap-2 rounded-[12] bg-[#1d1d1d] border border-[#363636] px-2" : "h-[36] flex-row items-center gap-2 rounded-[12] bg-[#0f0f0f] border border-[#1a1a1a] px-2 active:bg-[#1d1d1d]"}
              focusable
              onPress={() => setSelected(s.id)}
            >
              <View class="w-[18] h-[18] items-center justify-center">
                <Show when={s.state === "working"}>
                  <Morph size={16} layers={2} spin={() => 4} active={props.active} />
                </Show>
                <Show when={s.state === "waiting"}>
                  <View class="w-[10] h-[10] rounded-[3]" style={{ bgColor: accent() }} />
                </Show>
                <Show when={s.state === "done" || s.state === "idle"}>
                  <View class={s.state === "done" ? "w-[8] h-[8] rounded-[2] bg-[#8a8a8a]" : "w-[8] h-[8] rounded-[2] border border-[#5a5a5a]"} />
                </Show>
              </View>
              {/* basis 0 + overflow-hidden: text never pushes the row wider than the rail */}
              <View class="flex-1 flex-col overflow-hidden" style={{ basis: 0 }}>
                <Text class="text-sm text-[#ededed]">{lower(clip(s.name, 14))}</Text>
                <Text class={T.monoSm}>{lower(clip(s.detail, 15))}</Text>
              </View>
              {/* "ago" ticks every second in its own small key (deskd claudeTick) */}
              <Text class="text-xs font-bold text-[#8a8a8a] text-right" style={{ width: 20, height: 14 }}>
                {desk.claudeTick?.ago?.[s.id] ?? s.ago ?? ""}
              </Text>
            </View>
          )}
        </For>
      </View>
    </View>
  );
}

function StatCell(props: { label: string; value: string; children?: any }) {
  return (
    <View class="flex-1 flex-col justify-center gap-[2] px-2 bg-[#0a0a0a] overflow-hidden" style={{ basis: 0 }}>
      <Text class={T.monoSm}>{props.label}</Text>
      <Text class="text-sm text-[#ededed]">{props.value}</Text>
      {props.children}
    </View>
  );
}

function Pill(props: { label: string; onPress: () => void; primary?: boolean }) {
  let n: NodeMirror | undefined;
  const press = () => {
    if (n) {
      jump(n, "scale", 0.9);
      spring(n, "scale", 1);
    }
    props.onPress();
  };
  return (
    <View
      ref={(x: NodeMirror) => (n = x)}
      class={props.primary ? "flex-1 h-[26] rounded-[999] items-center justify-center" : "flex-1 h-[26] rounded-[999] border border-[#363636] items-center justify-center active:bg-[#1d1d1d]"}
      style={props.primary ? { basis: 0, bgColor: accent() } : { basis: 0 }}
      focusable
      onPress={press}
    >
      <Text class={props.primary ? "text-xs font-bold" : "text-xs font-bold text-[#ededed]"} style={props.primary ? { textColor: ON_ACCENT } : {}}>
        {props.label}
      </Text>
    </View>
  );
}

const TABS = ["timeline", "prompts", "reply"] as const;

function Detail(props: { active: Active; s: () => any }) {
  const [tab, setTab] = createSignal<(typeof TABS)[number]>("timeline");
  const s = () => props.s() ?? {};
  let ctxBar: NodeMirror | undefined;
  let lastPct = -1;
  onFrame(() => {
    if (!props.active() || !ctxBar) return;
    const p = s().contextPct ?? 0;
    if (p !== lastPct) {
      lastPct = p;
      jump(ctxBar, "scaleX", Math.max(0.02, p / 100)); // no spring: see views.tsx Spark
    }
  });
  const timeline = () =>
    ((s().tools ?? []) as any[]).slice(0, 8).map((c) => ({
      left: `${c.at} ${pad(c.tool, 9)} ${pad(lower(c.summary), 22)}`,
      right: c.ms,
      ok: c.ok,
    }));
  return (
    <View class="flex-1 flex-col gap-[6]">
      {/* header */}
      <View class="flex-row items-center justify-between h-[24]">
        <View class="flex-row items-center gap-2">
          <Text class="text-lg text-[#ededed]">{lower(clip(s().name ?? "no session", 18))}</Text>
          <View class={s().state === "waiting" ? T.chipA : T.chipO}>
            <Text class="text-xs font-bold" style={{ textColor: s().state === "waiting" ? accent() : "#8a8a8a" }}>
              {STATE[s().state] ?? "—"}
            </Text>
          </View>
        </View>
        <Text class={T.monoSm}>{clip(s().model || "", 16)}</Text>
      </View>
      <Text class={T.monoSm}>{clip(`${s().cwd ?? ""} · up ${s().up ?? "–"} · ${s().promptCount ?? 0} prompts · ${s().subagents ?? 0} agents`, 46)}</Text>
      {/* stat cells: 1px rules between */}
      <View class="h-[38] flex-row gap-[1] bg-[#222222] border border-[#222222] rounded-[8] overflow-hidden">
        <StatCell label="in / out" value={s().tokens ? s().tokens.replace(" in · ", " / ").replace(" out", "") : "–"} />
        <StatCell label="context" value={s().context ? `${s().context} · ${s().contextPct}%` : "–"}>
          <View class="w-full h-[2] bg-[#222222]">
            <View ref={(n: NodeMirror) => (ctxBar = n)} class="w-full h-[2]" style={{ originX: -0.5, bgColor: accent() }} />
          </View>
        </StatCell>
        <StatCell label="tools" value={`${s().toolCount ?? 0}${s().failCount ? ` · ${s().failCount} fail` : ""}`} />
      </View>
      {/* permission banner */}
      <Show when={!!s().permission && s().state === "waiting"}>
        <View class="flex-row items-center gap-2 rounded-[10] px-2 py-[4] border" style={{ borderColor: accent() }}>
          <Morph size={14} layers={3} spin={() => 3} active={props.active} />
          <Text class="text-xs font-bold" style={{ textColor: accent() }}>
            {clip(`permission: ${lower(s().permission)}`, 44)}
          </Text>
        </View>
      </Show>
      {/* tabs */}
      <View class="flex-row gap-1">
        <For each={[...TABS]}>
          {(t) => (
            <View
              class={tab() === t ? "h-[20] px-3 rounded-[999] items-center justify-center" : "h-[20] px-3 rounded-[999] border border-[#222222] items-center justify-center"}
              // always set both keys: an inline style key that disappears is
              // not reset by the renderer, so `{}` left the old fill behind
              style={{ bgColor: tab() === t ? accent() : "#00000000" }}
              focusable
              onPress={() => setTab(t)}
            >
              <Text class="text-xs font-bold" style={{ textColor: tab() === t ? ON_ACCENT : "#8a8a8a" }}>
                {t}
              </Text>
            </View>
          )}
        </For>
        <View class="flex-1" />
        <Text class={T.monoSm}>{clip(s().top ?? "", 15)}</Text>
      </View>
      {/* tab content */}
      <View class="flex-1 flex-col overflow-hidden">
        <Show when={tab() === "timeline"}>
          <View class="flex-col">
            {/* Index + fixed w×h cells: a new tool call shifts text through
                the same nodes (no row teardown, no relayout, no full repaint) */}
            <Index each={timeline()}>
              {(r) => (
                <View class="h-[14] flex-row justify-between">
                  <Text class="text-xs font-bold text-[#b3b3b3] leading-[14]" style={{ width: 262, height: 14 }}>
                    {r().left}
                  </Text>
                  <Text
                    class="text-xs font-bold leading-[14] text-right"
                    style={{ width: 48, height: 14, textColor: r().ok === "fail" ? "#ffb4a8" : r().ok === "run" ? accent() : "#5a5a5a" }}
                  >
                    {r().ok === "fail" ? `${r().right} ×` : r().right}
                  </Text>
                </View>
              )}
            </Index>
          </View>
        </Show>
        <Show when={tab() === "prompts"}>
          <View class="flex-col gap-[3]">
            <Index each={((s().prompts ?? []) as any[]).slice(0, 5)}>
              {(p) => (
                <View class="flex-row gap-2">
                  <Text class="text-xs font-bold leading-[14]" style={{ textColor: accent() }}>
                    {p().at}
                  </Text>
                  <Text class="text-xs font-bold text-[#b3b3b3] leading-[14]">{wrap(lower(p().text), 36, 2)}</Text>
                </View>
              )}
            </Index>
          </View>
        </Show>
        <Show when={tab() === "reply"}>
          <Text class="text-xs font-bold text-[#b3b3b3] leading-[14]">{wrap(s().last || "no reply yet", 43, 8)}</Text>
        </Show>
      </View>
      {/* quick actions (run on the Mac) */}
      <View class="flex-row gap-1">
        <Pill label="terminal" onPress={() => act("claude.terminal", { session: s().id })} />
        <Pill label="editor" onPress={() => act("claude.editor", { session: s().id })} />
        <Pill label="copy reply" onPress={() => act("claude.copy", { session: s().id })} />
        <Pill label="claude" primary onPress={() => act("claude.focus", { session: s().id })} />
      </View>
    </View>
  );
}

export function ClaudePage(props: { active: Active }) {
  const sessions = () => (desk.claude?.sessions ?? []) as any[];
  const sel = createMemo(() => sessions().find((s) => s.id === selected()) ?? sessions()[0]);
  return (
    <View class="h-full flex-row gap-2 p-2" style={{ width: 512 }}>
      <Rail active={props.active} sel={sel} />
      <View class="w-[1] h-full bg-[#222222]" />
      <View class="flex-1 flex-col overflow-hidden" style={{ basis: 0 }}>
        <Show when={sessions().length > 0}>
          <Detail active={props.active} s={sel} />
        </Show>
        <Show when={sessions().length === 0}>
          <View class="flex-1 items-center justify-center gap-3">
            <Morph size={72} layers={4} morph={() => 0.5 + 0.5 * Math.sin(Date.now() / 1400)} spin={() => 0.4} color={() => "#262626"} active={props.active} />
            <Text class={T.monoSm}>{desk.claude?.hooks === false ? "hooks not installed" : "no active sessions"}</Text>
          </View>
        </Show>
      </View>
    </View>
  );
}

// ---- app-wide layers -------------------------------------------------------------

/** Bottom sheet for a permission request held by deskd's gate. */
export function PermissionSheet() {
  const p = () => desk.claude?.pending;
  let sheet: NodeMirror | undefined;
  let shown = false;
  const [vis, setVis] = createSignal(false);
  onFrame(() => {
    const want = !!p() && desk.layout?.approvals !== false;
    if (want !== shown && sheet) {
      shown = want;
      setVis(want);
      spring(sheet, "translateY", want ? 0 : 140);
    }
  });
  return (
    <View class="absolute" style={{ insetL: 8, insetR: 8, insetB: 8 }}>
      <View ref={(n: NodeMirror) => (sheet = n)} style={{ translateY: 140 }} class="w-full rounded-[22] bg-[#141414] border border-[#363636] flex-row items-center gap-3 p-3">
        <Morph size={44} layers={3} spin={() => 2.5} breathe={() => 0.06} active={vis} />
        <View class="flex-1 flex-col gap-[2]">
          <Text class="text-xs font-bold" style={{ textColor: accent() }}>
            {`${lower(p()?.session ?? "")} asks · ${desk.claudeTick?.left ?? p()?.left ?? 0}s`}
          </Text>
          <Text class="text-base text-[#ededed]">{`allow ${lower(p()?.tool ?? "")}?`}</Text>
          <Text class={T.monoSm}>{clip(lower(p()?.summary ?? ""), 40)}</Text>
        </View>
        <View class="w-[78] h-[38] rounded-[999] border border-[#363636] items-center justify-center active:bg-[#1d1d1d]" focusable onPress={() => act("claude.permit", { id: p()?.id, allow: false })}>
          <Text class="text-sm text-[#ededed]">deny</Text>
        </View>
        <View class="w-[86] h-[38] rounded-[999] items-center justify-center" style={{ bgColor: accent() }} focusable onPress={() => act("claude.permit", { id: p()?.id, allow: true })}>
          <Text class="text-sm" style={{ textColor: ON_ACCENT }}>
            allow
          </Text>
        </View>
      </View>
    </View>
  );
}

/** Accent flash + a toast when a session newly needs you. */
export function AttentionLayer(props: { onOpen: () => void; onClaude: () => boolean }) {
  let flash: NodeMirror | undefined;
  let toast: NodeMirror | undefined;
  let seq = -1;
  let t = 99;
  let toastUntil = 0;
  let toastShown = false;
  const a = () => desk.claude?.alert ?? {};
  onFrame(() => {
    const cur = a().seq ?? 0;
    if (seq < 0) seq = cur; // don't flash for alerts older than this mount
    if (cur !== seq) {
      seq = cur;
      if (desk.layout?.flash !== false) t = 0;
      if (!props.onClaude()) toastUntil = Date.now() + 9000;
    }
    if (flash && t < 1.6 && decorFrame()) {
      t += DECOR_STEP / 60;
      // three decaying pulses
      jump(flash, "opacity", Math.max(0, Math.sin(t * Math.PI * 1.9) * 0.4 * (1 - t / 1.6)));
      if (t >= 1.6) jump(flash, "opacity", 0);
    }
    const want = Date.now() < toastUntil && !props.onClaude();
    if (toast && want !== toastShown) {
      toastShown = want;
      spring(toast, "translateY", want ? 0 : -90);
    }
  });
  return (
    <>
      <View ref={(n: NodeMirror) => (flash = n)} class="absolute inset-0" style={{ bgColor: accent(), opacity: 0 }} />
      <View class="absolute flex-row justify-center" style={{ insetL: 0, insetR: 0, insetT: 34 }}>
        <View
          ref={(n: NodeMirror) => (toast = n)}
          style={{ translateY: -90, bgColor: accent() }}
          class="h-[30] rounded-[999] flex-row items-center gap-2 px-4"
          focusable
          onPress={() => {
            toastUntil = 0;
            if (a().session) setSelected(a().session);
            props.onOpen();
          }}
        >
          <View class="w-[8] h-[8] rounded-[2] bg-[#0b1d33]" />
          <Text class="text-sm" style={{ textColor: ON_ACCENT }}>
            {`${lower(clip(a().name, 18))} needs you`}
          </Text>
          <Text class="text-xs font-bold" style={{ textColor: ON_ACCENT }}>
            open →
          </Text>
        </View>
      </View>
    </>
  );
}
