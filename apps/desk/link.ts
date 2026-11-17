// Desk ⇄ deskd bridge. The Android host mounts a `link` global (hosts/android/
// src/link.rs): poll() drains JSON lines pushed by deskd, send() writes one,
// blob(key) returns RGBA pixels the host already decoded. On hosts without it
// (web playground, tests) everything degrades to "disconnected" + no-ops.

import { createSignal, type Accessor } from "solid-js";
import { createStore, reconcile } from "solid-js/store";
import { onFrame } from "@pocketjs/framework/lifecycle";
import { registerTexture } from "@pocketjs/framework";
import { getOps } from "@pocketjs/framework/host";
import { PSM } from "../../contracts/spec/spec.ts";

interface NativeLink {
  poll(): string[];
  send(msg: string): boolean;
  connected(): boolean;
  blob(key: string): { w: number; h: number; gen: number; data: Uint8Array } | undefined;
}

const native = (globalThis as { link?: NativeLink }).link;

const [connected, setConnected] = createSignal(false);
// All provider state lives in one store keyed by provider name ("music",
// "sys", "claude", "clock", "deck"…); components read fine-grained paths.
const [state, setState] = createStore<Record<string, any>>({});
const blobGens = new Map<string, Accessor<number>>();
const blobSetters = new Map<string, (n: number) => void>();
const textureHandles = new Map<string, number>();

function blobSignal(key: string): [Accessor<number>, (n: number) => void] {
  let get = blobGens.get(key);
  let set = blobSetters.get(key);
  if (!get || !set) {
    const [g, s] = createSignal(0);
    blobGens.set(key, g);
    blobSetters.set(key, s);
    get = g;
    set = s;
  }
  return [get, set];
}

function uploadBlob(key: string): void {
  const b = native?.blob(key);
  if (!b) return;
  // pow2 ≤ 512 is the core's texture contract; deskd sends conforming sizes.
  const handle = getOps().uploadTexture(b.data, b.w, b.h, PSM.PSM_8888);
  if (handle < 0) return;
  const texKey = `link:${key}:${b.gen}`;
  registerTexture(texKey, handle);
  textureHandles.set(key, handle);
  blobSignal(key)[1](b.gen);
}

let lastSeen = 0;
/** Start draining the link each frame. Call once from the root component —
 *  mount() resets frame hooks registered before it. */
export function useLink(): void {
onFrame(() => {
  if (!native) return;
  const up = native.connected();
  if (up !== connected()) setConnected(up);
  const lines = native.poll();
  for (const line of lines) {
    let msg: any;
    try {
      msg = JSON.parse(line);
    } catch {
      continue;
    }
    switch (msg.t) {
      case "state":
        setState(msg.k, reconcile(msg.v));
        lastSeen = Date.now();
        break;
      case "blob":
        uploadBlob(msg.k);
        break;
      case "link":
        setConnected(!!msg.connected);
        break;
    }
  }
});
}

/** Live provider state (reactive store). */
export const desk = state;
export const linkConnected = connected;

/** Image `src` key for the latest blob pushed under `key` ("" until one arrives). */
export function blobSrc(key: string): string {
  const gen = blobSignal(key)[0]();
  return gen > 0 ? `link:${key}:${gen}` : "";
}

/** Ask deskd to run an action (see deskd/config.ts). */
export function act(id: string, args?: unknown): boolean {
  return native?.send(JSON.stringify({ t: "action", id, args })) ?? false;
}

export function lastStateAt(): number {
  return lastSeen;
}
