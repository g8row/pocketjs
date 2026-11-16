// Desk — the TB-7304X desk companion (activity host and kiosk mode).
// Five swipeable panes fed by deskd over the USB link; styled after g8row.xyz.
// 512×300 logical = the 1024×600 panel at 2x.

import { For } from "solid-js";
import { Text, View } from "@pocketjs/framework/components";
import { linkConnected, desk, useLink } from "./link.ts";
import { createPager } from "./pager.tsx";
import { ClaudePage, DeckPage, HomePage, MusicPage, SystemPage, createFps } from "./pages.tsx";
import { CHARSET } from "./charset.ts";
import { T, W } from "./theme.ts";

// Glyph coverage for runtime text (song titles, Claude messages): the build
// bakes every codepoint it sees in source literals.
void CHARSET;

const PAGES = ["HOME", "DECK", "MUSIC", "CLAUDE", "SYSTEM"] as const;
const pad2 = (n: number) => (n < 10 ? `0${n}` : `${n}`);

export default function Desk() {
  useLink();
  const fps = createFps();
  const pager = createPager(PAGES.length, W);
  const clock = () => desk.clock ?? {};
  // A page animates only while it's on screen (or being swiped into view).
  const on = (i: number) => () => pager.page() === i || pager.dragging();
  return (
    <View debugName="Desk" class={T.screen}>
      {/* header: mono eyebrow · page dots · clock + link — a 1px rule underneath */}
      <View class="h-[30] flex-row items-center justify-between px-3">
        <View class="flex-row items-center gap-2" style={{ width: 150 }}>
          <View class="w-2 h-2 rounded-[1] border border-[#363636]" />
          <Text class={T.eyebrow}>{`TB-7304X / ${PAGES[pager.page()]}`}</Text>
        </View>
        <View class="flex-row items-center gap-1">
          <For each={[...PAGES]}>
            {(_, i) => (
              <View
                class={pager.page() === i() ? "w-[18] h-[6] rounded-[3] bg-[#a8c7fa]" : "w-[6] h-[6] rounded-[3] bg-[#363636]"}
                focusable
                onPress={() => pager.go(i())}
              />
            )}
          </For>
        </View>
        <View class="flex-row items-center justify-end gap-2" style={{ width: 150 }}>
          <Text class={T.monoSm}>{`${fps()}fps`}</Text>
          <Text class={T.mono}>{clock().h !== undefined ? `${pad2(clock().h)}:${pad2(clock().m)}` : "--:--"}</Text>
          <View class={linkConnected() ? "w-2 h-2 rounded-full bg-[#6ee7b7]" : "w-2 h-2 rounded-full bg-[#fb7185]"} />
        </View>
      </View>
      <View class={T.rule} />
      <View class="flex-1 overflow-hidden">
        <pager.Track>
          <HomePage active={on(0)} />
          <DeckPage />
          <MusicPage active={on(2)} />
          <ClaudePage active={on(3)} />
          <SystemPage fps={fps} active={on(4)} />
        </pager.Track>
      </View>
    </View>
  );
}
