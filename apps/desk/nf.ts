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
  "vol-down": "󰕿", // U+F057F
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
  "bolt": "󰉁", // U+F0241
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
} as const;

export type IconName = keyof typeof NF;
export const ICON_NAMES = Object.keys(NF) as IconName[];
/** The glyph for an icon name, or the dot for an unknown one (deck tiles come from user config). */
export const glyph = (name: string | undefined): string => (NF as Record<string, string>)[name ?? ""] ?? NF.dot;
