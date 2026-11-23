// CLAUDE page helpers shared by the page (claude.tsx) and the app-wide layers (claude-layers.tsx):
// pixel-accurate text measuring + word wrap, session selection, small formatters.

import { createSignal } from "solid-js";
import { desk } from "../link.ts";

// ---- text measuring ---------------------------------------------------------------------
// The core has no word wrap, so text is wrapped here. The font baker stores each glyph's advance as
// round(advanceWidth * px / unitsPerEm) logical px (framework/compiler/bake-font.ts) and the core adds
// them up without kerning, so summing these tables gives the exact width the tablet draws.
// Tables: Geist Regular (fonts/regular.ttf) advances for ASCII 32..126 per text size, generated with
// opentype.js. Geist Mono (the "bold" slot) is a fixed 0.6 em: 7 px at 12, 8 px at 14.

const GEIST: Record<number, number[]> = {
  12: [3,3,4,6,8,10,7,2,3,3,5,7,2,5,2,6,8,5,7,7,7,8,7,6,7,7,4,4,7,6,7,7,11,8,8,8,8,7,7,8,9,3,7,8,7,11,9,9,8,9,8,8,7,8,8,11,7,7,7,4,5,4,5,7,3,7,7,7,7,7,5,7,7,3,3,7,3,11,7,7,7,7,5,6,5,7,6,10,7,6,6,5,3,5,6],
  14: [4,3,5,7,9,11,9,2,4,4,6,8,3,6,3,7,9,5,9,9,9,9,8,7,8,8,4,4,8,8,8,8,13,9,10,10,10,8,8,10,10,4,8,9,8,12,10,10,9,10,9,9,8,10,9,13,8,8,8,5,6,5,6,8,3,8,8,8,8,8,6,8,8,3,4,8,4,12,8,8,8,8,5,7,5,8,8,11,8,8,8,5,4,5,7],
  16: [4,3,6,8,10,13,10,3,4,4,7,9,3,7,3,8,11,6,10,10,10,10,9,8,10,9,5,5,9,9,9,9,14,11,11,11,11,10,9,11,11,4,10,10,9,14,12,12,10,12,11,10,9,11,11,15,10,9,9,6,7,6,7,9,4,9,10,9,10,9,6,10,9,4,4,9,4,14,9,9,10,10,6,8,6,9,9,13,9,9,9,6,4,6,8],
};
// a few non-ASCII glyphs that show up in replies (per size: 12, 14, 16)
const EXTRA: Record<string, [number, number, number]> = {
  "…": [7, 8, 9], "›": [4, 5, 5], "→": [10, 11, 13], "↓": [9, 10, 11], "—": [11, 13, 15], "–": [7, 8, 9],
  "’": [2, 3, 3], "‘": [2, 3, 3], "“": [4, 5, 6], "”": [4, 5, 6], "•": [4, 4, 5], "·": [2, 3, 3],
};

/** Advance of one character in logical px. */
function adv(ch: string, size: number, mono: boolean): number {
  if (mono) return Math.round(size * 0.6);
  const code = ch.charCodeAt(0);
  const t = GEIST[size];
  if (t && code >= 32 && code < 127) return t[code - 32]!;
  const e = EXTRA[ch];
  if (e) return size <= 12 ? e[0] : size <= 14 ? e[1] : e[2];
  if (t) return Math.round(size * 0.62); // Latin-1 / Cyrillic: close to the caps
  return Math.round(size * 0.58);
}

/** Width of a string in logical px (Geist, or Geist Mono with `mono`). */
export function textW(s: string, size: number, mono = false): number {
  let w = 0;
  for (const ch of s) w += adv(ch, size, mono);
  return w;
}

/** One line, clipped to `px` with "…". */
export function fit(s: unknown, px: number, size: number, mono = false): string {
  const str = typeof s === "string" ? s.replace(/\s+/g, " ").trim() : "";
  if (!str) return " ";
  if (textW(str, size, mono) <= px) return str;
  const ell = adv("…", size, mono);
  let w = 0;
  let n = 0;
  for (const ch of str) {
    const a = adv(ch, size, mono);
    if (w + a + ell > px) break;
    w += a;
    n += ch.length;
  }
  return `${str.slice(0, n).trimEnd()}…`;
}

/** Word-wrap `text` into lines at most `px` wide. Keeps one blank line between paragraphs, indents
 *  a bullet's continuation lines, hard-cuts over-long words (paths, URLs). At most `max` lines; a
 *  cut-off text ends with "…". */
export function wrapPx(text: unknown, px: number, size: number, opts: { mono?: boolean; max?: number } = {}): string[] {
  const src = typeof text === "string" ? text : "";
  const mono = !!opts.mono;
  const max = opts.max ?? 200;
  const out: string[] = [];
  let cut = false;
  const push = (l: string) => {
    if (out.length >= max) cut = true;
    else out.push(l);
  };
  for (const raw of src.replace(/\t/g, "  ").split("\n")) {
    if (out.length >= max) {
      if (raw.trim()) cut = true;
      continue;
    }
    if (!raw.trim()) {
      if (out.length && out[out.length - 1] !== "") out.push("");
      continue;
    }
    const m = /^(\s*)([-*•]|\d+[.)])\s+/.exec(raw);
    const lead = m ? m[1]!.length : (/^\s*/.exec(raw)?.[0].length ?? 0);
    const indent = " ".repeat(Math.min(6, lead + (m ? (m[2] === "-" || m[2] === "*" ? 2 : m[2]!.length + 1) : 0)));
    const para = m ? `${m[1]}${m[2] === "-" || m[2] === "*" ? "•" : m[2]} ${raw.slice(m[0].length)}` : raw.trimEnd();
    let line = "";
    for (const word of para.trimStart().split(/ +/)) {
      if (!word) continue;
      const next = line ? `${line} ${word}` : " ".repeat(Math.min(6, lead)) + word;
      if (textW(next, size, mono) <= px) {
        line = next;
        continue;
      }
      if (line) push(line);
      line = indent + word;
      while (textW(line, size, mono) > px && line.length > indent.length + 1) {
        let k = line.length - 1;
        while (k > indent.length + 1 && textW(line.slice(0, k), size, mono) > px) k--;
        push(line.slice(0, k));
        line = indent + line.slice(k);
      }
    }
    if (line) push(line);
  }
  while (out.length && out[out.length - 1] === "") out.pop();
  if (cut && out.length) out[out.length - 1] = fit(`${out[out.length - 1]} …`, px, size, mono);
  return out;
}

// ---- selection ----------------------------------------------------------------------------

const [selected, setSelected] = createSignal("");
const [shown, setShown] = createSignal("");
/** The session a chip tap (or the toast) picked. */
export { selected, setSelected };
/** The session the CLAUDE page currently shows (the toast stays quiet for it). */
export { shown, setShown };

// ---- small formatters -----------------------------------------------------------------------

export const lower = (s: unknown): string => (typeof s === "string" ? s.toLowerCase() : "");
/** The host's OS name for prose ("on linux"); never "mac". */
export const hostOs = (): string => lower(desk.host?.os) || "the host";

/** Seconds left on a request held by deckd's gate, and the full length (the first value seen). */
export function createCountdown(sid: () => string, held: () => any) {
  let firstId = "";
  let first = 1;
  const left = (): number => {
    const t = desk.claudeTick?.held?.[sid()];
    return Math.max(0, Math.round(typeof t === "number" ? t : held()?.left ?? 0));
  };
  const frac = (): number => {
    const id = held()?.id ?? "";
    if (id !== firstId) {
      firstId = id;
      first = Math.max(1, left());
    }
    return Math.min(1, left() / Math.max(first, left(), 1));
  };
  return { left, frac };
}
