// Horizontal swipe pager. A finger that travels > 10 px mostly sideways claims
// the gesture (and disarms the tap under it); the track follows the finger
// 1:1 via direct jumps, then springs to the nearest page on release, biased
// by flick velocity. Pages sit side by side in one flex row; the core never
// relayouts during a swipe — only translateX moves.

import { createSignal, type Accessor, type JSX } from "solid-js";
import { View, type NodeMirror } from "@pocketjs/framework/components";
import { onFrame } from "@pocketjs/framework/lifecycle";
import { jump, spring } from "@pocketjs/framework/animation";
import { cancelTouchTap, touches } from "@pocketjs/framework/input";

/** Who owns the current touch gesture: "" (nobody yet), "pager" (a sideways
 *  swipe) or "scroll" (a vertical drag in a Scroller). The first to claim it
 *  keeps it until the finger lifts, so a scroll never turns into a swipe. */
export const gesture = { owner: "" };

export function createPager(count: number, width: number) {
  const [page, setPage] = createSignal(0);
  const [isDragging, setDragging] = createSignal(false);
  let track: NodeMirror | undefined;
  let start: { x: number; y: number; t: number } | null = null;
  let dragging = false;
  let lastX = 0;
  let lastT = 0;
  let vel = 0; // px per ms, smoothed
  let frame = 0;

  const go = (p: number) => {
    const target = Math.max(0, Math.min(count - 1, p));
    setPage(target);
    if (track) spring(track, "translateX", -target * width);
  };

  onFrame(() => {
    frame++;
    const t = touches()[0];
    if (t) {
      if (!start) {
        start = { x: t.x, y: t.y, t: frame };
        lastX = t.x;
        lastT = frame;
        vel = 0;
        return;
      }
      const dx = t.x - start.x;
      const dy = t.y - start.y;
      if (!dragging && gesture.owner === "" && Math.abs(dx) > 10 && Math.abs(dx) > Math.abs(dy) * 1.2) {
        dragging = true;
        gesture.owner = "pager";
        setDragging(true);
        cancelTouchTap();
      }
      if (dragging) {
        const dt = Math.max(1, frame - lastT);
        vel = vel * 0.6 + ((t.x - lastX) / dt) * 0.4; // px per frame
        lastX = t.x;
        lastT = frame;
        // Rubber-band past the ends.
        let off = -page() * width + dx;
        const min = -(count - 1) * width;
        if (off > 0) off *= 0.35;
        if (off < min) off = min + (off - min) * 0.35;
        if (track) jump(track, "translateX", off);
      }
      return;
    }
    if (start && dragging) {
      const dx = lastX - start.x;
      let p = page();
      if (dx < -width * 0.22 || vel < -6) p++;
      else if (dx > width * 0.22 || vel > 6) p--;
      go(p);
    }
    start = null;
    gesture.owner = "";
    if (dragging) setDragging(false);
    dragging = false;
  });

  function Track(props: { children: JSX.Element }) {
    return (
      <View class="h-full flex-row" style={{ width: width * count }} ref={(n: NodeMirror) => (track = n)}>
        {props.children}
      </View>
    );
  }

  return { page: page as Accessor<number>, dragging: isDragging as Accessor<boolean>, go, Track };
}
