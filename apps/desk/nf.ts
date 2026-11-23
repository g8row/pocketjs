// Icon glyphs from the mono font (fonts/bold.otf = GeistMono Nerd Font Mono): Material Design
// Icons from Nerd Fonts, one cell wide, drawn as text in the "bold" (mono) slot and tinted with
// textColor. The literal characters below are what makes the build bake them: add a glyph here
// (not String.fromCodePoint at runtime) or it renders as tofu. Names cover the deck's existing icon
// names (mic, cup, lock, …), so deck.config.json keeps working. Codepoints were checked against the
// font on 2026-11-23 (rendered sheet in the PR).
export const NF = {
  "mic": "󰍬", // U+F036C
  "mic-off": "󰍭", // U+F036D
  "vol-up": "󰕾", // U+F057E
  "vol-down": "󰖀", // U+F0580 volume-medium: the same footprint as vol-up (volume-low, F057F, is a bare speaker the font blows up to 37×65)
  "vol-mute": "󰝟", // U+F075F
  "terminal": "󰆍", // U+F018D
  "spark": "󰛄", // U+F06C4
  "screenshot": "󰹑", // U+F0E51
  "timer": "󰔛", // U+F051B
  "lock": "󰌾", // U+F033E
  "display": "󰍹", // U+F0379
  "cup": "󰅶", // U+F0176
  "play": "󰐊", // U+F040A
  "pause": "󰏤", // U+F03E4
  "next": "󰒭", // U+F04AD
  "prev": "󰒮", // U+F04AE
  "link": "󰌷", // U+F0337
  "grid": "󰕰", // U+F0570
  "code": "󰅩", // U+F0169
  "bolt": "󱐋", // U+F140B lightning-bolt (flash, F0241, renders 33×64 and solid)
  "dot": "󰝥", // U+F0765
  "power": "󰐥", // U+F0425
  "restart": "󰜉", // U+F0709
  "android": "󰀲", // U+F0032
  "linux": "󰌽", // U+F033D
  "apple": "󰀵", // U+F0035
  "windows": "󰖳", // U+F05B3
  "wifi": "󰖩", // U+F05A9
  "wifi-off": "󰖪", // U+F05AA
  "battery": "󰁹", // U+F0079
  "battery-charging": "󰂄", // U+F0084
  "brightness": "󰃟", // U+F00DF
  "moon": "󰖔", // U+F0594
  "copy": "󰆏", // U+F018F
  "cpu": "󰻠", // U+F0EE0
  "memory": "󰍛", // U+F035B
  "tablet": "󰓶", // U+F04F6
  "usb": "󰕓", // U+F0553
  "thermometer": "󰔏", // U+F050F
  "music": "󰝚", // U+F075A
  "shuffle": "󰒝", // U+F049D
  "repeat": "󰑖", // U+F0456
  "heart": "󰋑", // U+F02D1
  "chart": "󰄨", // U+F0128
  "folder": "󰉋", // U+F024B
  "check": "󰄬", // U+F012C
  "close": "󰅖", // U+F0156
  "chevron-right": "󰅂", // U+F0142
  "refresh": "󰑐", // U+F0450
  "home": "󰋜", // U+F02DC
  "cog": "󰒓", // U+F0493
  "bell": "󰂚", // U+F009A
  "clock": "󰅐", // U+F0150
  "keyboard": "󰌌", // U+F030C
  "message": "󰍡", // U+F0361
  "app": "󰣆", // U+F08C6
  "eye": "󰈈", // U+F0208
  "sleep": "󰒲", // U+F04B2
  "flash-auto": "󰉂", // U+F0242
  "repeat-once": "󰑘", // U+F0458
  "repeat-off": "󰑗", // U+F0457
  "shuffle-off": "󰒞", // U+F049E
  "battery-alert": "󰂃", // U+F0083
  "battery-low": "󰁻", // U+F007B
  "help-circle": "󰘥", // U+F0625
  "robot": "󱙺", // U+F167A
  "arrow-left": "󰁍", // U+F004D
} as const;

export type IconName = keyof typeof NF;
export const ICON_NAMES = Object.keys(NF) as IconName[];
/** The glyph for an icon name, or the dot for an unknown one (deck tiles come from user config). */
export const glyph = (name: string | undefined): string => (NF as Record<string, string>)[name ?? ""] ?? NF.dot;

// Optical size corrections, applied by `Icon` (ui.tsx) as one text-size step down (4xl → 2xl, 2xl → xl, …).
// The mono Nerd Font scales every glyph to the cell WIDTH, so tall glyphs come out bigger than the rest.
// Measured ink box at 4xl (2× px; 2xl is the same ×0.67): most icons 43×43; the outliers are below.
// Two glyphs were swapped instead (vol-down → volume-medium, bolt → lightning-bolt): see NF above.
// Only text sizes can correct this (the core draws glyphs unscaled, so a `scale` style does nothing), and
// the baked sizes are coarse at the top (36 → 24 is ×0.67), so there are two maps. Measured 2026-11-23
// with the preview renderer (icon sheets at 4xl and 2xl, checked by eye in the deck tiles).

/** ≥ 1.5× tall (and mostly solid): one step down at every size. */
export const ICON_STEP: Partial<Record<IconName, -1>> = {
  "usb": -1, // 43×64
  "thermometer": -1, // 33×65
  "battery": -1, // 39×65
  "battery-charging": -1, // 39×65
  "battery-alert": -1, // 39×65
  "battery-low": -1, // 39×65
};
/** 1.2–1.4× tall: one step down only from 2xl or smaller (a ≤ 17 % step); at 4xl the step to 2xl
 *  would make them the smallest icons, so they stay. pause is paired with play (iconOn swaps them). */
export const ICON_STEP_FINE: Partial<Record<IconName, -1>> = {
  "mic": -1, // 43×59
  "lock": -1, // 43×57
  "play": -1, // 43×55
  "pause": -1, // 43×51
  "apple": -1, // 43×53
  "bolt": -1, // lightning-bolt, tall but light
};
/** The size step for an icon drawn at `size` (0 for unknown names: they draw the dot). */
export function iconStep(name: string | undefined, size: string): number {
  const n = name ?? "";
  return (ICON_STEP as Record<string, number>)[n] ?? (size !== "4xl" ? (ICON_STEP_FINE as Record<string, number>)[n] ?? 0 : 0);
}
