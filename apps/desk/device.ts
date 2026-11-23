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
//     "brightness"      { value: 0..255 }                      (/sys/class/backlight/backlight)
//     "wifi"            { on: boolean }                         (wifi-up / wifi-up off)
//     "charge-limit"    { on: boolean }                         (SM5414 CV 4.10 V on / 4.35 V off)
//     "dim-follow-host" { on: boolean }                         (dim/off while the host is locked/asleep)
//     "touch-filters"   { paused: boolean }                     (pause mask/learn/stale while a confirm sheet is up)

import { createSignal } from "solid-js";
import { onFrame } from "@pocketjs/framework/lifecycle";

export interface DeviceState {
  brightness: number; // 0..255
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
