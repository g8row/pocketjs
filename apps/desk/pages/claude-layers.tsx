// App-wide CLAUDE layers (mounted by app.tsx over the 406 px page area):
//  - PermissionSheet: a request held by deckd's gate, on pages other than CLAUDE (there the page
//    itself handles it). Permissions get deny / allow; questions and plans get "open".
//  - AttentionLayer: a wait-yellow flash and a toast when a session newly needs you. On CLAUDE the
//    toast still shows when the alert is for a session other than the one on screen.
// Both are touchable, so both are rounded.

import { Show } from "solid-js";
import { Text, View, type NodeMirror } from "@pocketjs/framework/components";
import { onFrame } from "@pocketjs/framework/lifecycle";
import { jump, spring } from "@pocketjs/framework/animation";
import { act, desk } from "../link.ts";
import { DECOR_STEP, decorFrame } from "../clock.ts";
import { Btn, C, Icon, PW, Sheet } from "../ui.tsx";
import { fit, lower, setSelected, shown } from "./claude-lib.ts";

/** Bottom sheet for a request held by deckd's gate, on pages other than CLAUDE. */
export function PermissionSheet(props: { onClaude: () => boolean; onOpen: () => void }) {
  const p = () => desk.claude?.pending;
  const simple = () => (p()?.kind ?? "permission") === "permission";
  const open = () => !!p() && desk.layout?.approvals !== false && !props.onClaude();
  const left = () => desk.claudeTick?.left ?? p()?.left ?? 0;
  // sheet inner width: 406 - 2×8 inset - 2×12 padding - 2 border; minus icon, buttons, gaps
  const TEXT_W = PW - 16 - 24 - 2 - 22 - 12 * 3 - (70 + 78);
  return (
    <Sheet open={open} color={C.wait}>
      <Icon name="robot" size="2xl" color={C.wait} />
      <View class="flex-1 flex-col gap-[2]">
        <Text class="text-xs font-bold" style={{ textColor: C.wait }}>
          {fit(`${lower(p()?.session) || "claude"} · ${left()}s`, TEXT_W, 12, true)}
        </Text>
        <Text class="text-base" style={{ textColor: C.fg }}>
          {simple() ? fit(`allow ${lower(p()?.tool) || "a tool"}?`, TEXT_W, 16) : p()?.kind === "plan" ? "approve the plan?" : "a question for you"}
        </Text>
        <Text class="text-xs font-bold" style={{ textColor: C.mute }}>
          {simple() ? fit(p()?.summary, TEXT_W, 12, true) : "answer it on the claude page"}
        </Text>
      </View>
      <Show
        when={simple()}
        fallback={<Btn label="open →" kind="wait" w={100} h={34} onPress={() => props.onOpen()} />}
      >
        <Btn label="deny" w={70} h={34} onPress={() => act("claude.permit", { id: p()?.id, allow: false })} />
        <Btn label="allow" kind="wait" w={78} h={34} onPress={() => act("claude.permit", { id: p()?.id, allow: true })} />
      </Show>
    </Sheet>
  );
}

/** Wait-yellow flash + a toast when a session newly needs you. */
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
    // don't flash for alerts older than this mount; a deckd restart resets the counter
    // (cur < seq): adopt it silently
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
  // pill: 16 px padding each side, icon 14 + "view →" 42 + two 8 px gaps
  const TEXT_W = PW - 24 - 32 - 14 - 42 - 16;
  return (
    <>
      <View ref={(n: NodeMirror) => (flash = n)} class="absolute inset-0" style={{ bgColor: C.wait, opacity: 0 }} />
      <View class="absolute flex-row justify-center" style={{ insetL: 0, insetR: 0, insetT: 34 }}>
        <View
          ref={(n: NodeMirror) => (toast = n)}
          style={{ translateY: -90, bgColor: C.wait }}
          class="h-[32] rounded-[999] flex-row items-center gap-[8] px-4"
          focusable
          onPress={() => {
            toastUntil = 0;
            if (a().session) setSelected(a().session);
            props.onOpen();
          }}
        >
          <Icon name="robot" size="base" color={C.onWait} />
          <Text class="text-sm" style={{ textColor: C.onWait }}>
            {fit(`${lower(a().name) || "claude"} ${lower(a().reason) || "needs you"}`, TEXT_W, 14)}
          </Text>
          <Text class="text-xs font-bold" style={{ textColor: C.onWait }}>
            view →
          </Text>
        </View>
      </View>
    </>
  );
}
