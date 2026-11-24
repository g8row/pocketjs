// Headless screenshot of one deck pane with mock deckd state — no tablet needed.
//   bun apps/desk/preview/shot.ts <pane> [out.png] [--mock file.json] [--no-build] [--frames n]
// Run from the pocketjs root. Builds the app (bun pocket compile → dist/), serves hosts/web on a free
// port, renders hosts/web/deck-preview.html in headless Chromium at the tablet's 1024×600 and writes
// the PNG (default /tmp/deck-<pane>.png). Needs hosts/web/pocketjs.wasm (bun tools/wasm.ts) and chromium.
// The left 212 px (106 logical) is the rail; the pane is the rest. Panes: see app.tsx KNOWN.
import { copyFileSync, existsSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";

const ROOT = resolve(import.meta.dir, "../../..");
const args = process.argv.slice(2);
const flag = (n: string) => args.includes(n);
const opt = (n: string) => (args.includes(n) ? args[args.indexOf(n) + 1] : undefined);
const pos = args.filter((a, i) => !a.startsWith("--") && !(i > 0 && ["--mock", "--frames"].includes(args[i - 1]!)));
const pane = pos[0] ?? "board";
const out = resolve(pos[1] ?? `/tmp/deck-${pane}.png`);
const mock = resolve(opt("--mock") ?? join(import.meta.dir, "mock.json"));
const frames = Number(opt("--frames") ?? 240); // frames stepped before the shot (4 s: the pager has settled)

if (!existsSync(join(ROOT, "hosts/web/pocketjs.wasm"))) throw new Error("hosts/web/pocketjs.wasm missing: run `bun tools/wasm.ts`");
// a fresh checkout has no generated styles module yet, and the typecheck before the build needs one
const gen = join(ROOT, "framework/src/styles.generated.ts");
if (!existsSync(gen)) await Bun.write(gen, "export const STYLE_IDS: Record<string, number> = {};\n");
if (!flag("--no-build")) {
  const b = Bun.spawnSync(["bun", "pocket", "compile", "--target", "android", "--manifest", "apps/desk/pocket.json", "--project-root", "."], { cwd: ROOT, stdout: "pipe", stderr: "pipe" });
  if (b.exitCode !== 0) {
    console.error(b.stdout.toString().slice(-3000), b.stderr.toString().slice(-3000));
    process.exit(1);
  }
}
copyFileSync(mock, join(ROOT, "dist/deck-mock.json"));
rmSync(out, { force: true });
// The web host runs as its own process (serving it from this one stalled chromium).
const port = 20000 + Math.floor(Math.random() * 20000);
const server = Bun.spawn(["bun", "hosts/web/serve.ts"], { cwd: ROOT, env: { ...process.env, PORT: String(port) }, stdout: "ignore", stderr: "ignore" });
try {
  for (let i = 0; i < 50; i++) {
    if (await fetch(`http://127.0.0.1:${port}/deck-preview.html`).then((r) => r.ok, () => false)) break;
    await Bun.sleep(100);
  }
  const url = `http://127.0.0.1:${port}/deck-preview.html?demo=desk-main&width=512&height=300&scale=2&hud=0&devtools=0&frames=${frames}&pane=${encodeURIComponent(pane)}`;
  const chrome = ["chromium", "chromium-browser", "google-chrome"].find((c) => Bun.which(c));
  if (!chrome) throw new Error("chromium not found");
  const r = Bun.spawnSync([chrome, "--headless=new", "--disable-gpu", "--hide-scrollbars", "--window-size=1024,600", "--virtual-time-budget=1500", `--screenshot=${out}`, url], { stdout: "ignore", stderr: "ignore", timeout: 60_000 });
  if (r.exitCode !== 0 || !existsSync(out)) throw new Error(`chromium failed (exit ${r.exitCode}); open the URL in a browser to debug: ${url}`);
  console.log(out);
} finally {
  server.kill();
}
