// Generates the deck's icon set: `bun apps/desk/icons/gen.ts`.
//
// The pak's SVG baker (framework/compiler/bake-svg.ts) only fills shapes — no
// strokes, arcs or transforms — and images can't be tinted at runtime. So the
// icons are drawn here as 2 px "strokes" on a 24-unit grid and expanded into
// filled geometry: each segment a quad, each joint/cap a circle, arcs a ring
// sector, outlined boxes an even-odd pair. Overlaps are fine: the baker paints
// opaque shapes in order. Every icon is written twice — light (on dark tiles)
// and ink (on filled tiles) — and icons.ts maps names to the literal file
// names, which is what makes the build bake them.

import { writeFileSync } from "node:fs";
import { join } from "node:path";

type P = [number, number];
const f = (n: number) => +n.toFixed(3);
const SW = 2.1; // stroke width in grid units

const circle = (cx: number, cy: number, r: number) =>
  `<circle cx="${f(cx)}" cy="${f(cy)}" r="${f(r)}" fill="C"/>`;
const poly = (pts: P[]) => `M${pts.map(([x, y]) => `${f(x)} ${f(y)}`).join("L")}Z`;
const path = (d: string, evenOdd = false) => `<path d="${d}" fill="C"${evenOdd ? ' fill-rule="evenodd"' : ""}/>`;

/** A round-capped segment. */
function seg(a: P, b: P, w = SW): string {
  const [dx, dy] = [b[0] - a[0], b[1] - a[1]];
  const len = Math.hypot(dx, dy) || 1;
  const [nx, ny] = [(-dy / len) * (w / 2), (dx / len) * (w / 2)];
  return (
    path(poly([[a[0] + nx, a[1] + ny], [b[0] + nx, b[1] + ny], [b[0] - nx, b[1] - ny], [a[0] - nx, a[1] - ny]])) +
    circle(a[0], a[1], w / 2) +
    circle(b[0], b[1], w / 2)
  );
}
const line = (pts: P[], w = SW) => pts.slice(1).map((p, i) => seg(pts[i]!, p, w)).join("");

/** Stroked arc, degrees clockwise from +x (SVG y-down), with round caps. */
function arc(cx: number, cy: number, r: number, a0: number, a1: number, w = SW): string {
  const n = Math.max(6, Math.ceil(Math.abs(a1 - a0) / 8));
  const at = (rr: number, a: number): P => [cx + rr * Math.cos((a * Math.PI) / 180), cy + rr * Math.sin((a * Math.PI) / 180)];
  const outer: P[] = [];
  const inner: P[] = [];
  for (let i = 0; i <= n; i++) {
    const a = a0 + ((a1 - a0) * i) / n;
    outer.push(at(r + w / 2, a));
    inner.unshift(at(r - w / 2, a));
  }
  const [s, e] = [at(r, a0), at(r, a1)];
  return path(poly([...outer, ...inner])) + circle(s[0], s[1], w / 2) + circle(e[0], e[1], w / 2);
}

/** Rounded-rect polygon (corners sampled). */
function rrectPts(x: number, y: number, w: number, h: number, r: number): P[] {
  r = Math.max(0, Math.min(r, w / 2, h / 2));
  const pts: P[] = [];
  const corner = (cx: number, cy: number, a0: number) => {
    for (let i = 0; i <= 6; i++) {
      const a = ((a0 + (90 * i) / 6) * Math.PI) / 180;
      pts.push([cx + r * Math.cos(a), cy + r * Math.sin(a)]);
    }
  };
  corner(x + w - r, y + r, -90);
  corner(x + w - r, y + h - r, 0);
  corner(x + r, y + h - r, 90);
  corner(x + r, y + r, 180);
  return pts;
}
const rrect = (x: number, y: number, w: number, h: number, r: number) => path(poly(rrectPts(x, y, w, h, r)));
/** Outlined rounded rect: outer minus inner, even-odd. */
const rrectStroke = (x: number, y: number, w: number, h: number, r: number, sw = SW) =>
  path(poly(rrectPts(x - sw / 2, y - sw / 2, w + sw, h + sw, r + sw / 2)) + poly(rrectPts(x + sw / 2, y + sw / 2, w - sw, h - sw, Math.max(0, r - sw / 2))), true);
const ring = (cx: number, cy: number, r: number, sw = SW) => arc(cx, cy, r, 0, 359.9, sw);

const speaker = path(poly([[3, 9.3], [6.6, 9.3], [11.6, 5.2], [11.6, 18.8], [6.6, 14.7], [3, 14.7]]));

const ICONS: Record<string, string> = {
  mic: rrectStroke(9, 2.8, 6, 11.4, 3) + arc(12, 11, 7, 0, 180) + seg([12, 18], [12, 21.2]),
  "mic-off": rrectStroke(9, 2.8, 6, 11.4, 3) + arc(12, 11, 7, 0, 180) + seg([12, 18], [12, 21.2]) + seg([3.5, 3.5], [20.5, 20.5]),
  "vol-up": speaker + arc(15, 12, 3.2, -55, 55) + arc(15, 12, 6.4, -55, 55),
  "vol-down": speaker + arc(15, 12, 3.2, -55, 55),
  terminal: rrectStroke(2.8, 4, 18.4, 16, 3.5) + line([[7, 9.4], [10, 12], [7, 14.6]]) + seg([12.6, 15], [17, 15]),
  spark: seg([12, 2.6], [12, 21.4]) + seg([2.6, 12], [21.4, 12]) + seg([5.4, 5.4], [18.6, 18.6]) + seg([18.6, 5.4], [5.4, 18.6]),
  screenshot:
    line([[3.6, 8], [3.6, 3.6], [8, 3.6]]) +
    line([[16, 3.6], [20.4, 3.6], [20.4, 8]]) +
    line([[20.4, 16], [20.4, 20.4], [16, 20.4]]) +
    line([[8, 20.4], [3.6, 20.4], [3.6, 16]]) +
    ring(12, 12, 3.2),
  timer: ring(12, 13.2, 7.8) + line([[12, 9.2], [12, 13.2], [14.6, 15.4]]) + seg([9.6, 2.6], [14.4, 2.6]),
  lock: rrect(4.2, 10.4, 15.6, 11, 3) + arc(12, 7.6, 3.9, 180, 360) + seg([8.1, 7.6], [8.1, 10.6]) + seg([15.9, 7.6], [15.9, 10.6]),
  display: rrectStroke(2.8, 4, 18.4, 12.6, 2.4) + seg([9, 20.8], [15, 20.8]) + seg([12, 17], [12, 20.6]),
  cup:
    path(poly([[3.6, 9], [16.4, 9], ...Array.from({ length: 9 }, (_, i): P => {
      const a = (i / 8) * Math.PI;
      return [10 + 6.4 * Math.cos(a), 14.6 + 6.4 * Math.sin(a)];
    }), [3.6, 9]])) +
    arc(17, 13.4, 2.6, -90, 90) +
    seg([8, 2.8], [8, 5.6], 1.8) + // steam
    seg([12, 2.8], [12, 5.6], 1.8),
  play: path(poly([[7, 4.5], [19.5, 12], [7, 19.5]])),
  pause: rrect(6, 5, 4, 14, 1.2) + rrect(14, 5, 4, 14, 1.2),
  next: path(poly([[6, 5], [16, 12], [6, 19]])) + rrect(16.5, 5, 2.5, 14, 1),
  prev: path(poly([[18, 5], [8, 12], [18, 19]])) + rrect(5, 5, 2.5, 14, 1),
  link: seg([6.5, 17.5], [17.5, 6.5]) + line([[9.5, 6.5], [17.5, 6.5], [17.5, 14.5]]),
  grid: rrect(3.5, 3.5, 7.5, 7.5, 2) + rrect(13, 3.5, 7.5, 7.5, 2) + rrect(3.5, 13, 7.5, 7.5, 2) + rrect(13, 13, 7.5, 7.5, 3.75),
  code: line([[8, 6], [3, 12], [8, 18]]) + line([[16, 6], [21, 12], [16, 18]]) + seg([13.5, 5], [10.5, 19]),
  bolt: path(poly([[13.5, 2.5], [5, 13.5], [11.5, 13.5], [10.5, 21.5], [19, 10.5], [12.5, 10.5]])),
  dot: circle(12, 12, 5),
};

// moon outline omitted on purpose (no do-not-disturb tile); add here if needed.

const COLORS = { l: "#ededed", d: "#101010" } as const;
// logical px; baked at the target's density. The pak wants pow2 textures, so
// the large icon is a 48 px drawing centred on a 64 px canvas.
const SIZES = [32, 48] as const;
const CANVAS: Record<number, [number, string]> = { 32: [32, "0 0 24 24"], 48: [64, "-4 -4 32 32"] };
// Large variants cost 4× a small one in the pak (it is pushed to the tablet on
// every change), so only icons likely to sit in a big circle get one; the rest
// fall back to the small icon there.
const LARGE = new Set(["mic", "mic-off", "cup", "timer", "lock", "spark"]);

const dir = import.meta.dir;
const names: string[] = [];
for (const [name, body] of Object.entries(ICONS)) {
  for (const size of SIZES) {
    if (size === 48 && !LARGE.has(name)) continue;
    for (const [tone, hex] of Object.entries(COLORS)) {
      const [px, vb] = CANVAS[size]!;
      const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${px}" height="${px}" viewBox="${vb}">${body.replaceAll('fill="C"', `fill="${hex}"`)}</svg>\n`;
      writeFileSync(join(dir, `${name}-${size}${tone}.svg`), svg);
    }
  }
  names.push(name);
}

// The literal names must appear in source for the build to bake them.
const entry = (n: string) =>
  `  ${JSON.stringify(n)}: { s: ["icons/${n}-32l.svg", "icons/${n}-32d.svg"]${LARGE.has(n) ? `, l: ["icons/${n}-48l.svg", "icons/${n}-48d.svg"]` : ""} },`;
writeFileSync(
  join(dir, "..", "icons.ts"),
  `// Generated by icons/gen.ts — edit that, not this.\n` +
    `// name → { s: 32 px [light, ink], l: 48 px drawing on a 64 px canvas [light, ink] }\n` +
    `export const ICON_FILES: Record<string, { s: [string, string]; l?: [string, string] }> = {\n${names.map(entry).join("\n")}\n};\n` +
    `export const ICON_NAMES = ${JSON.stringify(names)};\n`,
);
console.log(`wrote ${names.length} icons (${LARGE.size} also large) × 2 tones`);
