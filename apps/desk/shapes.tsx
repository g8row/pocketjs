// Material 3 Expressive shapes + ASCII instruments, all paint-only motion.
//
// Morph: N rounded squares stacked on one center. With every layer at the same
// angle it is a squircle; fanned out by 90/N degrees each it becomes an
// N×4-point scallop ("cookie"). `morph` (0..1) slides between the two, `spin`
// rotates the whole thing, `breathe` scales it — only rotate/scale change, so
// the core never relayouts.
//
// Trace: a scrolling ASCII seismograph. Every few frames the columns shift left
// and a new column is pushed whose height follows `level()` plus noise; slopes
// draw as / \, crests as -, the body as : — two Text layers per row (dim body,
// accent crest) like the hero ridge field.

import { createSignal, For, type Accessor } from "solid-js";
import { Text, View, type NodeMirror } from "@pocketjs/framework/components";
import { onFrame } from "@pocketjs/framework/lifecycle";
import { createJumpBatch } from "@pocketjs/framework/animation";
import { accent } from "./theme.ts";
import { DECOR_STEP, decorFrame, decorPhase, minVisibleDeg } from "./clock.ts";

type Num = () => number;

export function Morph(props: {
  size: number;
  layers?: number;
  morph?: Num;
  spin?: Num;
  breathe?: Num;
  color?: () => string;
  active?: () => boolean;
  children?: any;
}) {
  const L = props.layers ?? 3;
  const nodes: NodeMirror[] = [];
  let batch: ReturnType<typeof createJumpBatch> | undefined;
  let angle = Math.random() * 90;
  let t = 0;
  let m = props.morph?.() ?? 1;
  let lastA = -999;
  let lastSpread = -999;
  let lastSc = -999;
  const MIN_DEG = minVisibleDeg(props.size);
  onFrame(() => {
    if (props.active && !props.active()) return;
    if (!batch && nodes.length === L) {
      const pairs: [NodeMirror, "rotate" | "scale"][] = [];
      for (const n of nodes) pairs.push([n, "rotate"], [n, "scale"]);
      batch = createJumpBatch(pairs);
    }
    if (!batch || !decorFrame()) return;
    t += DECOR_STEP / 60;
    angle = (angle + (props.spin?.() ?? 0.3) * DECOR_STEP) % 360;
    m += ((props.morph?.() ?? 1) - m) * 0.12; // ease toward the target shape
    const b = props.breathe?.() ?? 0;
    const sc = 1 + b * Math.sin(t * 3.2);
    // Perf: every commit re-rasters the shape (rotated tris, software) and
    // posts a frame. Commit only once a corner moved ≥ 1 px, so an idle
    // shape repaints a few times a second, not 30.
    const spread = (90 / L) * m;
    // ...and at most at 15 Hz, on the shared phase (busy spinners included)
    if (!decorPhase(4)) return;
    if (Math.abs(angle - lastA) < MIN_DEG && Math.abs(spread - lastSpread) < MIN_DEG && Math.abs(sc - lastSc) < 0.004) return;
    lastA = angle;
    lastSpread = spread;
    lastSc = sc;
    for (let i = 0; i < L; i++) {
      batch.set(i * 2, angle + i * spread);
      batch.set(i * 2 + 1, sc);
    }
    batch.commit();
  });
  const s = props.size * 0.72;
  const r = props.size * 0.2;
  const color = () => props.color?.() ?? accent();
  return (
    <View class="relative items-center justify-center" style={{ width: props.size, height: props.size }}>
      <For each={Array.from({ length: L })}>
        {() => <View ref={(n: NodeMirror) => nodes.push(n)} class="absolute" style={{ width: s, height: s, radius: r, bgColor: color() }} />}
      </For>
      <View class="absolute inset-0 flex-col items-center justify-center">{props.children}</View>
    </View>
  );
}

export function Trace(props: { cols: number; rows: number; level: Num; every?: number; step?: number; active?: () => boolean; dim?: string }) {
  const C = props.cols;
  const R = props.rows;
  const every = props.every ?? 4;
  const cols = props.step ?? 1; // columns pushed per scroll
  const H = R * 2; // half-row resolution
  const cellW = Math.ceil(C * 6.2); // mono text-xs advance ≈ 6.1 px
  const heights: number[] = new Array(C).fill(1);
  const dimRows = Array.from({ length: R }, () => createSignal(""));
  const hotRows = Array.from({ length: R }, () => createSignal(""));
  let t = 0;
  let lvl = 0;

  const render = () => {
    for (let y = 0; y < R; y++) {
      const rowTop = (R - y) * 2; // heights ≥ this reach into this row
      let dim = "";
      let hot = "";
      for (let x = 0; x < C; x++) {
        const h = heights[x]!;
        const prev = heights[x - 1] ?? h;
        const next = heights[x + 1] ?? h;
        if (h >= rowTop) {
          dim += ":";
          hot += " ";
        } else if (h >= rowTop - 2) {
          // crest lives in this row
          const ch = next - prev >= 2 ? "/" : prev - next >= 2 ? "\\" : h === rowTop - 1 ? "-" : "_";
          dim += " ";
          hot += ch;
        } else {
          dim += y === R - 1 && x % 4 === 0 ? "." : " ";
          hot += " ";
        }
      }
      // never "" (an empty<->non-empty flip forces a full relayout)
      dimRows[y]![1](dim.trimEnd() || " ");
      hotRows[y]![1](hot.trimEnd() || " ");
    }
  };
  render();

  onFrame(() => {
    if (props.active && !props.active()) return;
    // Offset phase: the scroll repaints the whole trace, so it must not land
    // in the same frame as the 15 Hz shapes (that stacked into late frames).
    if (!decorPhase(every, every / 2)) return;
    for (let k = 0; k < cols; k++) {
      t += every / cols / 60;
      lvl += (Math.max(0, Math.min(1, props.level())) - lvl) * 0.15;
      const noise = 0.5 + 0.5 * Math.sin(t * 7.3) * Math.sin(t * 2.1 + 1.3);
      const h = Math.round(1 + lvl * (H - 2) * (0.45 + 0.55 * noise) + Math.random() * (0.4 + lvl * 2));
      heights.shift();
      heights.push(Math.max(1, Math.min(H, h)));
    }
    render();
  });

  return (
    <View class="flex-col">
      <For each={dimRows}>
        {(row, i) => (
          <View class="h-[11] relative">
            {/* fixed w×h cells: a text swap skips layout entirely */}
            <Text class="text-xs font-bold text-[#363636] leading-[11]" style={{ width: cellW, height: 11 }}>{row[0]()}</Text>
            <View class="absolute inset-0">
              <Text class="text-xs font-bold leading-[11]" style={{ width: cellW, height: 11, textColor: accent() }}>
                {hotRows[i()]![0]()}
              </Text>
            </View>
          </View>
        )}
      </For>
    </View>
  );
}

/** A tiny square mark (the site's .mark) — Cloudflare-style grid intersection. */
export function Mark(props: { x: number; y: number }) {
  return <View class="absolute w-[7] h-[7] rounded-[2] border border-[#363636] bg-[#0a0a0a]" style={{ insetL: props.x - 3, insetT: props.y - 3 }} />;
}

/** Rolling history for sparklines, sampled when `value` changes. */
export function createHistory(n: number): { push: (v: number) => void; values: Accessor<number[]> } {
  const [values, set] = createSignal<number[]>(new Array(n).fill(0));
  return {
    push: (v: number) => set((a) => [...a.slice(1), v]),
    values,
  };
}
