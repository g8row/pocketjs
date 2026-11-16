//! Android input → PocketJS input state.
//!
//! Multi-touch maps to the framework's packed touch wire format
//! (`(id<<18)|(y<<9)|x`, framework/src/touch.ts) in LOGICAL viewport px.
//! Hardware keys (volume, back, a USB/BT gamepad or keyboard) map to the spec
//! BTN bitmask.

use android_activity::input::{InputEvent, KeyAction, Keycode, MotionAction};
use pocketjs_core::spec::{btn, ANALOG_CENTER};

use crate::geometry::Geometry;

const MAX_TOUCHES: usize = 10;

#[derive(Default)]
pub struct Input {
    geo: Option<Geometry>,
    buttons: u32,
    /// (pointer id, logical x, logical y) for every finger currently down.
    touches: Vec<(u32, u32, u32)>,
    /// Contacts that went down AND up between two frames: delivered for one
    /// frame anyway so a quick tap is never lost to the 16 ms tick.
    flicks: Vec<(u32, u32, u32)>,
    /// Pointer ids the guest has seen in at least one snapshot.
    seen: Vec<u32>,
}

impl Input {
    pub fn set_geometry(&mut self, geo: Geometry) {
        self.geo = Some(geo);
        self.touches.clear();
    }

    /// Returns true when the event was consumed.
    pub fn on_event(&mut self, ev: &InputEvent) -> bool {
        match ev {
            InputEvent::MotionEvent(m) => {
                let Some(geo) = self.geo else { return false };
                match m.action() {
                    MotionAction::Up | MotionAction::Cancel => {
                        let lifted: Vec<_> = self.touches.drain(..).collect();
                        for t in lifted {
                            self.lift(t);
                        }
                    }
                    MotionAction::PointerUp => {
                        let id = m.pointer_at_index(m.pointer_index()).pointer_id() as u32;
                        if let Some(i) = self.touches.iter().position(|t| t.0 == id) {
                            let t = self.touches.remove(i);
                            self.lift(t);
                        }
                    }
                    _ => {
                        // Down / PointerDown / Move: resnapshot every pointer.
                        self.touches.clear();
                        for p in m.pointers().take(MAX_TOUCHES) {
                            let (x, y) = geo.window_to_logical(p.x(), p.y());
                            self.touches.push((p.pointer_id() as u32, x, y));
                        }
                    }
                }
                true
            }
            InputEvent::KeyEvent(k) => {
                let bit = key_bit(k.key_code());
                if bit == 0 {
                    return false;
                }
                match k.action() {
                    KeyAction::Down => self.buttons |= bit,
                    KeyAction::Up => self.buttons &= !bit,
                    _ => {}
                }
                true
            }
            _ => false,
        }
    }

    fn lift(&mut self, t: (u32, u32, u32)) {
        if !self.seen.contains(&t.0) {
            self.flicks.push(t);
        }
        self.seen.retain(|&id| id != t.0);
    }

    /// (buttons, analog, packed touches) for `Guest::frame_with_touches`.
    /// Call exactly once per guest frame.
    pub fn snapshot(&mut self) -> (u32, u32, Vec<u32>) {
        let mut all: Vec<(u32, u32, u32)> = self.touches.clone();
        all.extend(self.flicks.drain(..));
        self.seen = self.touches.iter().map(|t| t.0).collect();
        let touches = all.iter().map(|&(id, x, y)| pack_touch(id, x, y)).collect();
        (self.buttons, ANALOG_CENTER, touches)
    }
}

/// framework/src/touch.ts `__packTouch`: `(id<<18)|(y<<9)|x`.
fn pack_touch(id: u32, x: u32, y: u32) -> u32 {
    ((id & 0xff) << 18) | ((y & 0x1ff) << 9) | (x & 0x1ff)
}

fn key_bit(code: Keycode) -> u32 {
    match code {
        Keycode::DpadUp | Keycode::W => btn::UP,
        Keycode::DpadDown | Keycode::S => btn::DOWN,
        Keycode::DpadLeft | Keycode::A => btn::LEFT,
        Keycode::DpadRight | Keycode::D => btn::RIGHT,
        Keycode::DpadCenter | Keycode::Enter | Keycode::ButtonA => btn::CROSS,
        Keycode::Back | Keycode::Escape | Keycode::ButtonB => btn::CIRCLE,
        Keycode::ButtonX => btn::SQUARE,
        Keycode::ButtonY => btn::TRIANGLE,
        Keycode::ButtonStart | Keycode::Menu => btn::START,
        Keycode::ButtonSelect => btn::SELECT,
        Keycode::VolumeUp | Keycode::ButtonR1 => btn::RTRIGGER,
        Keycode::VolumeDown | Keycode::ButtonL1 => btn::LTRIGGER,
        _ => 0,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn touch_packs_id_y_x() {
        assert_eq!(pack_touch(0, 10, 20), (20 << 9) | 10);
        assert_eq!(pack_touch(3, 1, 2), (3 << 18) | (2 << 9) | 1);
    }
}
