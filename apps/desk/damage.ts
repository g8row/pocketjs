// The TB-7304X's panel damage, in screen logical units (512×300, the nav strip
// included). Mapped on 2026-11-23 from a photo of a calibration grid
// (pocketdeck tools/panel-grid.py): a cracked glass and LCD on the left fifth.
// Everything right of x 104 is clean. Layouts keep text and touch targets out
// of these rects; dark backgrounds hide the dead (black) pixels.
//
//   A  16..44 ×   0..70   crack + black wedge, top left (through the nav strip)
//   B  63..102 × 112..203  black bar + hatched pixels
//   C  54..80  × 192..300  diagonal dark streak to the bottom edge
//   D  28..88  × 254..300  dead-pixel blob
//   E  76..81  ×  56..110, 99..104 × 55..73   thin dead lines

export interface Rect {
  x0: number;
  y0: number;
  x1: number;
  y1: number;
}

export const ZONES: Rect[] = [
  { x0: 16, y0: 0, x1: 44, y1: 70 },
  { x0: 63, y0: 112, x1: 102, y1: 203 },
  { x0: 54, y0: 192, x1: 80, y1: 300 },
  { x0: 28, y0: 254, x1: 88, y1: 300 },
  { x0: 76, y0: 56, x1: 81, y1: 110 },
  { x0: 99, y0: 55, x1: 104, y1: 73 },
];

/** Screen y where the panes start (the 28 px nav strip + its rule). */
export const PANE_TOP = 29;
/** First clean x for the nav strip and anything in a pane's top band (screen y < 55). */
export const NAV_X = 48;
/** First clean x for the middle band (screen y 55..254). */
export const SAFE_X = 106;
/** First clean x for the bottom band (screen y ≥ 254). */
export const BOTTOM_X = 92;
