// When the stage draws (the loop in stage.ts): every animation frame while something that must look
// smooth is moving, and on demand otherwise.
//
// Why. The stage paints two mirror-sized canvases over the reflection. Redrawn on every refresh, they
// keep Chromium's frame pipeline full, and it then holds each of the page's frames two or three
// refreshes before they show. Measured in the desktop app on an integrated GPU at 3840x2160: the trail
// reached the screen 49 to 66 ms after the camera caught the tip in a normal window, and 112 to 133 ms
// in full screen, where the GPU could not keep up. Drawing only when there is something new left the
// other refreshes idle, and Chromium then showed each drawing at once: 31 to 32 ms in the window (the
// reflection itself 15 to 16 ms instead of 16 to 29), and 65 to 78 ms in full screen with a 30 fps
// camera. Drawn that way all the time, effects would move at the camera's frame rate; so they do not:
// whatever must look smooth keeps every frame.
//
// The rule:
//  - busy (a spell's effect starting or running, particles, bolts, shields, creatures, a reveal, a
//    shake, text on the glass, light changing, ink settling or dripping, a prop changing, the practice
//    guide, a replay, a steered prop, a clip being recorded): draw every frame, as before;
//  - otherwise (tracing, or waiting): draw on the first frame after a new tip, which puts the trail on
//    the glass as early as the browser allows, and at least AMBIENT_FPS times a second, for what moves
//    of itself (the candle's flicker, a held light, drying ink, the tip's glow).
// Frames that do not draw still advance the stage's time, so nothing moves by a different amount.
// Light levels are stepped on their own clock either way, so the flash limits (Section 10.6) hold.

/** What moves of itself while nothing is busy is drawn at least this often. */
export const AMBIENT_FPS = 30;

/** A frame this close to the ambient interval draws: refreshes come a little early or late, and at
 *  60 Hz the second frame after a drawing should draw, not the third. */
const SLACK_MS = 4;

export const AMBIENT_FRAME_MS = 1000 / AMBIENT_FPS - SLACK_MS;

export interface PaceInput {
  /** Something that must look smooth is moving (StageCore.busy). */
  busy: boolean;
  /** A tip sample came since the last drawing. */
  newTip: boolean;
  /** Milliseconds since the last drawing. */
  sinceDraw: number;
}

/** Whether this animation frame draws. */
export function drawThisFrame(p: PaceInput): boolean {
  return p.busy || p.newTip || !(p.sinceDraw < AMBIENT_FRAME_MS);
}
