# PocketDeck UI: design brief

The deck app (this directory) is the UI of a 7" Lenovo TB-7304X running Linux, used as a desk display next to
a computer ("the host"). deckd, a daemon on the host, pushes live state and runs actions. This brief is shared by
every page; each page agent also gets a page brief.

## 1. Screen and geometry

- 512 × 300 logical px (the 1024 × 600 panel at 2×), landscape. Fixed; no other sizes.
- **The left strip (x < 106) is the rail** (`rail.tsx`): the panel is cracked with dead pixels there. It shows the
  clock, date, Claude status, battery and an ASCII sound wave on every page. **Pages never draw there.**
- The nav strip (28 px + 1 px rule) is at the top of the clean area.
- **A page is `PW × PH` = 406 × 271** (`ui.tsx`). On screen it starts at `(PANE_X, PANE_Y)` = (106, 29). Only
  components that hit-test touches themselves (Slider, a custom scroller) need screen coordinates:
  `screen x = PANE_X + x in page`, `screen y = PANE_Y + y in page`.
- Tabs, in order: BOARD · DECK · CLAUDE · USAGE · MUSIC · SETTINGS. Pages swipe horizontally (the pager owns
  horizontal drags).

## 2. The style rule (non-negotiable)

**Read-only → terminal. Touchable → rounded.** Every page has both.

| | Terminal (read-only) | Rounded (touchable) |
|---|---|---|
| Containers | `TBox`: square 1 px frame `#3a3a3a`, title cut into the top border (mono, xs, mute), optional right label/icon; `hot` = accent (or given colour) frame + title | `Btn` pill, rounded deck tiles, `Chip`, `Seg`, `Toggle`, `Slider`, `Sheet` |
| Type | mono (`font-bold` = Geist Mono) for labels, values, units; Geist (regular) only for prose and big headline numbers | Geist for button labels; mono for small notes inside |
| Data viz | `TBar` (`████░░`), `TSpark` (`▁▃▅▇`), ASCII bar charts, `KV` rows | sliders, toggles, segmented switches |
| Colour | background stays dark; accent `#a8c7fa` (`accent()`) for values/highlights; yellow `C.wait` = needs you; green `C.ok` = done/ok; rose `C.rose` = destructive/errors | filled only when primary or "on"; otherwise `C.raised` + `C.line2` outline |

- **Icons are single-colour Nerd Font glyphs** (`<Icon name="…">`, `nf.ts`), tinted like text. Never emoji, never
  multi-colour images. Album art (MUSIC) is the only picture.
- Look at the agreed mock-up: `preview/mixed-style.html` (open in a browser; the code is the spec for spacing and
  feel, not pixel-exact). Match its density: 8–10 px gaps, 7 px frame padding, xs (12 px) mono labels.
- Lowercase prose and values; UPPERCASE only for frame titles and tab labels.
- **Machine-agnostic**: never hard-code the host's OS. Name it from `desk.host.os` ("linux" | "macos" | "windows")
  with these labels: linux → "linux", macos → "mac", windows → "windows" (e.g. "LINUX CPU", "MAC CPU", "on mac").
  Icons for the OS: `linux`, `apple`, `windows`.

## 3. The kit (`ui.tsx`) and icons (`nf.ts`)

```
PW, PH, PANE_X, PANE_Y, C (tokens)
Icon      { name, size?: xs|sm|base|lg|xl|2xl|4xl, color? }
TBox      { title?, right?, rightIcon?, hot?, color?, w?, h?, grow?, bg?, pad?, children }
TBar      { value: () => 0..1, cells, size?, color? }          fixed width
TSpark    { values: () => number[], max, size?, color? }
KV        { k, v, kw?, color? }                                 mono key/value row
Btn       { label?, icon?, kind?: default|primary|warn|danger|wait|ghost, w?, h? (26 default), grow?, onPress }
Chip      { label, on?, color?, dot?, note?, onPress }
Seg       { options, value: () => string, onChange }
Toggle    { on: () => boolean, onChange }
Slider    { x, y (SCREEN coords), w, value: () => 0..1, onInput?, onChange, active }
Sheet     { open: () => boolean, color?, children }             bottom sheet over the page
```

`KitTest` in `kit-test.tsx` shows all of them (reference only; not in the app). Icon names: `nf.ts` (`ICON_NAMES`).
To use an icon that isn't there, **don't edit nf.ts**: list it (name + Material Design Icons codepoint from
https://www.nerdfonts.com/cheat-sheet, `nf-md-*`) in your report; the integrator adds it. Meanwhile use the
closest existing one.

Shared helpers you may import: `shapes.tsx` (`Morph`: the rounded-square/cookie shape, single colour; `Trace`;
`createHistory`), `clock.ts` (`decorFrame`, `decorPhase`, `DECOR_STEP`), `link.ts` (`desk`, `act`, `blobSrc`,
`linkConnected`), `theme.ts` (`accent`, `ON_ACCENT`, `TILE_HEX`, `wrap`), `pager.tsx` (`gesture`), `device.ts`
(SETTINGS only). **Don't import from the old page files** (`pages.tsx`, `views.tsx`, `deck.tsx`, `claude.tsx`):
they are deleted after the redesign. Copy what you need (e.g. the deck packing, `wrapPx`) into your page file.

## 4. Framework constraints (each one has bitten before)

- **Class strings must be full literals.** No template strings or concatenation in `class`; ternaries of whole
  literals are fine; dynamic values go in `style={{ … }}` (`width`, `height`, `bgColor`, `textColor`,
  `borderColor`, `insetL/T/R/B`, `paddingL/T/R/B`, `translateX/Y`, `scale`, `rotate`, `opacity`, `basis`, `gap`).
- **Font sizes**: only 12/14/16/18/20/24/36 (`text-xs … text-4xl`, no `text-3xl`). `font-bold` = the mono face.
- **Glyphs are baked from source literals.** Runtime text (song titles, messages) is limited to `charset.ts`
  (Latin, Cyrillic, punctuation, arrows); symbols you draw (`█ ░ ▁…▇ ┌─┐ ● ↑`) must appear as literals in your
  source. Icons: only via `nf.ts`.
- **No word wrap in the core**: pre-wrap with `wrap()` (theme.ts) or a pixel-width wrapper; clip long strings.
- **Never set a Text to `""`** (empty ↔ non-empty forces a full relayout): use `" "`. Text that changes often goes
  in a fixed `width`/`height` cell.
- **Animate paint-only properties** (translate, scale, rotate, opacity, arc sweep) in **whole pixels**; never width
  or height. Fractional positions or changing the draw-op shape repaint the whole screen.
- **`onFrame` hooks inside components**, and they must do nothing while `!props.active()` (the page is off screen).
  Ambient motion: 30 Hz at most (`decorFrame()`), slow things on `decorPhase(n)`. Budget: a frame should stay
  under ~10 ms on the tablet (4× A53, software raster).
- **Touch**: targets ≥ 26 px tall, ≥ 6 px apart. A press held > 1 s fires nothing (ghost-touch guard). Horizontal
  drags belong to the pager; a vertical scroller or a slider must claim `gesture.owner` (see `Slider`).
- Images: `<Image src={blobSrc("music.art")}>` for deckd blobs (pow2 textures, ≤ 512).

## 5. Data

`desk.<key>` is the live state from deckd (reactive store, `link.ts`); `act(id, args?)` asks deckd to run an
action. **`preview/mock.json` is the full shape** (captured from a real deckd, text invented); read it.

| Key | Used by | Notes |
|---|---|---|
| `host` **NEW** | all | `{ os, name, screen: "active" \| "locked" \| "asleep" }` |
| `sys` | BOARD | `cpu`, `mem` (%), **NEW** `cores`, `ghz`, `memUsedGb`, `memTotalGb`, `hist.{cpu,mem}.{1m,10m,1h}` (30 samples each, %) |
| `tablet` | BOARD | battery, charging, memFreeMb/TotalMb, uptime, cpuMhz, mode, **NEW** tempC, volts, currentMa |
| `claude` | CLAUDE, rail | `sessions[]` (see mock), `counts`, `alert`, `pending`, `hooks` |
| `claudeTick` | CLAUDE | per-session ticking counters |
| `usage` | USAGE | today: `output`, `input`, `cacheHit`, `messages`, `sessions`, `peak`, `lastHour`, `bars[24]` (per hour, relative), `projects[]`, `model`; **NEW** `days[7]` `{ d, out }` |
| `music` | MUSIC | `state`, `title`, `artist`, `album`, `position`, `duration` (s); **NEW** `player`, `shuffle`, `repeat` ("off" \| "all" \| "one"), `volume` (0–100); cover art blob `music.art` |
| `deck` | DECK | `tiles[]`: `id, label, color, icon, iconOn?, group?, w?, h?, shape?, sub?, on?, fill?, level?, live?` |
| `layout`, `nav`, `clock`, `focus` | shell, rail | don't use `focus` (the FOCUS page is off) |

Actions: existing `music.prev|toggle|next`, `claude.copy|permit|answer|focus`, any deck tile `id`.
**NEW** (deckd adds them later; call them now, the preview records them): `music.shuffle`, `music.repeat`,
`music.seek {pos}`, `music.volume {v}`, `sys.window {w: "1m"|"10m"|"1h"}` (optional, if BOARD wants deckd to
know). The tablet's own state and commands (SETTINGS) are in `device.ts`, not deckd.

If your page needs data that isn't listed, **mock it** (add keys in your own copy of the mock, see §7) and list the
contract in your report.

## 6. Ownership

- You edit **only** `pages/<page>.tsx` (and may add `pages/<page>-*.ts(x)` helpers and `preview/mock-<page>*.json`).
- Don't edit `app.tsx`, `ui.tsx`, `nf.ts`, `rail.tsx`, `theme.ts`, `damage.ts`, `device.ts`, `link.ts`,
  `preview/mock.json`, `DESIGN.md`. If the kit lacks something, build it locally in your page file and say in the
  report whether it should move into `ui.tsx`.
- Your page component keeps its exported name and signature: `export function <Name>Page(props: { active: () => boolean })`.

## 7. Verify with the renderer (no tablet)

```sh
bun apps/desk/preview/shot.ts <page> /tmp/<page>.png                 # build + screenshot (1024×600, rail included)
bun apps/desk/preview/shot.ts <page> /tmp/<page>-b.png --mock apps/desk/preview/mock-<page>-b.json --no-build
```

Look at every screenshot (Read the PNG). The renderer is the real PocketJS engine (WebAssembly) with the tablet's
fonts, so what you see is what the tablet shows. Check at least: the default mock, an empty/idle state, and a
long-text state; nothing clipped at 406 × 271, nothing left of x 212 in the PNG (= 106 logical), no overlaps, text
fits its cells, both touch and read areas follow §2. `bun pocket compile` must pass without errors.

## 8. Report

Commit your work in your worktree (Conventional Commits: `feat(desk): <page> page redesign`) and report:
screenshot paths (default + states), the data/action contract you need beyond §5, icons you want added, kit
additions you suggest, and open design questions for the user.
