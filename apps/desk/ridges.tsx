// The g8row.xyz hero "signal": an ASCII ridge-line field of moving sine waves,
// ported from site.js (same envelope, three sines per ridge, nearest ridge
// occludes the ones behind, slopes drawn as / and \, hot peaks in accent).
// Each row is two mono Text nodes (dim layer + accent layer) so one row can
// carry two colors.
//
// Perf (MT6737M @ 858 MHz, QuickJS): the naive port cost ~9 ms of JS per
// render plus a relayout per changed row. Now: the per-column envelope and
// sin/cos(u·k) are precomputed, each ridge's time phase is folded in with the
// angle-addition identity (3 sin + 3 cos per ridge instead of per cell), the
// grids are reused byte buffers, and every row is a fixed w×h text cell that
// is never set to "" — so a text swap skips layout entirely.

import { createSignal, For } from "solid-js";
import { Text, View } from "@pocketjs/framework/components";
import { onFrame } from "@pocketjs/framework/lifecycle";
import { accent } from "./theme.ts";
import { DECOR_STEP, decorFrame, decorPhase } from "./clock.ts";

const SP = 32;
const DOT = 46; // .
const DASH = 45; // -
const SLASH = 47; // /
const BSLASH = 92; // \
const CH: string[] = [];
for (let c = 0; c < 128; c++) CH[c] = String.fromCharCode(c);

export function Ridges(props: { cols: number; rows: number; ridges?: number; every?: number; active?: () => boolean }) {
  const C = props.cols;
  const R = props.rows;
  const L = props.ridges ?? 14;
  const every = props.every ?? 1;
  const rowsDim = Array.from({ length: R }, () => createSignal(" "));
  const rowsHot = Array.from({ length: R }, () => createSignal(" "));
  const cellW = Math.ceil(C * 6.2); // mono text-xs advance ≈ 6.1 px

  // ---- static per-column tables --------------------------------------------
  const K = [5.2, 11.7, 23];
  const env = new Float64Array(C);
  const sinK = K.map(() => new Float64Array(C));
  const cosK = K.map(() => new Float64Array(C));
  for (let x = 0; x < C; x++) {
    const u = (x / (C - 1)) * 2 - 1;
    env[x] = Math.exp(-u * u * 2.6);
    for (let k = 0; k < 3; k++) {
      sinK[k]![x] = Math.sin(u * K[k]!);
      cosK[k]![x] = Math.cos(u * K[k]!);
    }
  }
  // dotted ground grid, like the site's background
  const ground = new Uint8Array(R * C).fill(SP);
  for (let y = 1; y < R; y += 4) for (let x = 2; x < C; x += 6) ground[y * C + x] = DOT;

  // ---- reused buffers --------------------------------------------------------
  const dim = new Uint8Array(R * C);
  const hot = new Uint8Array(R * C);
  const top = new Int32Array(C);
  const next = new Int32Array(C);
  const ys = new Int32Array(C);
  const hs = new Float64Array(C);
  const ok = new Uint8Array(C);
  const s1 = (s1a: number, c1a: number, k: number, x: number) => sinK[k]![x]! * c1a + cosK[k]![x]! * s1a;

  const rowString = (buf: Uint8Array, y: number): string => {
    const o = y * C;
    let last = C - 1;
    while (last >= 0 && buf[o + last] === SP) last--;
    if (last < 0) return " ";
    let s = "";
    for (let x = 0; x <= last; x++) s += CH[buf[o + x]!]!;
    return s;
  };

  const render = (t: number) => {
    dim.set(ground);
    hot.fill(SP);
    top.fill(R);
    for (let i = L - 1; i >= 0; i--) {
      const depth = i / (L - 1);
      const base = R * 0.42 + i * (R * 0.04);
      const amp = R * (0.16 + depth * 0.28);
      // sin(u·k + φ) = sin(u·k)cos φ + cos(u·k)sin φ
      const p1 = t * 0.9 + i * 0.45;
      const p2 = -t * 1.4 + i * 0.8;
      const p3 = t * 2.1 + i * 1.7;
      const sa = Math.sin(p1), ca = Math.cos(p1);
      const sb = Math.sin(p2), cb = Math.cos(p2);
      const sc = Math.sin(p3), cc = Math.cos(p3);
      for (let x = 0; x < C; x++) {
        const e = env[x]!;
        ok[x] = e > 0.14 ? 1 : 0;
        const h = e * (0.55 * s1(sa, ca, 0, x) + 0.3 * s1(sb, cb, 1, x) + 0.15 * s1(sc, cc, 2, x));
        hs[x] = h;
        ys[x] = Math.round(base - Math.max(h, -0.2) * amp);
      }
      next.set(top);
      for (let x = 0; x < C; x++) {
        if (!ok[x]) continue;
        const y = ys[x]!;
        if (y < 0 || y >= R || y >= top[x]!) continue; // occluded by a nearer ridge
        const prev = x > 0 && ok[x - 1] ? ys[x - 1]! : y;
        const after = x < C - 1 ? ys[x + 1]! : y;
        const dy = after - prev;
        const ch = dy <= -2 ? SLASH : dy >= 2 ? BSLASH : depth < 0.45 ? DOT : DASH;
        if (hs[x]! > 0.42 && depth > 0.3) hot[y * C + x] = ch;
        else dim[y * C + x] = ch;
        // clear the dot grid below this ridge column, so ridges read as solid
        const lim = Math.min(top[x]!, R);
        for (let yy = y + 1; yy < lim; yy++) if (dim[yy * C + x] === DOT) dim[yy * C + x] = SP;
        next[x] = y;
      }
      for (let x = 0; x < C; x++) if (next[x]! < top[x]!) top[x] = next[x]!;
    }
    // Never set "" — an empty<->non-empty flip is a structural (full) relayout.
    for (let y = 0; y < R; y++) {
      pendDim[y] = rowString(dim, y);
      pendHot[y] = rowString(hot, y);
    }
    flushed = 0;
  };
  // A render's rows are pushed over the next two decor steps (half each), so
  // the compute, the text swaps and the repaint never land on one frame, and
  // the field posts at most twice per render (each posted frame costs the
  // Android host ~5 ms however small — see clock.ts).
  const pendDim: string[] = new Array(R).fill(" ");
  const pendHot: string[] = new Array(R).fill(" ");
  let flushed = R;
  const perFrame = Math.ceil(R / 2);
  const flush = (n: number) => {
    const end = Math.min(R, flushed + n);
    for (let y = flushed; y < end; y++) {
      rowsDim[y]![1](pendDim[y]!);
      rowsHot[y]![1](pendHot[y]!);
    }
    flushed = end;
  };

  render(2.4);
  flush(R);
  let t = 2.4;
  onFrame(() => {
    if (props.active && !props.active()) return; // off-screen: no work at all
    if (!decorFrame()) return; // shared 30 Hz step (see clock.ts)
    t += DECOR_STEP / 60;
    if (decorPhase(every)) render(t);
    else if (flushed < R) flush(perFrame);
  });

  return (
    <View class="flex-col">
      <For each={rowsDim}>
        {(row, i) => (
          <View class="h-[10] relative">
            {/* fixed w×h text cells: a text swap then skips relayout entirely */}
            <Text class="text-xs font-bold text-[#3a3a3a] leading-[10]" style={{ width: cellW, height: 10 }}>{row[0]()}</Text>
            <View class="absolute inset-0">
              <Text class="text-xs font-bold leading-[10]" style={{ width: cellW, height: 10, textColor: accent() }}>{rowsHot[i()]![0]()}</Text>
            </View>
          </View>
        )}
      </For>
    </View>
  );
}
