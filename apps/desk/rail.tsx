// The left strip over the panel damage (damage.ts): an ASCII sound wave
// scrolling down the damaged column, plus HOME's essentials (time, date, Claude, battery) in the strip's one clean
// pocket, so they are on screen whatever pane is open. Nothing here is tappable.

import { For, createSignal } from "solid-js";
import { Text, View } from "@pocketjs/framework/components";
import { onFrame } from "@pocketjs/framework/lifecycle";
import { desk, linkConnected } from "./link.ts";
import { decorPhase } from "./clock.ts";
import { SAFE_X } from "./damage.ts";
import { T, accent } from "./theme.ts";

const WAIT = "#ffd27a";
const pad2 = (n: number) => (n < 10 ? `0${n}` : `${n}`);
const lower = (s: unknown) => (typeof s === "string" ? s.toLowerCase() : "");

/** Clean pocket inside the strip: right of x 4, between zone A (to y 70) and
 *  zones B/C/D (from x 54 at y ≥ 192, x 63 from y 112, everything from y 254). */
const POCKET = { x: 4, y: 76, w: 48, h: 174 };

// ---- the wave -----------------------------------------------------------------------

const WAVE_X = 56; // right of the info pocket (x 4..52); covers zones B, C, D, E
const COLS = 8; // 8 × 6.2 px mono advance ≈ the 50 px to x 106
const ROWS = 30; // 10 px rows, full height
const CELL_W = Math.ceil(COLS * 6.2);

/** A vertical audio-style wave: each row is a bar centred in the column, as wide
 *  as the level at that moment; new rows enter at the top and scroll down at 10 Hz.
 *  The level is a few beating sines (livelier while music plays); loud rows are
 *  drawn in the accent colour. Rows are fixed w×h text cells, never "" (no relayout). */
function Wave() {
  const dim = Array.from({ length: ROWS }, () => createSignal(" "));
  const hot = Array.from({ length: ROWS }, () => createSignal(" "));
  const dimRows: string[] = new Array(ROWS).fill(" ");
  const hotRows: string[] = new Array(ROWS).fill(" ");
  const half = COLS / 2;
  let t = 0;
  let energy = 0.5;
  const row = (level: number): [string, boolean] => {
    const w = level * half; // half-width in columns
    let out = "";
    for (let c = 0; c < COLS; c++) {
      const d = Math.abs(c + 0.5 - half); // distance from the centre line
      out += d < w - 1 ? "|" : d < w - 0.3 ? ":" : d < w + 0.4 ? "." : " ";
    }
    return [out.trimEnd() || " ", level > 0.78];
  };
  onFrame(() => {
    if (!decorPhase(6)) return; // 10 Hz
    const playing = desk.music?.state === "playing";
    energy += ((playing ? 1 : 0.75) - energy) * 0.05;
    t += 0.1;
    const raw =
      0.45 * Math.abs(Math.sin(t * 1.3)) +
      0.3 * Math.abs(Math.sin(t * 3.1 + 1.2)) +
      0.25 * Math.abs(Math.sin(t * 7.7 + 0.4)) * (playing ? 1 : 0.5);
    const level = Math.max(0.12, Math.min(1, raw * energy * 1.45));
    const [r, loud] = row(level);
    dimRows.pop();
    hotRows.pop();
    dimRows.unshift(loud ? " " : r);
    hotRows.unshift(loud ? r : " ");
    for (let i = 0; i < ROWS; i++) {
      dim[i]![1](dimRows[i]!);
      hot[i]![1](hotRows[i]!);
    }
  });
  return (
    <View class="absolute flex-col" style={{ insetL: WAVE_X, insetT: 0 }}>
      <For each={dim}>
        {(r, i) => (
          <View class="h-[10] relative">
            <Text class="text-xs font-bold text-[#6a6a6a] leading-[10]" style={{ width: CELL_W, height: 10 }}>{r[0]()}</Text>
            <View class="absolute inset-0">
              <Text class="text-xs font-bold leading-[10]" style={{ width: CELL_W, height: 10, textColor: accent() }}>{hot[i()]![0]()}</Text>
            </View>
          </View>
        )}
      </For>
    </View>
  );
}

// ---- the rail -------------------------------------------------------------------------

export function Rail() {
  const clock = () => desk.clock ?? {};
  const date = () => lower(clock().date).split(" ");
  const sessions = () => (desk.claude?.sessions ?? []).length;
  const waiting = () => desk.claude?.counts?.waiting ?? 0;
  const tab = () => desk.tablet ?? {};
  return (
    <View class="h-full relative overflow-hidden" style={{ width: SAFE_X }}>
      <Wave />
      <View class="absolute flex-col bg-[#070707]" style={{ insetL: 0, insetT: POCKET.y - 2, width: POCKET.x + POCKET.w + 2, height: POCKET.h + 4 }}>
        <View class="flex-col" style={{ paddingL: POCKET.x, paddingT: 2 }}>
          <Text class="text-4xl leading-[38]" style={{ textColor: accent() }}>{clock().h !== undefined ? pad2(clock().h) : "--"}</Text>
          <Text class="text-4xl leading-[38] text-[#ededed]">{clock().m !== undefined ? pad2(clock().m) : "--"}</Text>
          <View class="h-[4]" />
          <Text class="text-sm text-[#ededed]">{date()[0] ? date()[0]!.slice(0, 3) : "–"}</Text>
          <Text class="text-sm text-[#b3b3b3]">{date().slice(1).join(" ") || " "}</Text>
          <View class="h-[6]" />
          {/* below y 192 the pocket ends at x 54 (zone C): keep these rows short */}
          <Text class={T.monoSm}>claude</Text>
          <View class="flex-row items-center gap-[4]">
            <View class="w-[6] h-[6] rounded-[2]" style={{ bgColor: waiting() > 0 ? WAIT : sessions() > 0 ? accent() : "#4a4a4a" }} />
            <Text class="text-xs font-bold" style={{ textColor: waiting() > 0 ? WAIT : "#b3b3b3" }}>
              {waiting() > 0 ? `${waiting()} wait` : `${sessions()} live`}
            </Text>
          </View>
          <View class="h-[4]" />
          <Text class={T.mono}>
            {tab().battery !== undefined ? `${tab().battery}%${tab().charging ? "↑" : ""}` : linkConnected() ? "–" : "off"}
          </Text>
        </View>
      </View>
    </View>
  );
}
