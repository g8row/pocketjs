// Desk — the TB-7304X desk companion (activity host and kiosk mode).
// Swipeable panes fed by deskd over the USB link. Which panes, and in what
// order, comes from deskd's `layout` state (desk.config.json, edited in the
// Desk Studio UI); the pager is rebuilt whenever that list changes.
// 512×300 logical = the 1024×600 panel at 2x.

import { For, Show, createEffect, createMemo, on } from "solid-js";
import { Text, View } from "@pocketjs/framework/components";
import { desk, useLink } from "./link.ts";
import { useDecorClock } from "./clock.ts";
import { createPager } from "./pager.tsx";
import { HomePage, MusicPage, SystemPage, createFrameStats } from "./pages.tsx";
import { DeckPage } from "./deck.tsx";
import { AttentionLayer, ClaudePage, PermissionSheet } from "./claude.tsx";
import { BoardPage, FocusPage, PulsePage } from "./views.tsx";
import { CHARSET } from "./charset.ts";
import { T, W, accent } from "./theme.ts";
import { configureTouch } from "@pocketjs/framework/input";

// The tablet's cracked glass reports phantom contacts (most are masked out by
// the kiosk host, POCKETJS_TOUCH_MASK). A press held over 1 s fires nothing,
// so a long phantom hold, or a stuck contact the host retires
// (POCKETJS_TOUCH_STALE_MS), cannot press what is under it.
configureTouch({ tapMaxFrames: 60 });

// Glyph coverage for runtime text (song titles, Claude messages): the build
// bakes every codepoint it sees in source literals.
void CHARSET;

const DEFAULT_PANES = ["home", "claude", "pulse", "deck", "music", "board", "focus", "system"];
const KNOWN = new Set(DEFAULT_PANES);

function Shell(props: { panes: string[]; fps: () => number; gaps: number[] }) {
  const panes = props.panes;
  const pager = createPager(panes.length, W);
  const on_ = (i: number) => () => pager.page() === i || pager.dragging();
  const claudeIdx = panes.indexOf("claude");
  const waiting = () => (desk.claude?.counts?.waiting ?? 0) > 0;
  // deskd (or the Studio's "show" button) can jump to a pane
  createEffect(
    on(
      () => desk.nav?.seq,
      (seq) => {
        if (seq === undefined) return;
        const i = panes.indexOf(desk.nav.pane);
        if (i >= 0) pager.go(i);
      },
      { defer: true },
    ),
  );
  const page = (id: string, i: number) => {
    switch (id) {
      case "home":
        return <HomePage active={on_(i)} fps={props.fps} />;
      case "deck":
        return <DeckPage active={on_(i)} />;
      case "music":
        return <MusicPage active={on_(i)} />;
      case "claude":
        return <ClaudePage active={on_(i)} />;
      case "pulse":
        return <PulsePage active={on_(i)} />;
      case "board":
        return <BoardPage active={on_(i)} fps={props.fps} />;
      case "focus":
        return <FocusPage active={on_(i)} />;
      default:
        return <SystemPage active={on_(i)} fps={props.fps} gaps={props.gaps} />;
    }
  };
  return (
    <View class="w-full h-full flex-col">
      {/* the site's nav: a strip of cells divided by 1px rules; tap to jump */}
      <View class="h-[28] flex-row bg-[#222222] gap-[1]">
        <For each={panes}>
          {(name, i) => (
            <View
              class={pager.page() === i() ? "flex-1 h-full justify-center items-center bg-[#141414]" : "flex-1 h-full justify-center items-center bg-[#0a0a0a] active:bg-[#141414]"}
              style={{ basis: 0 }}
              focusable
              onPress={() => pager.go(i())}
            >
              <Text
                class="text-xs font-bold tracking-wide"
                style={{ textColor: name === "claude" && waiting() ? accent() : pager.page() === i() ? "#ffffff" : "#8a8a8a" }}
              >
                {name.toUpperCase()}
              </Text>
              <View class="absolute w-[16] h-[2] rounded-[1]" style={{ insetB: 0, bgColor: pager.page() === i() || (name === "claude" && waiting()) ? accent() : "#0a0a0a" }} />
            </View>
          )}
        </For>
      </View>
      <View class={T.rule} />
      <View class="flex-1 overflow-hidden">
        {/* Each pane clips: the core's paint walk skips an overflow-hidden
            subtree whose clip is empty, so off-screen panes cost nothing to
            repaint (without this every repaint walked all panes' nodes). */}
        <pager.Track>
          {panes.map((id, i) => (
            <View class="h-full overflow-hidden" style={{ width: W }}>
              {page(id, i)}
            </View>
          ))}
        </pager.Track>
      </View>
      <AttentionLayer onOpen={() => claudeIdx >= 0 && pager.go(claudeIdx)} onClaude={() => pager.page() === claudeIdx} />
      <PermissionSheet onClaude={() => pager.page() === claudeIdx} onOpen={() => claudeIdx >= 0 && pager.go(claudeIdx)} />
    </View>
  );
}

export default function Desk() {
  useLink();
  useDecorClock();
  const { fps, gaps } = createFrameStats();
  const key = createMemo(() => {
    const list = ((desk.layout?.panes ?? DEFAULT_PANES) as string[]).filter((p) => KNOWN.has(p));
    return (list.length ? list : DEFAULT_PANES).join(",");
  });
  return (
    <View debugName="Desk" class={T.screen}>
      <Show when={key()} keyed>
        {(k) => <Shell panes={k.split(",")} fps={fps} gaps={gaps} />}
      </Show>
    </View>
  );
}
