// g8row.xyz design tokens, as PocketJS class literals (see the site's site.css).
//   ground #070707 · bg #0a0a0a · container #141414 · container-hi #1d1d1d
//   line #222 · line-2 #363636 · mute #8a8a8a · soft #b3b3b3 · fg #ededed
//   accent #a8c7fa · accent-dim #a8c7fa1f · on-accent #0b1d33
// Type: Geist (regular slot) + Geist Mono (the "bold" slot — `font-bold` = mono
// in this app, see fonts/README). Lowercase display type, mono eyebrows.

export const T = {
  screen: "w-full h-full flex-col bg-[#070707]",
  eyebrow: "text-xs font-bold text-[#8a8a8a] tracking-wide",
  eyebrowAccent: "text-xs font-bold text-[#a8c7fa] tracking-wide",
  mono: "text-xs font-bold text-[#b3b3b3]",
  monoSm: "text-xs font-bold text-[#8a8a8a]",
  monoHi: "text-xs font-bold text-[#ededed]",
  body: "text-sm text-[#b3b3b3]",
  value: "text-lg text-[#ededed]",
  title: "text-xl text-[#ededed]",
  display: "text-4xl text-[#ededed] leading-[38]",
  displayAccent: "text-4xl text-[#a8c7fa] leading-[38]",
  // .card: gradient container, 1px border, highlight along the top edge
  card: "rounded-[18] bg-gradient-to-b from-[#161616] to-[#101010] border border-[#222222] overflow-hidden",
  panel: "rounded-[14] bg-[#1d1d1d] border border-[#222222]",
  panelOn: "rounded-[14] bg-[#1d1d1d] border border-[#a8c7fa]",
  chip: "px-2 py-[3] rounded-[999] bg-[#1d1d1d]",
  chipO: "px-2 py-[2] rounded-[999] border border-[#363636]",
  chipA: "px-2 py-[3] rounded-[999] bg-[#a8c7fa1f]",
  rule: "h-[1] w-full bg-[#222222]",
  vrule: "w-[1] h-full bg-[#222222]",
} as const;

export const W = 512;
export const H = 300;
