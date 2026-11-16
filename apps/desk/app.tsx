// Desk — the TB-7304X desk companion. A dashboard fed by deskd on the Mac over
// the USB link: clock + Mac stats, a deck of action tiles, Now Playing, and
// Claude Code session status. 512×300 logical = the 1024×600 panel at 2x.

import { For, Show, createMemo } from "solid-js";
import { Image, Text, View } from "@pocketjs/framework/components";
import { act, blobSrc, desk, linkConnected, useLink } from "./link.ts";
import { CHARSET } from "./charset.ts";

// Glyph coverage for text that only arrives at runtime (song titles, Claude
// messages): the build bakes every codepoint it sees in source literals.
void CHARSET;

const clip = (s: unknown, n: number): string => {
  const str = typeof s === "string" ? s : "";
  return str.length > n ? `${str.slice(0, n - 1)}…` : str;
};

const pad2 = (n: number) => (n < 10 ? `0${n}` : `${n}`);

// Full class literals per tile color (dynamic classes must be literals).
const TILE: Record<string, string> = {
  blue: "flex-1 h-full flex-col rounded-xl bg-blue-600 active:bg-blue-800 focus:bg-blue-500 items-center justify-center p-1",
  violet: "flex-1 h-full flex-col rounded-xl bg-violet-600 active:bg-violet-800 focus:bg-violet-500 items-center justify-center p-1",
  emerald: "flex-1 h-full flex-col rounded-xl bg-emerald-600 active:bg-emerald-800 focus:bg-emerald-500 items-center justify-center p-1",
  amber: "flex-1 h-full flex-col rounded-xl bg-amber-600 active:bg-amber-800 focus:bg-amber-500 items-center justify-center p-1",
  rose: "flex-1 h-full flex-col rounded-xl bg-rose-600 active:bg-rose-800 focus:bg-rose-500 items-center justify-center p-1",
  zinc: "flex-1 h-full flex-col rounded-xl bg-zinc-700 active:bg-zinc-900 focus:bg-zinc-600 items-center justify-center p-1",
};

interface Tile {
  id: string;
  label: string;
  sub?: string;
  color?: string;
}

function Header() {
  const clock = () => desk.clock ?? {};
  const sys = () => desk.sys ?? {};
  return (
    <View class="flex-row items-center justify-between h-9 px-1">
      <View class="flex-row items-end gap-2">
        <Text class="text-2xl text-white font-bold">
          {clock().h !== undefined ? `${pad2(clock().h)}:${pad2(clock().m)}` : "--:--"}
        </Text>
        <Text class="text-xs text-zinc-400">{clip(clock().date, 24)}</Text>
      </View>
      <View class="flex-row items-center gap-3">
        <Stat label="CPU" value={sys().cpu !== undefined ? `${sys().cpu}%` : "–"} hot={(sys().cpu ?? 0) > 80} />
        <Stat label="RAM" value={sys().mem !== undefined ? `${sys().mem}%` : "–"} hot={(sys().mem ?? 0) > 85} />
        <View class="flex-row items-center gap-1">
          <View class={linkConnected() ? "w-2 h-2 rounded-full bg-emerald-400" : "w-2 h-2 rounded-full bg-rose-500"} />
          <Text class="text-xs text-zinc-400">{linkConnected() ? "Mac" : "offline"}</Text>
        </View>
      </View>
    </View>
  );
}

function Stat(props: { label: string; value: string; hot: boolean }) {
  return (
    <View class="flex-row items-end gap-1">
      <Text class="text-xs text-zinc-500">{props.label}</Text>
      <Text class={props.hot ? "text-sm text-rose-400 font-bold" : "text-sm text-zinc-100 font-bold"}>
        {props.value}
      </Text>
    </View>
  );
}

function Deck() {
  const tiles = createMemo<Tile[]>(() => (desk.deck?.tiles ?? []).slice(0, 6));
  const row = (i: number) => tiles().slice(i * 3, i * 3 + 3);
  return (
    <View class="flex-col gap-2 grow h-full">
      <For each={[0, 1]}>
        {(r) => (
          <View class="flex-row gap-2 flex-1">
            <For each={row(r)}>
              {(t) => (
                <View class={TILE[t.color ?? "zinc"] ?? TILE.zinc} style={{ basis: 0 }} focusable onPress={() => act(t.id)}>
                  <Text class="text-sm text-white font-bold">{clip(t.label, 14)}</Text>
                  <Show when={t.sub}>
                    <Text class="text-xs text-white opacity-70">{clip(t.sub, 16)}</Text>
                  </Show>
                </View>
              )}
            </For>
          </View>
        )}
      </For>
      <Show when={tiles().length === 0}>
        <Text class="text-sm text-zinc-500">Waiting for deskd…</Text>
      </Show>
    </View>
  );
}

function NowPlaying() {
  const m = () => desk.music ?? {};
  const playing = () => m().state === "playing";
  const art = () => blobSrc("music.art");
  const progress = () => (m().duration > 0 ? Math.min(1, (m().position ?? 0) / m().duration) : 0);
  return (
    <View class="w-44 h-full rounded-xl bg-zinc-800 p-2 flex-col justify-between">
      <View class="flex-row gap-2 items-center">
        <Show
          when={art() !== ""}
          fallback={<View class="w-12 h-12 rounded-lg bg-zinc-700 items-center justify-center"><Text class="text-lg text-zinc-500">♪</Text></View>}
        >
          <Image class="w-12 h-12 rounded-lg" src={art()} />
        </Show>
        <View class="flex-col flex-1">
          <Text class="text-sm text-white font-bold">{clip(m().title || "Nothing playing", 18)}</Text>
          <Text class="text-xs text-zinc-400">{clip(m().artist, 22)}</Text>
        </View>
      </View>
      <View class="h-1 w-full rounded-sm bg-zinc-700">
        <View class="h-1 rounded-sm bg-rose-500" style={{ width: Math.round(160 * progress()) }} />
      </View>
      <View class="flex-row justify-between">
        <View class="w-12 h-8 rounded-lg bg-zinc-700 active:bg-zinc-600 items-center justify-center" focusable onPress={() => act("music.prev")}>
          <Text class="text-sm text-white font-bold">◀◀</Text>
        </View>
        <View class="w-12 h-8 rounded-lg bg-rose-600 active:bg-rose-800 items-center justify-center" focusable onPress={() => act("music.toggle")}>
          <Text class="text-sm text-white font-bold">{playing() ? "| |" : "▶"}</Text>
        </View>
        <View class="w-12 h-8 rounded-lg bg-zinc-700 active:bg-zinc-600 items-center justify-center" focusable onPress={() => act("music.next")}>
          <Text class="text-sm text-white font-bold">▶▶</Text>
        </View>
      </View>
    </View>
  );
}

interface Session {
  id: string;
  name: string;
  state: "working" | "waiting" | "done" | "idle";
  detail?: string;
  ago?: string;
}

const PILL: Record<string, string> = {
  working: "px-2 rounded-md bg-blue-600",
  waiting: "px-2 rounded-md bg-amber-500",
  done: "px-2 rounded-md bg-emerald-600",
  idle: "px-2 rounded-md bg-zinc-600",
};
const PILL_TEXT: Record<string, string> = {
  working: "working",
  waiting: "needs you",
  done: "done",
  idle: "idle",
};

function Claude() {
  const sessions = createMemo<Session[]>(() => (desk.claude?.sessions ?? []).slice(0, 3));
  return (
    <View class="flex-col gap-1 h-20">
      <View class="flex-row items-center justify-between px-1">
        <Text class="text-xs text-zinc-400 font-bold">CLAUDE CODE</Text>
        <Text class="text-xs text-zinc-500">
          {desk.claude?.hooks === false ? "hooks not installed" : `${desk.claude?.sessions?.length ?? 0} sessions`}
        </Text>
      </View>
      <View class="flex-row gap-2 flex-1">
        <For each={sessions()} fallback={<Text class="text-sm text-zinc-600 px-1">No active sessions</Text>}>
          {(s) => (
            <View class="flex-1 h-full rounded-xl bg-zinc-800 p-2 flex-col justify-between">
              <View class="flex-row items-center justify-between">
                <Text class="text-xs text-white font-bold">{clip(s.name, 16)}</Text>
                <View class={PILL[s.state] ?? PILL.idle}>
                  <Text class="text-xs text-white">{PILL_TEXT[s.state] ?? s.state}</Text>
                </View>
              </View>
              <Text class="text-xs text-zinc-400">{clip(s.detail, 30)}</Text>
              <Text class="text-xs text-zinc-600">{s.ago ?? ""}</Text>
            </View>
          )}
        </For>
      </View>
    </View>
  );
}

export default function Desk() {
  useLink();
  return (
    <View debugName="Desk" class="w-full h-full flex-col gap-2 p-2 bg-zinc-950">
      <Header />
      <View class="flex-row gap-2 flex-1">
        <Deck />
        <NowPlaying />
      </View>
      <Claude />
    </View>
  );
}
