// g8row.xyz design tokens, as PocketJS class literals.
//   ground #070707 · bg #0a0a0a · container #141414 · container-hi #1d1d1d
//   line #222 · line-2 #363636 · mute #8a8a8a · soft #b3b3b3 · fg #ededed
//   accent #a8c7fa · accent-dim rgba(168,199,250,.12) → #a8c7fa1f · on-accent #0b1d33
// Type: Geist (regular slot) + Geist Mono (the "bold" slot — `font-bold` = mono
// in this app, see fonts/README). Eyebrows: mono, uppercase, tracked, muted.

export const T = {
  screen: "w-full h-full flex-col bg-[#070707]",
  eyebrow: "text-xs font-bold text-[#8a8a8a] tracking-wide",
  eyebrowAccent: "text-xs font-bold text-[#a8c7fa] tracking-wide",
  mono: "text-xs font-bold text-[#b3b3b3]",
  monoSm: "text-xs font-bold text-[#8a8a8a]",
  body: "text-sm text-[#b3b3b3]",
  title: "text-xl text-[#ededed]",
  hero: "text-4xl text-[#ffffff]",
  card: "rounded-[18] bg-[#141414] border-[#222222] border p-3",
  cardHi: "rounded-[18] bg-[#1d1d1d] border-[#363636] border p-3",
  rule: "h-[1] w-full bg-[#222222]",
} as const;

export const W = 512;
export const H = 300;
