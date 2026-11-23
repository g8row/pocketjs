//! `device` — the tablet's own state and a whitelisted command channel (Linux kiosk host only).
//!
//! The JS contract is `apps/desk/device.ts` (the SETTINGS page):
//!   device.read("state")   → DeviceState, served from a cache that a background thread refreshes every ~2 s
//!                            (sysfs/procfs plus `iw`, `ip`, `tbstate`); never blocks on a command
//!   device.run(cmd, args)  → { ok, out } for a fixed whitelist with validated arguments. Commands are
//!                            spawned with an argv (no shell strings); long or self-killing ones are detached.
//!
//! Settings (`dimFollowHost`, `chargeLimit`, last brightness) persist in /data/pocketdeck/settings.json and
//! are applied at start. `touch-filters {paused}` sets a deadline the kiosk's touch filters honour
//! ([`touch_filters_paused`]); it expires on its own after [`PAUSE_MAX`].

use std::path::Path;
use std::process::{Command, Stdio};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::mpsc::{channel, Receiver, Sender};
use std::sync::{Mutex, OnceLock};
use std::time::{Duration, Instant};

use pocket_mod::qjs::function::Opt;
use pocket_mod::qjs::{Ctx, Function, Object, Value};
use pocket_mod::Guest;
use serde_json::{json, Value as Json};

const SETTINGS_DIR: &str = "/data/pocketdeck";
const SETTINGS: &str = "/data/pocketdeck/settings.json";
const BACKLIGHT: &str = "/sys/class/backlight/backlight";
const BATTERY: &str = "/sys/class/power_supply/battery";
const CHARGER_CV: &str = "/sys/class/power_supply/sm5414-charger/constant_charge_voltage";
const WIFI_IF: &str = "mt6625_0";
const USB_IF: &str = "usb0";
/// Constant charge voltage with the limit on (~80 %) and off (full), µV.
const CV_LIMIT: u32 = 4_100_000;
const CV_FULL: u32 = 4_350_000;
const REFRESH: Duration = Duration::from_secs(2);
/// `touch-filters {paused: true}` expires on its own after this.
pub const PAUSE_MAX: Duration = Duration::from_secs(60);
/// Delay before a detached command that ends this process (or the machine) runs, so `run` can answer first.
const DETACH_DELAY: Duration = Duration::from_millis(400);
const PATH_ENV: &str = "/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin";

// ---- persisted settings ----------------------------------------------------------------------------

#[derive(Clone, Debug, PartialEq)]
struct Settings {
    dim_follow_host: bool,
    charge_limit: bool,
    brightness: Option<u32>,
}

impl Default for Settings {
    fn default() -> Self {
        // the charge limit is the tablet's normal desk policy (it lives on USB power)
        Settings { dim_follow_host: false, charge_limit: true, brightness: None }
    }
}

impl Settings {
    fn parse(s: &str) -> Settings {
        let d = Settings::default();
        let Ok(v) = serde_json::from_str::<Json>(s) else { return d };
        Settings {
            dim_follow_host: v.get("dimFollowHost").and_then(Json::as_bool).unwrap_or(d.dim_follow_host),
            charge_limit: v.get("chargeLimit").and_then(Json::as_bool).unwrap_or(d.charge_limit),
            brightness: v.get("brightness").and_then(Json::as_u64).filter(|&b| b <= 255).map(|b| b as u32),
        }
    }

    fn to_json(&self) -> String {
        json!({ "dimFollowHost": self.dim_follow_host, "chargeLimit": self.charge_limit, "brightness": self.brightness })
            .to_string()
    }

    fn load() -> Settings {
        std::fs::read_to_string(SETTINGS).map(|s| Settings::parse(&s)).unwrap_or_default()
    }

    fn save(&self) {
        let r = std::fs::create_dir_all(SETTINGS_DIR)
            .and_then(|_| std::fs::write(format!("{SETTINGS}.new"), self.to_json()))
            .and_then(|_| std::fs::rename(format!("{SETTINGS}.new"), SETTINGS));
        if let Err(e) = r {
            log::warn!("device: saving {SETTINGS}: {e}");
        }
    }
}

// ---- commands --------------------------------------------------------------------------------------

#[derive(Clone, Copy, Debug, PartialEq)]
pub enum RebootTarget {
    Linux,
    Android,
    AndroidDirect,
    Uboot,
    Bootloader,
}

impl RebootTarget {
    fn arg(self) -> &'static str {
        match self {
            RebootTarget::Linux => "linux",
            RebootTarget::Android => "android",
            RebootTarget::AndroidDirect => "android-direct",
            RebootTarget::Uboot => "uboot",
            RebootTarget::Bootloader => "bootloader",
        }
    }
}

/// A validated command.
#[derive(Clone, Debug, PartialEq)]
pub enum Cmd {
    Reboot(RebootTarget),
    Poweroff,
    RestartUi,
    Brightness { value: u32, transient: bool },
    Wifi(bool),
    ChargeLimit(bool),
    DimFollowHost(bool),
    TouchFilters(bool),
}

fn arg_bool(args: &Json, key: &str) -> Result<bool, String> {
    match args.get(key) {
        Some(Json::Bool(b)) => Ok(*b),
        Some(_) => Err(format!("'{key}' must be a boolean")),
        None => Err(format!("missing '{key}'")),
    }
}

/// Validate `cmd` + `args` (the JSON of the JS arguments; `null` when none were given).
pub fn parse_cmd(cmd: &str, args: &Json) -> Result<Cmd, String> {
    if !(args.is_null() || args.is_object()) {
        return Err("args must be an object".into());
    }
    Ok(match cmd {
        "reboot" => Cmd::Reboot(match args.get("target").and_then(Json::as_str) {
            Some("linux") => RebootTarget::Linux,
            Some("android") => RebootTarget::Android,
            Some("android-direct") => RebootTarget::AndroidDirect,
            Some("uboot") => RebootTarget::Uboot,
            Some("bootloader") => RebootTarget::Bootloader,
            Some(t) => return Err(format!("unknown reboot target '{t}'")),
            None => return Err("missing 'target'".into()),
        }),
        "poweroff" => Cmd::Poweroff,
        "restart-ui" => Cmd::RestartUi,
        "brightness" => {
            let v = args.get("value").ok_or("missing 'value'")?;
            let value = match v.as_u64() {
                Some(n) if n <= 255 => n as u32,
                // JS numbers can arrive as floats: accept integral ones
                _ => match v.as_f64() {
                    Some(f) if f.fract() == 0.0 && (0.0..=255.0).contains(&f) => f as u32,
                    _ => return Err("'value' must be an integer 0..255".into()),
                },
            };
            let transient = match args.get("transient") {
                None | Some(Json::Null) => false,
                Some(Json::Bool(b)) => *b,
                Some(_) => return Err("'transient' must be a boolean".into()),
            };
            Cmd::Brightness { value, transient }
        }
        "wifi" => Cmd::Wifi(arg_bool(args, "on")?),
        "charge-limit" => Cmd::ChargeLimit(arg_bool(args, "on")?),
        "dim-follow-host" => Cmd::DimFollowHost(arg_bool(args, "on")?),
        "touch-filters" => Cmd::TouchFilters(arg_bool(args, "paused")?),
        _ => return Err(format!("unknown command '{cmd}'")),
    })
}

// ---- parsers ---------------------------------------------------------------------------------------

/// `iw dev <if> link` → (ssid, signal dBm); (None, None) when not connected.
pub fn parse_iw_link(out: &str) -> (Option<String>, Option<i32>) {
    if !out.trim_start().starts_with("Connected to") {
        return (None, None);
    }
    let mut ssid = None;
    let mut rssi = None;
    for l in out.lines() {
        let l = l.trim();
        if let Some(s) = l.strip_prefix("SSID: ") {
            ssid = Some(s.to_owned());
        } else if let Some(s) = l.strip_prefix("signal: ") {
            rssi = s.split_whitespace().next().and_then(|n| n.parse().ok());
        }
    }
    (ssid, rssi)
}

/// `ip -4 addr` → the first IPv4 address of interface `ifname` (without the prefix length).
pub fn parse_ipv4(out: &str, ifname: &str) -> Option<String> {
    let mut cur = false;
    for l in out.lines() {
        if !l.starts_with(' ') && !l.starts_with('\t') {
            // "3: usb0: <FLAGS> ..." (or "3: wlan0@x: ...")
            cur = l.split(':').nth(1).map(|n| n.trim().split('@').next() == Some(ifname)).unwrap_or(false);
        } else if cur {
            if let Some(rest) = l.trim().strip_prefix("inet ") {
                return rest.split_whitespace().next().map(|a| a.split('/').next().unwrap_or(a).to_owned());
            }
        }
    }
    None
}

/// `tb.slot=<x>` on /proc/cmdline.
pub fn parse_cmdline_slot(cmdline: &str) -> Option<String> {
    cmdline.split_whitespace().find_map(|w| w.strip_prefix("tb.slot=")).filter(|s| !s.is_empty()).map(str::to_owned)
}

/// `key=value` line of a key=value text (BUILDINFO, `tbstate` output).
pub fn parse_kv(text: &str, key: &str) -> Option<String> {
    text.lines()
        .find_map(|l| l.trim().strip_prefix(key)?.strip_prefix('=').map(|v| v.trim().to_owned()))
        .filter(|v| !v.is_empty())
}

/// The fallback slot from `tbstate`: last_good_slot when it is a real slot other than the running one.
pub fn fallback_slot(tbstate: &str, running: &str) -> Option<String> {
    parse_kv(tbstate, "last_good_slot").filter(|s| s != running && s != "none")
}

/// Seconds → "3d 4h" / "4h 12m" / "12m".
pub fn format_uptime(secs: u64) -> String {
    let (d, h, m) = (secs / 86400, secs / 3600 % 24, secs / 60 % 60);
    if d > 0 {
        format!("{d}d {h}h")
    } else if h > 0 {
        format!("{h}h {m}m")
    } else {
        format!("{m}m")
    }
}

/// /proc/meminfo field in kB.
fn meminfo_kb(text: &str, key: &str) -> Option<u64> {
    text.lines().find_map(|l| l.strip_prefix(key)?.strip_prefix(':')?.split_whitespace().next()?.parse().ok())
}

// ---- state -----------------------------------------------------------------------------------------

struct Shared {
    /// The cached DeviceState JSON.
    state: Mutex<String>,
    settings: Mutex<Settings>,
    wake: Mutex<Sender<()>>,
    wifi_busy: Mutex<bool>,
}

static SHARED: OnceLock<Shared> = OnceLock::new();
static EPOCH: OnceLock<Instant> = OnceLock::new();
/// Touch filters are paused until this many ms after EPOCH (0 = not paused).
static PAUSE_UNTIL: AtomicU64 = AtomicU64::new(0);

fn now_ms() -> u64 {
    EPOCH.get_or_init(Instant::now).elapsed().as_millis() as u64
}

/// Whether the kiosk's touch filters (mask, learn, stale) are bypassed right now.
pub fn touch_filters_paused() -> bool {
    paused_at(PAUSE_UNTIL.load(Ordering::Relaxed), now_ms())
}

fn paused_at(until: u64, now: u64) -> bool {
    until != 0 && now < until
}

fn read(path: impl AsRef<Path>) -> Option<String> {
    std::fs::read_to_string(path).ok().map(|s| s.trim().to_owned())
}

fn read_num<T: std::str::FromStr>(path: impl AsRef<Path>) -> Option<T> {
    read(path)?.parse().ok()
}

fn output(prog: &str, args: &[&str]) -> Option<String> {
    let o = Command::new(prog).args(args).env("PATH", PATH_ENV).stdin(Stdio::null()).stderr(Stdio::null()).output().ok()?;
    Some(String::from_utf8_lossy(&o.stdout).into_owned())
}

/// Facts that do not change while this process runs.
struct Fixed {
    slot: String,
    build: String,
    kernel: String,
}

impl Fixed {
    fn probe() -> Fixed {
        let slot = read("/proc/cmdline").and_then(|c| parse_cmdline_slot(&c)).unwrap_or_else(|| "?".into());
        let build = read(format!("{SETTINGS_DIR}/slot-{slot}.kernel")).and_then(|b| parse_kv(&b, "version")).unwrap_or_default();
        let kernel = output("uname", &["-r"]).map(|s| s.trim().to_owned()).unwrap_or_default();
        Fixed { slot, build, kernel }
    }
}

fn backlight_max() -> u32 {
    read_num(format!("{BACKLIGHT}/max_brightness")).filter(|&m: &u32| m > 0).unwrap_or(255)
}

fn collect(fixed: &Fixed, settings: &Settings, fallback: &Option<String>) -> Json {
    let max = backlight_max();
    let brightness = read_num::<u32>(format!("{BACKLIGHT}/brightness")).map(|b| (b * 255 + max / 2) / max).unwrap_or(0);

    let wifi_on = read(format!("/sys/class/net/{WIFI_IF}/flags"))
        .and_then(|f| u32::from_str_radix(f.trim_start_matches("0x"), 16).ok())
        .is_some_and(|f| f & 1 != 0);
    let addrs = output("ip", &["-4", "addr"]).unwrap_or_default();
    let (ssid, rssi) = if wifi_on { parse_iw_link(&output("iw", &["dev", WIFI_IF, "link"]).unwrap_or_default()) } else { (None, None) };
    let wifi_ip = if wifi_on { parse_ipv4(&addrs, WIFI_IF) } else { None };

    let pct = read_num::<u32>(format!("{BATTERY}/capacity")).unwrap_or(0);
    let status = read(format!("{BATTERY}/status")).unwrap_or_default();
    let temp = read_num::<f64>(format!("{BATTERY}/temp")).map(|t| (t / 10.0 * 10.0).round() / 10.0).unwrap_or(0.0);
    let current = read_num::<i64>(format!("{BATTERY}/current_now")).map(|c| c / 1000).unwrap_or(0);
    let volts = read_num::<f64>(format!("{BATTERY}/voltage_now")).map(|v| (v / 10_000.0).round() / 100.0).unwrap_or(0.0);
    let cv = read_num::<u32>(CHARGER_CV);
    let charge_limit = cv.map(|cv| cv <= CV_LIMIT).unwrap_or(settings.charge_limit);

    let uptime = read("/proc/uptime").and_then(|u| u.split('.').next()?.parse::<u64>().ok()).map(format_uptime).unwrap_or_default();
    let soc = read_num::<i64>("/sys/class/thermal/thermal_zone0/temp").map(|t| (t as f64 / 1000.0).round() as i64).unwrap_or(0);
    let cpu = read_num::<u64>("/sys/devices/system/cpu/cpu0/cpufreq/scaling_cur_freq").map(|k| k / 1000).unwrap_or(0);
    let mem = read("/proc/meminfo").unwrap_or_default();
    let mem_total = meminfo_kb(&mem, "MemTotal").unwrap_or(0) / 1024;
    let mem_free = meminfo_kb(&mem, "MemAvailable").or_else(|| meminfo_kb(&mem, "MemFree")).unwrap_or(0) / 1024;

    json!({
        "brightness": brightness,
        "savedBrightness": settings.brightness,
        "dimFollowHost": settings.dim_follow_host,
        "wifi": { "on": wifi_on, "ssid": ssid, "ip": wifi_ip, "rssi": rssi },
        "usbIp": parse_ipv4(&addrs, USB_IF).unwrap_or_default(),
        "battery": {
            "pct": pct,
            "charging": status == "Charging",
            "tempC": temp,
            "currentMa": current,
            "volts": volts,
            "chargeLimit": charge_limit,
        },
        "slot": fixed.slot,
        "fallbackSlot": fallback,
        "build": fixed.build,
        "kernel": fixed.kernel,
        "uptime": uptime,
        "socTempC": soc,
        "cpuMhz": cpu,
        "memFreeMb": mem_free,
        "memTotalMb": mem_total,
        "touchFiltersPaused": touch_filters_paused(),
    })
}

fn refresher(fixed: Fixed, wake: Receiver<()>) {
    let mut fallback = None;
    let mut n = 0u32;
    let mut was_paused = false;
    loop {
        let _ = wake.recv_timeout(REFRESH);
        while wake.try_recv().is_ok() {}
        if n % 15 == 0 {
            fallback = output("tbstate", &[]).and_then(|t| fallback_slot(&t, &fixed.slot));
        }
        n += 1;
        let paused = touch_filters_paused();
        if was_paused && !paused && PAUSE_UNTIL.load(Ordering::Relaxed) != 0 {
            PAUSE_UNTIL.store(0, Ordering::Relaxed);
            log::info!("device: touch filters resumed (timeout)");
        }
        was_paused = paused;
        refresh(&fixed, &fallback);
    }
}

fn refresh(fixed: &Fixed, fallback: &Option<String>) {
    let s = SHARED.get().unwrap();
    let settings = s.settings.lock().unwrap().clone();
    let st = collect(fixed, &settings, fallback).to_string();
    *s.state.lock().unwrap() = st;
}

fn wake() {
    if let Some(s) = SHARED.get() {
        let _ = s.wake.lock().unwrap().send(());
    }
}

// ---- actions ---------------------------------------------------------------------------------------

fn set_brightness(value: u32) -> Result<(), String> {
    let raw = (value * backlight_max() + 127) / 255;
    std::fs::write(format!("{BACKLIGHT}/brightness"), raw.to_string()).map_err(|e| format!("backlight: {e}"))
}

fn set_charge_limit(on: bool) -> Result<(), String> {
    let cv = if on { CV_LIMIT } else { CV_FULL };
    std::fs::write(CHARGER_CV, cv.to_string()).map_err(|e| format!("charger: {e}"))
}

fn command(prog: &str, args: &[&str]) -> Command {
    let mut c = Command::new(prog);
    c.args(args).env("PATH", PATH_ENV).stdin(Stdio::null()).stdout(Stdio::null()).stderr(Stdio::null());
    c
}

/// Run `prog args` after `delay` in its own session (it outlives this process), reaping it if we live on.
fn detach(prog: &'static str, args: &'static [&'static str], delay: Duration) {
    std::thread::spawn(move || {
        std::thread::sleep(delay);
        let mut c = command(prog, args);
        use std::os::unix::process::CommandExt;
        // SAFETY: setsid is async-signal-safe; nothing else runs between fork and exec.
        unsafe {
            c.pre_exec(|| {
                libc::setsid();
                Ok(())
            });
        }
        match c.spawn() {
            Ok(mut ch) => {
                let _ = ch.wait();
            }
            Err(e) => log::error!("device: {prog}: {e}"),
        }
    });
}

fn exec(cmd: Cmd) -> Result<String, String> {
    let s = SHARED.get().ok_or("device not started")?;
    match cmd {
        Cmd::Reboot(t) => {
            // tb-reboot syncs and reboots with sysrq
            let args: &'static [&'static str] = match t {
                RebootTarget::Linux => &["linux"],
                RebootTarget::Android => &["android"],
                RebootTarget::AndroidDirect => &["android-direct"],
                RebootTarget::Uboot => &["uboot"],
                RebootTarget::Bootloader => &["bootloader"],
            };
            log::info!("device: reboot → {}", t.arg());
            detach("/usr/local/sbin/tb-reboot", args, DETACH_DELAY);
            Ok(format!("rebooting to {}", t.arg()))
        }
        Cmd::Poweroff => {
            log::info!("device: power off");
            detach("/sbin/poweroff", &[], DETACH_DELAY);
            Ok("powering off".into())
        }
        Cmd::RestartUi => {
            log::info!("device: restarting the UI service");
            detach("/sbin/rc-service", &["pocketdeck-ui", "restart"], DETACH_DELAY);
            Ok("restarting pocketdeck-ui".into())
        }
        Cmd::Brightness { value, transient } => {
            set_brightness(value)?;
            if !transient {
                let mut st = s.settings.lock().unwrap();
                st.brightness = Some(value);
                st.save();
            }
            wake();
            Ok(format!("brightness {value}{}", if transient { " (transient)" } else { "" }))
        }
        Cmd::Wifi(on) => {
            {
                let mut busy = s.wifi_busy.lock().unwrap();
                if *busy {
                    return Err("wifi: busy".into());
                }
                *busy = true;
            }
            std::thread::spawn(move || {
                let arg = if on { "join" } else { "off" };
                let r = command("/usr/local/sbin/wifi-up", &[arg]).stdout(Stdio::piped()).stderr(Stdio::piped()).output();
                match r {
                    Ok(o) => log::info!(
                        "device: wifi-up {arg}: {} | {} | {}",
                        o.status,
                        String::from_utf8_lossy(&o.stdout).trim().replace('\n', " | "),
                        String::from_utf8_lossy(&o.stderr).trim().replace('\n', " | ")
                    ),
                    Err(e) => log::warn!("device: wifi-up {arg}: {e}"),
                }
                *SHARED.get().unwrap().wifi_busy.lock().unwrap() = false;
                wake();
            });
            // the radio state flips within a second or two; wake the refresher now and again shortly
            wake();
            Ok(format!("wifi {}", if on { "joining" } else { "turning off" }))
        }
        Cmd::ChargeLimit(on) => {
            set_charge_limit(on)?;
            let mut st = s.settings.lock().unwrap();
            st.charge_limit = on;
            st.save();
            drop(st);
            log::info!("device: charge limit {}", if on { "on (4.10 V)" } else { "off (4.35 V)" });
            wake();
            Ok(format!("charge limit {}", if on { "on" } else { "off" }))
        }
        Cmd::DimFollowHost(on) => {
            let mut st = s.settings.lock().unwrap();
            st.dim_follow_host = on;
            st.save();
            drop(st);
            wake();
            Ok(format!("dim with host {}", if on { "on" } else { "off" }))
        }
        Cmd::TouchFilters(paused) => {
            PAUSE_UNTIL.store(if paused { now_ms() + PAUSE_MAX.as_millis() as u64 } else { 0 }, Ordering::Relaxed);
            log::info!("device: touch filters {}", if paused { "paused (60 s max)" } else { "resumed" });
            wake();
            Ok(format!("touch filters {}", if paused { "paused" } else { "on" }))
        }
    }
}

/// Validate and run a command: `{ ok, out }` as (bool, message).
pub fn run(cmd: &str, args: &Json) -> (bool, String) {
    match parse_cmd(cmd, args).and_then(exec) {
        Ok(out) => (true, out),
        Err(e) => {
            log::warn!("device: {cmd} {args}: {e}");
            (false, e)
        }
    }
}

/// Load and apply the settings, take the first state snapshot (logged), start the refresher.
pub fn start() {
    if SHARED.get().is_some() {
        return;
    }
    let _ = EPOCH.get_or_init(Instant::now);
    let settings = Settings::load();
    if !Path::new(SETTINGS).exists() {
        settings.save();
    }
    if let Some(b) = settings.brightness {
        if let Err(e) = set_brightness(b) {
            log::warn!("device: {e}");
        }
    }
    if let Err(e) = set_charge_limit(settings.charge_limit) {
        log::warn!("device: {e}");
    }
    let (tx, rx) = channel();
    let _ = SHARED.set(Shared { state: Mutex::new("null".into()), settings: Mutex::new(settings), wake: Mutex::new(tx), wifi_busy: Mutex::new(false) });
    let fixed = Fixed::probe();
    let fallback = output("tbstate", &[]).and_then(|t| fallback_slot(&t, &fixed.slot));
    refresh(&fixed, &fallback);
    log::info!("device: state {}", SHARED.get().unwrap().state.lock().unwrap());
    std::thread::Builder::new()
        .name("device".into())
        .spawn(move || refresher(fixed, rx))
        .expect("spawn device thread");
}

/// Mount the `device` global into the guest (after [`start`]).
pub fn mount(guest: &Guest) -> anyhow::Result<()> {
    guest.mount("device", |ctx: &Ctx, ns: &Object| {
        ns.set("read", Function::new(ctx.clone(), js_read)?)?;
        ns.set("run", Function::new(ctx.clone(), js_run)?)?;
        Ok(())
    })
}

fn js_read<'js>(ctx: Ctx<'js>, key: String) -> pocket_mod::qjs::Result<Value<'js>> {
    match (key.as_str(), SHARED.get()) {
        ("state", Some(s)) => {
            let st = s.state.lock().unwrap().clone();
            ctx.json_parse(st)
        }
        _ => Ok(Value::new_null(ctx)),
    }
}

fn js_run<'js>(ctx: Ctx<'js>, cmd: String, args: Opt<Value<'js>>) -> pocket_mod::qjs::Result<Object<'js>> {
    let args = match args.0 {
        Some(v) if !v.is_undefined() => ctx
            .json_stringify(v)?
            .map(|s| s.to_string())
            .transpose()?
            .and_then(|s| serde_json::from_str(&s).ok())
            .unwrap_or(Json::Null),
        _ => Json::Null,
    };
    let (ok, out) = run(&cmd, &args);
    let o = Object::new(ctx)?;
    o.set("ok", ok)?;
    o.set("out", out)?;
    Ok(o)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn reboot_targets() {
        for (t, want) in [
            ("linux", RebootTarget::Linux),
            ("android", RebootTarget::Android),
            ("android-direct", RebootTarget::AndroidDirect),
            ("uboot", RebootTarget::Uboot),
            ("bootloader", RebootTarget::Bootloader),
        ] {
            assert_eq!(parse_cmd("reboot", &json!({ "target": t })), Ok(Cmd::Reboot(want)));
            assert_eq!(want.arg(), t);
        }
        assert!(parse_cmd("reboot", &json!({ "target": "recovery" })).is_err());
        assert!(parse_cmd("reboot", &json!({ "target": "linux; rm -rf /" })).is_err());
        assert!(parse_cmd("reboot", &json!({})).is_err());
        assert!(parse_cmd("reboot", &json!({ "target": 1 })).is_err());
        assert!(parse_cmd("reboot", &Json::Null).is_err());
    }

    #[test]
    fn argless_commands() {
        assert_eq!(parse_cmd("poweroff", &Json::Null), Ok(Cmd::Poweroff));
        assert_eq!(parse_cmd("poweroff", &json!({})), Ok(Cmd::Poweroff));
        assert_eq!(parse_cmd("restart-ui", &json!({})), Ok(Cmd::RestartUi));
        assert!(parse_cmd("restart-ui", &json!("x")).is_err());
        assert!(parse_cmd("shutdown", &json!({})).is_err());
        assert!(parse_cmd("", &json!({})).is_err());
    }

    #[test]
    fn brightness_args() {
        assert_eq!(parse_cmd("brightness", &json!({ "value": 0 })), Ok(Cmd::Brightness { value: 0, transient: false }));
        assert_eq!(parse_cmd("brightness", &json!({ "value": 255 })), Ok(Cmd::Brightness { value: 255, transient: false }));
        assert_eq!(parse_cmd("brightness", &json!({ "value": 128.0 })), Ok(Cmd::Brightness { value: 128, transient: false }));
        assert_eq!(
            parse_cmd("brightness", &json!({ "value": 25, "transient": true })),
            Ok(Cmd::Brightness { value: 25, transient: true })
        );
        for bad in [json!({ "value": 256 }), json!({ "value": -1 }), json!({ "value": 1.5 }), json!({ "value": "100" }), json!({})] {
            assert!(parse_cmd("brightness", &bad).is_err(), "{bad}");
        }
        assert!(parse_cmd("brightness", &json!({ "value": 9, "transient": "yes" })).is_err());
    }

    #[test]
    fn bool_args() {
        assert_eq!(parse_cmd("wifi", &json!({ "on": true })), Ok(Cmd::Wifi(true)));
        assert_eq!(parse_cmd("wifi", &json!({ "on": false })), Ok(Cmd::Wifi(false)));
        assert_eq!(parse_cmd("charge-limit", &json!({ "on": true })), Ok(Cmd::ChargeLimit(true)));
        assert_eq!(parse_cmd("dim-follow-host", &json!({ "on": false })), Ok(Cmd::DimFollowHost(false)));
        assert_eq!(parse_cmd("touch-filters", &json!({ "paused": true })), Ok(Cmd::TouchFilters(true)));
        assert!(parse_cmd("wifi", &json!({ "on": 1 })).is_err());
        assert!(parse_cmd("wifi", &json!({ "on": "true" })).is_err());
        assert!(parse_cmd("charge-limit", &json!({})).is_err());
        assert!(parse_cmd("touch-filters", &json!({ "on": true })).is_err());
    }

    #[test]
    fn iw_link() {
        let out = "Connected to aa:bb:cc:dd:ee:ff (on mt6625_0)\n\tSSID: Home Net\n\tfreq: 2437\n\tRX: 1234 bytes (10 packets)\n\tsignal: -61 dBm\n\ttx bitrate: 72.2 MBit/s\n";
        assert_eq!(parse_iw_link(out), (Some("Home Net".into()), Some(-61)));
        assert_eq!(parse_iw_link("Not connected.\n"), (None, None));
        assert_eq!(parse_iw_link(""), (None, None));
    }

    #[test]
    fn ipv4() {
        let out = "1: lo: <LOOPBACK,UP,LOWER_UP> mtu 65536 qdisc noqueue state UNKNOWN qlen 1000\n    inet 127.0.0.1/8 scope host lo\n       valid_lft forever preferred_lft forever\n3: usb0: <BROADCAST,MULTICAST,UP,LOWER_UP> mtu 1500 qdisc pfifo_fast state UP qlen 1000\n    inet 172.16.42.1/24 scope global usb0\n       valid_lft forever preferred_lft forever\n4: mt6625_0: <BROADCAST,MULTICAST,UP> mtu 1500\n    inet 192.168.1.23/24 brd 192.168.1.255 scope global mt6625_0\n";
        assert_eq!(parse_ipv4(out, "usb0").as_deref(), Some("172.16.42.1"));
        assert_eq!(parse_ipv4(out, "mt6625_0").as_deref(), Some("192.168.1.23"));
        assert_eq!(parse_ipv4(out, "lo").as_deref(), Some("127.0.0.1"));
        assert_eq!(parse_ipv4(out, "eth0"), None);
        assert_eq!(parse_ipv4(out, "usb"), None);
    }

    #[test]
    fn cmdline_slot() {
        assert_eq!(parse_cmdline_slot("tb.slot=b console=tty0 clk_ignore_unused").as_deref(), Some("b"));
        assert_eq!(parse_cmdline_slot("console=tty0 tb.slot=cache").as_deref(), Some("cache"));
        assert_eq!(parse_cmdline_slot("console=tty0 xtb.slot=a"), None);
        assert_eq!(parse_cmdline_slot("tb.slot= console=tty0"), None);
    }

    #[test]
    fn buildinfo_and_tbstate() {
        let bi = "version=ae95761\nbuilt=2026-11-23T12:24Z\nkernel_src=046883c0c2b9\nsha256 boot.img 64b4\n";
        assert_eq!(parse_kv(bi, "version").as_deref(), Some("ae95761"));
        assert_eq!(parse_kv(bi, "built").as_deref(), Some("2026-11-23T12:24Z"));
        assert_eq!(parse_kv(bi, "kernel"), None);
        assert_eq!(parse_kv("", "version"), None);
        let tb = "state=ok\nstage=healthy\nslot=b\nlast_good_slot=a\n";
        assert_eq!(fallback_slot(tb, "b").as_deref(), Some("a"));
        assert_eq!(fallback_slot(tb, "a"), None);
        assert_eq!(fallback_slot("last_good_slot=none\n", "b"), None);
        assert_eq!(fallback_slot("state=ok\n", "b"), None);
    }

    #[test]
    fn uptime_and_meminfo() {
        assert_eq!(format_uptime(59), "0m");
        assert_eq!(format_uptime(19204), "5h 20m");
        assert_eq!(format_uptime(3 * 86400 + 4 * 3600 + 5), "3d 4h");
        let m = "MemTotal:         881768 kB\nMemFree:          635872 kB\nMemAvailable:     679928 kB\n";
        assert_eq!(meminfo_kb(m, "MemTotal"), Some(881768));
        assert_eq!(meminfo_kb(m, "MemAvailable"), Some(679928));
        assert_eq!(meminfo_kb(m, "Mem"), None);
    }

    #[test]
    fn pause_deadline() {
        let max = PAUSE_MAX.as_millis() as u64;
        assert_eq!(max, 60_000);
        assert!(!paused_at(0, 5));
        assert!(paused_at(1000 + max, 1000));
        assert!(paused_at(1000 + max, 1000 + max - 1));
        assert!(!paused_at(1000 + max, 1000 + max));
        assert!(!paused_at(1000 + max, 1000 + max + 30_000));
    }

    #[test]
    fn settings_roundtrip() {
        assert_eq!(Settings::parse("garbage"), Settings::default());
        let s = Settings { dim_follow_host: true, charge_limit: false, brightness: Some(180) };
        assert_eq!(Settings::parse(&s.to_json()), s);
        assert_eq!(Settings::parse(r#"{"brightness":999}"#).brightness, None);
    }
}
