// The g8row.xyz hero "signal": an ASCII ridge-line field of moving sine waves,
// ported from site.js (same envelope, three sines per ridge, nearest ridge
// occludes the ones behind, slopes drawn as / and \, hot peaks in accent).
// Each row is two mono Text nodes (dim layer + accent layer) so one row can
// carry two colors; the whole field re-renders every frame.

import { createSignal, For } from "solid-js";
import { Text, View } from "@pocketjs/framework/components";
import { onFrame } from "@pocketjs/framework/lifecycle";

export function Ridges(props: { cols: number; rows: number; ridges?: number; every?: number; active?: () => boolean }) {
  const C = props.cols;
  const R = props.rows;
  const L = props.ridges ?? 14;
  const every = props.every ?? 1;
  const rowsDim = Array.from({ length: R }, () => createSignal(""));
  const rowsHot = Array.from({ length: R }, () => createSignal(""));
  let frame = 0;

  const render = (t: number) => {
    const dim: string[][] = Array.from({ length: R }, () => new Array(C).fill(" "));
    const hot: string[][] = Array.from({ length: R }, () => new Array(C).fill(" "));
    // dotted ground grid, like the site's background
    for (let y = 1; y < R; y += 4) for (let x = 2; x < C; x += 6) dim[y]![x] = ".";
    const top = new Array(C).fill(R);
    for (let i = L - 1; i >= 0; i--) {
      const depth = i / (L - 1);
      const base = R * 0.42 + i * (R * 0.04);
      const amp = R * (0.16 + depth * 0.28);
      const ys = new Array<number>(C);
      const hs = new Array<number>(C);
      for (let x = 0; x < C; x++) {
        const u = (x / (C - 1)) * 2 - 1;
        const env = Math.exp(-u * u * 2.6);
        const h =
          env *
          (0.55 * Math.sin(u * 5.2 + t * 0.9 + i * 0.45) +
            0.3 * Math.sin(u * 11.7 - t * 1.4 + i * 0.8) +
            0.15 * Math.sin(u * 23 + t * 2.1 + i * 1.7));
        hs[x] = env > 0.14 ? h : NaN;
        ys[x] = Math.round(base - Math.max(h, -0.2) * amp);
      }
      const next = top.slice();
      for (let x = 0; x < C; x++) {
        if (Number.isNaN(hs[x]!)) continue;
        const y = ys[x]!;
        const prev = x > 0 && !Number.isNaN(hs[x - 1]!) ? ys[x - 1]! : y;
        const after = x < C - 1 ? ys[x + 1]! : y;
        const dy = after - prev;
        const ch = dy <= -2 ? "/" : dy >= 2 ? "\\" : depth < 0.45 ? "." : "-";
        if (y < 0 || y >= R || y >= top[x]) continue; // occluded by a nearer ridge
        const isHot = hs[x]! > 0.42 && depth > 0.3;
        if (isHot) hot[y]![x] = ch;
        else dim[y]![x] = ch;
        // clear the dot grid below this ridge column, so ridges read as solid
        for (let yy = y + 1; yy < Math.min(top[x], R); yy++) if (dim[yy]![x] === ".") dim[yy]![x] = " ";
        next[x] = y;
      }
      for (let x = 0; x < C; x++) top[x] = Math.min(top[x], next[x]);
    }
    // trimEnd: trailing spaces are still glyph quads; skip them.
    for (let y = 0; y < R; y++) {
      rowsDim[y]![1](dim[y]!.join("").trimEnd());
      rowsHot[y]![1](hot[y]!.join("").trimEnd());
    }
  };

  render(2.4);
  let t = 2.4;
  onFrame(() => {
    if (props.active && !props.active()) return; // off-screen: no work at all
    frame++;
    t += 1 / 60;
    if (frame % every === 0) render(t);
  });

  return (
    <View class="flex-col">
      <For each={rowsDim}>
        {(row, i) => (
          <View class="h-[10] relative">
            <Text class="text-xs font-bold text-[#3a3a3a] leading-[10]">{row[0]()}</Text>
            <View class="absolute inset-0">
              <Text class="text-xs font-bold text-[#a8c7fa] leading-[10]">{rowsHot[i()]![0]()}</Text>
            </View>
          </View>
        )}
      </For>
    </View>
  );
}
