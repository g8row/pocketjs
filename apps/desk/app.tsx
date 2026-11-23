// PocketDeck — the deck app on the TB-7304X (PocketJS Linux host).
// Swipeable panes fed by deckd over the USB link. Which panes, and in what
// order, comes from deckd's `layout` state (deck.config.json, edited in Deck
// Studio); the pager is rebuilt whenever that list changes.
// 512×300 logical = the 1024×600 panel at 2x. The strip left of x 106 is the
// rail over the damaged panel area (rail.tsx); every pane is PW × PH (ui.tsx).
// Design rules and the page briefs: DESIGN.md.

import { For, Show, createEffect, createMemo, on } from "solid-js";
import { Text, View } from "@pocketjs/framework/components";
import { configureTouch } from "@pocketjs/framework/input";
import { desk, useLink } from "./link.ts";
import { useDecorClock } from "./clock.ts";
import { createPager } from "./pager.tsx";
import { CHARSET } from "./charset.ts";
import { T, accent } from "./theme.ts";
import { Rail } from "./rail.tsx";
import { PW } from "./ui.tsx";
import { BoardPage } from "./pages/board.tsx";
import { DeckPage } from "./pages/deck.tsx";
import { AttentionLayer, ClaudePage, PermissionSheet } from "./pages/claude.tsx";
import { UsagePage } from "./pages/usage.tsx";
import { MusicPage } from "./pages/music.tsx";
import { SettingsPage } from "./pages/settings.tsx";

// The tablet's cracked glass reports phantom contacts (most are masked out by
// the PocketJS host, POCKETJS_TOUCH_MASK). A press held over 1 s fires nothing,
// so a long phantom hold, or a stuck contact the host retires
// (POCKETJS_TOUCH_STALE_MS), cannot press what is under it.
configureTouch({ tapMaxFrames: 60 });

// Glyph coverage for runtime text (song titles, Claude messages): the build
// bakes every codepoint it sees in source literals.
void CHARSET;

const DEFAULT_PANES = ["board", "deck", "claude", "usage", "music", "settings"];
const KNOWN = new Set(DEFAULT_PANES);
const LABEL: Record<string, string> = { board: "BOARD", deck: "DECK", claude: "CLAUDE", usage: "USAGE", music: "MUSIC", settings: "SETTINGS" };

function Shell(props: { panes: string[] }) {
  const panes = props.panes;
  const pager = createPager(panes.length, PW);
  const on_ = (i: number) => () => pager.page() === i || pager.dragging();
  const claudeIdx = panes.indexOf("claude");
  const waiting = () => (desk.claude?.counts?.waiting ?? 0) > 0;
  // deckd (or Deck Studio's "show" button) can jump to a pane
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
      case "board":
        return <BoardPage active={on_(i)} />;
      case "deck":
        return <DeckPage active={on_(i)} />;
      case "claude":
        return <ClaudePage active={on_(i)} />;
      case "usage":
        return <UsagePage active={on_(i)} />;
      case "music":
        return <MusicPage active={on_(i)} />;
      default:
        return <SettingsPage active={on_(i)} />;
    }
  };
  return (
    <View class="h-full flex-col" style={{ width: PW }}>
      {/* the nav: a strip of cells divided by 1px rules; tap to jump */}
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
                {LABEL[name] ?? name.toUpperCase()}
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
            repaint. */}
        <pager.Track>
          {panes.map((id, i) => (
            <View class="h-full overflow-hidden" style={{ width: PW }}>
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
  const key = createMemo(() => {
    // A layout from before the redesign (home/pulse/focus/system) gets the new default order.
    const raw = (desk.layout?.panes ?? DEFAULT_PANES) as string[];
    if (raw.some((p) => ["home", "pulse", "focus", "system"].includes(p))) return DEFAULT_PANES.join(",");
    const list = [...new Set(raw.filter((p) => KNOWN.has(p)))];
    return (list.length ? list : DEFAULT_PANES).join(",");
  });
  return (
    <View debugName="Desk" class="w-full h-full flex-row bg-[#070707]">
      {/* The panel is cracked and has dead pixels left of x 106 (damage.ts):
          that strip shows an ambient sound wave plus the clock/date/Claude/battery
          in its one clean pocket (rail.tsx), never touch targets. Everything else
          lives in the clean 406 px to its right. */}
      <Rail />
      <Show when={key()} keyed>
        {(k) => <Shell panes={k.split(",")} />}
      </Show>
    </View>
  );
}
