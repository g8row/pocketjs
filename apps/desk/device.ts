// The tablet's own state and commands (SETTINGS), separate from deckd: these work with no computer
// connected. The PocketJS Linux host mounts a `device` global (to be added in hosts/android: a small
// whitelisted command channel, the host runs as root); the preview harness (hosts/web/deck-preview.html)
// mocks it from mock.json's "device" key. Without it, readDevice() returns null and runs are no-ops.
//
// Contract (the host implements exactly these):
//   device.read("state") → DeviceState (cheap: the host caches it, refreshes every ~2 s)
//   device.run(cmd, args) → { ok, out }, for:
//     "reboot"          { target: "linux" | "android" | "android-direct" | "uboot" | "bootloader" }  (tb-reboot)
//     "poweroff"        {}
//     "restart-ui"      {}                                     (rc-service pocketdeck-ui restart)
//     "brightness"      { value: 0..255, transient?: boolean }  (/sys/class/backlight/backlight; saved as the
//                                                               user's brightness unless transient: host dimming)
//     "wifi"            { on: boolean }                         (wifi-up / wifi-up off)
//     "charge-limit"    { on: boolean }                         (SM5414 CV 4.10 V on / 4.35 V off)
//     "dim-follow-host" { on: boolean }                         (dim/off while the host is locked/asleep)
//     "touch-filters"   { paused: boolean }                     (pause mask/learn/stale while a confirm sheet is up;
//                                                               the host resumes them on its own after 60 s)
//   Unknown commands or bad arguments → { ok: false, out: "<reason>" }.

import { createEffect, createSignal, on } from "solid-js";
import { onFrame } from "@pocketjs/framework/lifecycle";
import { desk } from "./link.ts";

export interface DeviceState {
  brightness: number; // 0..255, what the backlight shows now
  savedBrightness: number | null; // the user's brightness (persisted; host dimming restores it)
  dimFollowHost: boolean;
  wifi: { on: boolean; ssid: string | null; ip: string | null; rssi: number | null };
  usbIp: string;
  battery: { pct: number; charging: boolean; tempC: number; currentMa: number; volts: number; chargeLimit: boolean };
  slot: string; // running boot slot: "a" | "b" | "cache"
  fallbackSlot: string | null; // last good slot other than this one
  build: string; // git describe of the running kernel (BUILDINFO)
  kernel: string;
  uptime: string;
  socTempC: number;
  cpuMhz: number;
  memFreeMb: number;
  memTotalMb: number;
  touchFiltersPaused: boolean;
}

export type DeviceCmd = "reboot" | "poweroff" | "restart-ui" | "brightness" | "wifi" | "charge-limit" | "dim-follow-host" | "touch-filters";

interface NativeDevice {
  read(key: string): unknown;
  run(cmd: string, args?: unknown): { ok: boolean; out: string };
}
const native = (globalThis as { device?: NativeDevice }).device;

/** Whether the host provides the device channel at all (false on older hosts: show settings read-only). */
export const deviceAvailable = (): boolean => !!native;

/** Run a tablet command. Returns false when there is no device channel or the host refused. */
export function runDevice(cmd: DeviceCmd, args: Record<string, unknown> = {}): boolean {
  if (!native) return false;
  try {
    return native.run(cmd, args).ok;
  } catch {
    return false;
  }
}

/** Reactive device state, re-read every ~2 s while `active()` (call inside a component). */
export function useDevice(active: () => boolean): () => DeviceState | null {
  const read = (): DeviceState | null => {
    try {
      return (native?.read("state") as DeviceState | null) ?? null;
    } catch {
      return null;
    }
  };
  const [state, setState] = createSignal<DeviceState | null>(read());
  let n = 0;
  onFrame(() => {
    if (!active() || ++n % 120 !== 0) return;
    setState(read());
  });
  return state;
}

/** Backlight while the host is locked (~10 %) / asleep. */
const DIM_LOCKED = 26;
const DIM_ASLEEP = 0;

/**
 * Dimming that follows the host (call once, from Desk()): while the device's `dimFollowHost` is on, deskd's
 * `desk.host.screen` going "locked" dims the backlight to ~10 %, "asleep" turns it off, and "active" restores
 * the user's saved brightness. It acts only when the host state changes (or when the setting is turned off
 * while dimmed), so the brightness slider always wins in between; dims are transient (never saved). No host
 * data or no device channel: nothing happens.
 */
export function useHostDimming(): void {
  if (!native) return;
  const st = useDevice(() => true);
  const screen = (): string | undefined => {
    const s = desk.host?.screen;
    return s === "active" || s === "locked" || s === "asleep" ? s : undefined;
  };
  const follow = () => st()?.dimFollowHost ?? false;
  let dimmed = false;
  const restore = () => {
    const saved = st()?.savedBrightness;
    dimmed = false;
    if (saved != null) runDevice("brightness", { value: saved, transient: true });
  };
  createEffect(
    on(screen, (s, prev) => {
      if (!s || s === prev || !follow()) return;
      if (s === "active") {
        if (dimmed) restore();
        return;
      }
      if (runDevice("brightness", { value: s === "locked" ? DIM_LOCKED : DIM_ASLEEP, transient: true })) dimmed = true;
    }),
  );
  // turning the setting off while dimmed gives the brightness back
  createEffect(
    on(follow, (f) => {
      if (!f && dimmed) restore();
    }, { defer: true }),
  );
}
