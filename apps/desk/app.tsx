// Desk — the TB-7304X desk companion (activity host and kiosk mode).
// Five swipeable panes fed by deskd over the USB link, built from g8row.xyz's
// components. 512×300 logical = the 1024×600 panel at 2x.

import { For } from "solid-js";
import { Text, View } from "@pocketjs/framework/components";
import { useLink } from "./link.ts";
import { createPager } from "./pager.tsx";
import { ClaudePage, DeckPage, HomePage, MusicPage, SystemPage, createFrameStats } from "./pages.tsx";
import { CHARSET } from "./charset.ts";
import { T, W } from "./theme.ts";

// Glyph coverage for runtime text (song titles, Claude messages): the build
// bakes every codepoint it sees in source literals.
void CHARSET;

const PAGES = ["home", "deck", "music", "claude", "system"] as const;

export default function Desk() {
  useLink();
  const { fps, gaps } = createFrameStats();
  const pager = createPager(PAGES.length, W);
  // A page animates only while it's on screen (or being swiped into view).
  const on = (i: number) => () => pager.page() === i || pager.dragging();
  return (
    <View debugName="Desk" class={T.screen}>
      {/* the site's nav: a strip of cells divided by 1px rules; tap to jump */}
      <View class="h-[28] flex-row bg-[#222222] gap-[1]">
        <For each={[...PAGES]}>
          {(name, i) => (
            <View
              class={pager.page() === i() ? "flex-1 h-full justify-center px-3 bg-[#141414]" : "flex-1 h-full justify-center px-3 bg-[#0a0a0a] active:bg-[#141414]"}
              style={{ basis: 0 }}
              focusable
              onPress={() => pager.go(i())}
            >
              <View class="flex-row items-center justify-between">
                <Text class={pager.page() === i() ? "text-xs font-bold text-[#ffffff] tracking-wide" : "text-xs font-bold text-[#8a8a8a] tracking-wide"}>
                  {name.toUpperCase()}
                </Text>
                <View class={pager.page() === i() ? "w-[5] h-[5] rounded-[1] bg-[#a8c7fa]" : "w-[5] h-[5] rounded-[1] border border-[#363636]"} />
              </View>
            </View>
          )}
        </For>
      </View>
      <View class={T.rule} />
      <View class="flex-1 overflow-hidden">
        <pager.Track>
          <HomePage active={on(0)} fps={fps} />
          <DeckPage />
          <MusicPage active={on(2)} />
          <ClaudePage active={on(3)} />
          <SystemPage active={on(4)} fps={fps} gaps={gaps} />
        </pager.Track>
      </View>
    </View>
  );
}
