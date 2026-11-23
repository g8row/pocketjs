// SETTINGS: the tablet itself. Everything here runs locally on the tablet through device.ts (no deckd):
// power (reboot targets, restart the UI, power off), display (brightness, dim with the host), network and
// battery (wifi, charge limit) and system info. Left column = touchable (rounded), right = read-outs
// (terminal frames). Destructive actions open a confirm sheet; while it is open the host's ghost-touch
// filters are paused (the cracked glass needs them, but they can also eat a real confirm tap), and they are
// resumed however the sheet closes (cancel, confirm, leaving the page, the timeout, unmount).
//
// Preview only: a `previewSheet` key in mock.json's device.state ("linux" | "android" | "uboot" |
// "off") opens that sheet once the page is first shown. The tablet host never sends it.
import { Show, createEffect, createSignal, on, onCleanup } from "solid-js";
import { Text, View } from "@pocketjs/framework/components";
import { onFrame } from "@pocketjs/framework/lifecycle";
import { Btn, C, Icon, KV, PANE_X, PANE_Y, PH, PW, Sheet, Slider, TBar, TBox, Toggle } from "../ui.tsx";
import { desk } from "../link.ts";
import { accent } from "../theme.ts";
import { deviceAvailable, runDevice, useDevice, type DeviceState } from "../device.ts";

// ---- geometry -----------------------------------------------------------------------------------

const PAD = 8;
const KW = 46; // KV key column in the SYSTEM box
const GAP = 10;
const LEFT_W = 218;
const RIGHT_W = PW - 2 * PAD - GAP - LEFT_W; // 162
const SLIDER_X = PAD + 22; // after the brightness icon
const SLIDER_W = LEFT_W - 22 - 2;
const SHEET_TIMEOUT_MS = 30_000; // a forgotten sheet closes itself (filters back on)
const OPTIMISTIC_MS = 6_000; // how long a sent value wins over a stale read
const MIN_BRIGHTNESS = 8; // never slide the backlight fully off (it's the only way back)

// ---- power actions ------------------------------------------------------------------------------

type ActionId = "linux" | "android" | "uboot" | "ui" | "off";
interface Action {
  label: string; // button
  icon: string;
  ask: string; // sheet question
  verb: string; // confirm button
  run: () => boolean;
}
const ACTIONS: Record<ActionId, Action> = {
  linux: { label: "linux", icon: "restart", ask: "reboot to linux?", verb: "reboot", run: () => runDevice("reboot", { target: "linux" }) },
  android: { label: "android", icon: "android", ask: "reboot to android?", verb: "reboot", run: () => runDevice("reboot", { target: "android" }) },
  uboot: { label: "fastboot", icon: "bolt", ask: "reboot to fastboot?", verb: "reboot", run: () => runDevice("reboot", { target: "uboot" }) },
  ui: { label: "restart ui", icon: "refresh", ask: "restart the ui?", verb: "restart", run: () => runDevice("restart-ui") },
  off: { label: "power off", icon: "power", ask: "power off?", verb: "power off", run: () => runDevice("poweroff") },
};
const SUB: Record<ActionId, string> = {
  linux: "u-boot → this slot",
  android: "stock android",
  uboot: "u-boot fastboot",
  ui: "pocketdeck-ui service",
  off: "until the power key",
};

// ---- small local pieces ---------------------------------------------------------------------------

/** Section label in the touchable column: UPPERCASE mono title, optional right note. */
function Head(props: { title: string; right?: () => string; rightColor?: () => string }) {
  return (
    <View class="flex-row items-center justify-between" style={{ height: 14 }}>
      <Text class="text-xs font-bold tracking-wide" style={{ textColor: C.mute }}>{props.title}</Text>
      <Show when={props.right}>
        <Text class="text-xs font-bold" style={{ textColor: props.rightColor?.() ?? C.mute }}>{props.right!()}</Text>
      </Show>
    </View>
  );
}

/** A 26 px tall touch row: icon, label, mono note, toggle. The whole row toggles. */
function ToggleRow(props: {
  icon: string;
  label: string;
  note: () => string;
  noteColor?: () => string;
  on: () => boolean;
  enabled: () => boolean;
  onChange: (v: boolean) => void;
}) {
  const set = (v: boolean) => {
    if (props.enabled()) props.onChange(v);
  };
  return (
    <View
      class="flex-row items-center gap-[7]"
      style={{ height: 26, paddingL: 2, opacity: props.enabled() ? 1 : 0.4 }}
      focusable
      onPress={() => set(!props.on())}
    >
      <View class="items-center" style={{ width: 16 }}>
        <Icon name={props.icon} size="sm" color={C.soft} />
      </View>
      <Text class="text-sm" style={{ textColor: C.fg }}>{props.label}</Text>
      <View class="flex-1 flex-row justify-end" style={{ paddingR: 6 }}>
        <Text class="text-xs font-bold" style={{ textColor: props.noteColor?.() ?? C.mute }}>{props.note()}</Text>
      </View>
      <View class="shrink-0" style={{ width: 30 }}>
        <Toggle on={props.on} onChange={set} />
      </View>
    </View>
  );
}

const BARS = "▂▄▆█";
/** WiFi signal as ▂▄▆█ (lit cells in the accent, the rest dim). */
function Signal(props: { rssi: () => number | null }) {
  const n = () => {
    const r = props.rssi();
    if (r === null) return 0;
    return r >= -55 ? 4 : r >= -65 ? 3 : r >= -75 ? 2 : 1;
  };
  return (
    <View class="flex-row">
      <Text class="text-xs font-bold" style={{ textColor: accent() }}>{BARS.slice(0, n()) || " "}</Text>
      <Text class="text-xs font-bold" style={{ textColor: C.dim }}>{BARS.slice(n()) || " "}</Text>
    </View>
  );
}

const clip = (s: string, n: number) => (s.length > n ? s.slice(0, n - 1) + "…" : s);
const dash = "–";

// ---- the page -------------------------------------------------------------------------------------

export function SettingsPage(props: { active: () => boolean }) {
  const st = useDevice(props.active);
  /** Commands work: the host has the channel and answers reads. */
  const can = () => deviceAvailable() && st() !== null;

  // Optimistic values: what we just sent wins until a read agrees or it gets old.
  const [ov, setOv] = createSignal<Record<string, { v: unknown; t: number }>>({});
  const pick = <T,>(key: string, real: T | undefined): T | undefined => {
    const o = ov()[key];
    if (o && o.v !== real && Date.now() - o.t < OPTIMISTIC_MS) return o.v as T;
    return real;
  };
  const sent = (key: string, v: unknown, ok: boolean) =>
    setOv((m) => {
      const n = { ...m };
      if (ok) n[key] = { v, t: Date.now() };
      else delete n[key];
      return n;
    });

  const s = (): DeviceState | null => st();
  const tab = () => desk.tablet ?? {};
  const brightness = () => pick<number>("brightness", s()?.brightness) ?? 0;
  const dimFollow = () => pick<boolean>("dim", s()?.dimFollowHost) ?? false;
  const wifiOn = () => pick<boolean>("wifi", s()?.wifi.on) ?? false;
  const chargeLimit = () => pick<boolean>("charge", s()?.battery.chargeLimit) ?? false;

  const toggle = (key: string, cmd: "wifi" | "charge-limit" | "dim-follow-host") => (v: boolean) => {
    if (!can()) return;
    sent(key, v, true);
    if (!runDevice(cmd, { on: v })) sent(key, v, false);
  };

  // ---- brightness
  const [dragB, setDragB] = createSignal<number | null>(null);
  const bShown = () => dragB() ?? brightness() / 255;
  const setBrightness = (v: number) => {
    setDragB(null);
    if (!can()) return;
    const value = Math.max(MIN_BRIGHTNESS, Math.round(v * 255));
    sent("brightness", value, true);
    if (!runDevice("brightness", { value })) sent("brightness", value, false);
  };

  // ---- confirm sheet (one at a time). The filters follow `pending` and nothing else.
  const [pending, setPending] = createSignal<ActionId | null>(null);
  const [shown, setShown] = createSignal<ActionId>("off"); // sheet content, kept while it slides out
  const [failed, setFailed] = createSignal(false);
  let openedAt = 0;
  const ask = (id: ActionId) => {
    if (!can() || pending()) return;
    setShown(id);
    setFailed(false);
    openedAt = Date.now();
    setPending(id);
  };
  const close = () => setPending(null);
  // restart ui isn't destructive (the UI is back in seconds): it runs at once, no sheet
  const restartUi = () => {
    if (can() && !pending()) ACTIONS.ui.run();
  };
  const confirm = () => {
    const id = pending();
    if (!id) return; // the hidden sheet's buttons must never fire
    if (ACTIONS[id].run()) close();
    else setFailed(true);
  };
  createEffect(
    on(
      () => pending() !== null,
      (open) => {
        runDevice("touch-filters", { paused: open });
      },
      { defer: true },
    ),
  );
  // leaving the page closes it (and so resumes the filters)
  createEffect(on(props.active, (a) => !a && close(), { defer: true }));
  onFrame(() => {
    if (pending() && Date.now() - openedAt > SHEET_TIMEOUT_MS) close();
  });
  onCleanup(() => {
    if (pending()) runDevice("touch-filters", { paused: false });
  });
  // a previous UI that died with a sheet open: resume the filters once
  let resumed = false;
  createEffect(() => {
    const d = s();
    if (!d || resumed) return;
    resumed = true;
    if (d.touchFiltersPaused && !pending()) runDevice("touch-filters", { paused: false });
  });
  // preview only (see the header)
  let previewed = false;
  createEffect(() => {
    const d = s() as (DeviceState & { previewSheet?: string }) | null;
    if (previewed || !d || !props.active()) return;
    previewed = true;
    if (d.previewSheet && d.previewSheet !== "ui" && d.previewSheet in ACTIONS) ask(d.previewSheet as ActionId);
  });

  // ---- read-outs
  const host = () => desk.host?.screen as string | undefined;
  const hostNote = () => {
    const h = host();
    return h ?? "no host";
  };
  const hostColor = () => (dimFollow() && host() && host() !== "active" ? accent() : C.mute);
  const unavailable = () => (!deviceAvailable() ? "no device channel" : st() === null ? "device not answering" : "");

  const batPct = () => s()?.battery.pct ?? tab().battery ?? null;
  const charging = () => s()?.battery.charging ?? tab().charging ?? false;
  const batTemp = () => s()?.battery.tempC ?? tab().tempC ?? null;
  const batMa = () => s()?.battery.currentMa ?? tab().currentMa ?? null;
  const batV = () => s()?.battery.volts ?? tab().volts ?? null;
  const batLow = () => (batPct() ?? 100) <= 15 && !charging();
  const ma = () => {
    const m = batMa();
    if (m === null) return dash;
    const signed = charging() ? Math.abs(m) : -Math.abs(m);
    return `${signed > 0 ? "+" : ""}${signed} mA`;
  };

  const net = () => s()?.wifi;
  const ssidLine = () => {
    if (!s()) return dash;
    if (!wifiOn()) return "wifi off";
    const id = net()?.ssid;
    return id ? clip(id, 11) : net()?.on ? "not connected" : "connecting…";
  };
  const ssidColor = () => (!s() || !wifiOn() ? C.mute : net()?.ssid ? C.fg : C.wait);
  const dotColor = () => (!s() || !wifiOn() ? C.dim : net()?.ssid ? C.ok : C.wait);

  const slotLine = () => {
    const d = s();
    if (!d) return dash;
    return d.fallbackSlot ? `${d.slot} (${d.fallbackSlot} fallback)` : d.slot;
  };
  const memFree = () => s()?.memFreeMb ?? tab().memFreeMb;
  const memTotal = () => s()?.memTotalMb ?? tab().memTotalMb;

  return (
    <View class="relative flex-row" style={{ width: PW, height: PH, paddingL: PAD, paddingR: PAD, paddingT: PAD, paddingB: PAD, gap: GAP }}>
      {/* ---- touchable column ---- */}
      <View class="flex-col" style={{ width: LEFT_W }}>
        <Head title="POWER" right={() => unavailable() || " "} rightColor={() => C.wait} />
        <View class="flex-col gap-[6]" style={{ paddingT: 4, opacity: can() ? 1 : 0.4 }}>
          <View class="flex-row gap-[6]">
            <Btn label={ACTIONS.linux.label} icon={ACTIONS.linux.icon} grow onPress={() => ask("linux")} />
            <Btn label={ACTIONS.android.label} icon={ACTIONS.android.icon} grow onPress={() => ask("android")} />
          </View>
          <View class="flex-row gap-[6]">
            <Btn label={ACTIONS.uboot.label} icon={ACTIONS.uboot.icon} grow onPress={() => ask("uboot")} />
            <Btn label={ACTIONS.ui.label} icon={ACTIONS.ui.icon} grow onPress={restartUi} />
          </View>
          <Btn label={ACTIONS.off.label} icon={ACTIONS.off.icon} kind="warn" onPress={() => ask("off")} />
        </View>

        <View style={{ height: 8 }} />
        <Head title="DISPLAY" right={() => (s() ? `${Math.round(bShown() * 100)}%` : dash)} rightColor={() => accent()} />
        <View class="flex-row items-center" style={{ height: 26, opacity: can() ? 1 : 0.4 }}>
          <View class="items-center" style={{ width: 18, paddingR: 2 }}>
            <Icon name="brightness" size="sm" color={C.soft} />
          </View>
          <Slider
            x={PANE_X + SLIDER_X}
            y={PANE_Y + PAD + 14 + 4 + 26 * 3 + 6 * 2 + 8 + 14 + 1}
            w={SLIDER_W}
            value={bShown}
            onInput={(v) => setDragB(v)}
            onChange={setBrightness}
            active={() => props.active() && can() && !pending()}
          />
        </View>
        <ToggleRow icon="moon" label="dim with host" note={hostNote} noteColor={hostColor} on={dimFollow} enabled={can} onChange={toggle("dim", "dim-follow-host")} />

        <View style={{ height: 6 }} />
        <Head title="NETWORK & BATTERY" />
        <ToggleRow
          icon={wifiOn() ? "wifi" : "wifi-off"}
          label="wifi"
          note={() => { const st = s(); if (!st) return dash; if (!wifiOn()) return " "; const id = st.wifi?.ssid; return id ? (id.length > 10 ? `${id.slice(0, 9)}…` : id) : "no network"; }} // the toggle shows on/off; the note names the network
          on={wifiOn}
          enabled={can}
          onChange={toggle("wifi", "wifi")}
        />
        <ToggleRow
          icon="battery"
          label="charge limit"
          note={() => "~80%"}
          on={chargeLimit}
          enabled={can}
          onChange={toggle("charge", "charge-limit")}
        />
      </View>

      {/* ---- read-only column ---- */}
      <View class="flex-col gap-[2]" style={{ width: RIGHT_W }}>
        <TBox title="NETWORK" pad={5} right={s() && wifiOn() && net()?.rssi != null ? `${net()!.rssi} dBm` : undefined} rightIcon={wifiOn() && s() ? "wifi" : "wifi-off"}>
          <View class="flex-row items-center gap-[5]">
            <Text class="text-xs font-bold" style={{ textColor: dotColor() }}>●</Text>
            <Text class="text-xs font-bold" style={{ textColor: ssidColor() }}>{ssidLine()}</Text>
            <View class="flex-1" />
            <Show when={s() && wifiOn() && net()?.ssid}>
              <Signal rssi={() => net()?.rssi ?? null} />
            </Show>
          </View>
          <KV k="ip" kw={32} v={(wifiOn() && net()?.ip) || dash} color={wifiOn() && net()?.ip ? C.fg : C.mute} />
          <KV k="usb" kw={32} v={s()?.usbIp ?? dash} />
        </TBox>
        <TBox
          title="BATTERY"
          right={batPct() !== null ? `${batPct()}%` : dash}
          rightIcon={charging() ? "battery-charging" : "battery"}
          hot={batLow()}
          color={C.rose}
          pad={5}
        >
          <TBar value={() => (batPct() ?? 0) / 100} cells={19} color={batLow() ? C.rose : charging() ? C.ok : accent()} />
          <Text class="text-xs font-bold" style={{ textColor: C.soft }}>
            {`${batTemp() !== null ? `${batTemp()} °C` : dash} · ${ma()}`}
          </Text>
          <Text class="text-xs font-bold" style={{ textColor: C.mute }}>
            {`${batV() !== null ? `${batV()!.toFixed(2)} V` : dash} · ${charging() ? "charging" : "on battery"}`}
          </Text>
        </TBox>
        <TBox title="SYSTEM" grow pad={5} right={`up ${s()?.uptime ?? tab().uptime ?? dash}`}>
          <KV k="slot" kw={KW} v={slotLine()} />
          <KV k="build" kw={KW} v={s()?.build ? clip(s()!.build, 13) : dash} />
          <KV k="kern" kw={KW} v={s()?.kernel ? clip(s()!.kernel, 13) : dash} />
          <KV k="soc" kw={KW} v={s()?.socTempC != null ? `${s()!.socTempC} °C` : dash} color={(s()?.socTempC ?? 0) >= 70 ? C.wait : C.fg} />
          <KV k="cpu" kw={KW} v={(s()?.cpuMhz ?? tab().cpuMhz) != null ? `${s()?.cpuMhz ?? tab().cpuMhz} MHz` : dash} />
          <KV k="free" kw={KW} v={memFree() != null ? `${memFree()}/${memTotal() ?? "?"} mb` : dash} />
        </TBox>
      </View>

      {/* ---- confirm sheet: a scrim swallows taps on the page while it is open ---- */}
      <Show when={pending()}>
        <View class="absolute" style={{ insetL: 0, insetT: 0, width: PW, height: PH, bgColor: "#000000b0" }} focusable onPress={() => {}} />
      </Show>
      <Sheet open={() => pending() !== null} color={C.rose}>
        <Icon name={ACTIONS[shown()].icon} size="2xl" color={C.rose} />
        <View class="flex-1 flex-col">
          <Text class="text-base" style={{ textColor: C.fg }}>{ACTIONS[shown()].ask}</Text>
          <Text class="text-xs font-bold" style={{ textColor: failed() ? C.rose : C.mute }}>{failed() ? "the tablet refused" : "touch filters paused"}</Text>
          <Text class="text-xs font-bold" style={{ textColor: C.mute }}>{failed() ? SUB[shown()] : "while this is open"}</Text>
        </View>
        <Btn label="cancel" h={34} onPress={close} />
        <Btn label={ACTIONS[shown()].verb} kind="danger" h={34} onPress={confirm} />
      </Sheet>
    </View>
  );
}
