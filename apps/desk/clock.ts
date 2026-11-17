// One shared clock for decorative motion. On this tablet every frame that
// changes pixels costs ~5.5 ms of present overhead in the Android host (lock +
// copy + post), however small the change — a lone 2 px dot moving every frame
// measured 6.4 ms/tick vs 3.0 ms at every other frame. So all ambient motion
// (spinning shapes, ridges, traces, runners, the wave) steps at 30 Hz on the
// SAME even frames, leaving odd frames idle. Touch, swipes and springs still
// run at 60 Hz.

import { onFrame } from "@pocketjs/framework/lifecycle";

let frame = 0;

/** Call once from the root component, before any pane mounts. */
export function useDecorClock(): void {
  onFrame(() => {
    frame++;
  });
}

/** True on frames where decorative motion may repaint (30 Hz). */
export const decorFrame = (): boolean => (frame & 1) === 0;

/** Frames per decorative step, for scaling per-step speeds. */
export const DECOR_STEP = 2;

/** True every `frames` frames (a multiple of DECOR_STEP), on one global phase,
 *  so slower decorations on a pane repaint in the same posted frame. */
export const decorPhase = (frames: number, offset = 0): boolean => frame % frames === offset;

/** Smallest rotation (degrees) that moves a `size` px shape's corner ≥ 1 px;
 *  smaller steps are invisible and not worth a repaint. */
export const minVisibleDeg = (size: number): number => Math.min(8, 57.3 / Math.max(1, size * 0.5));
