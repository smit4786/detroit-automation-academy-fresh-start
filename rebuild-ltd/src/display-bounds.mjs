/**
 * LTD rebuild — DisplayBounds (Tranche T3, P-11).
 *
 * The safe frame is computed from the chrome rectangles actually
 * on screen (control bar, tools rail, open panels): the frame is
 * the viewport inset by the deepest chrome intrusion on each edge.
 * Selections frame at the safe-frame center, so a framed subject is
 * never under a card. The measurement readout rides `?dbdebug=1`.
 */

export function computeSafeFrame(viewport, chromeRects) {
  const inset = { left: 0, right: 0, top: 0, bottom: 0 };
  for (const r of chromeRects) {
    if (r.x <= 0) inset.left = Math.max(inset.left, r.x + r.width);
    if (r.x + r.width >= viewport.width) inset.right = Math.max(inset.right, viewport.width - r.x);
    if (r.y <= 0) inset.top = Math.max(inset.top, r.y + r.height);
    if (r.y + r.height >= viewport.height) inset.bottom = Math.max(inset.bottom, viewport.height - r.y);
  }
  const frame = {
    x: inset.left,
    y: inset.top,
    width: Math.max(0, viewport.width - inset.left - inset.right),
    height: Math.max(0, viewport.height - inset.top - inset.bottom),
  };
  frame.center = { x: frame.x + frame.width / 2, y: frame.y + frame.height / 2 };
  return frame;
}

/** Screen-space offset (px) from viewport center to safe-frame center. */
export function framingOffset(viewport, frame) {
  return {
    dx: frame.center.x - viewport.width / 2,
    dy: frame.center.y - viewport.height / 2,
  };
}

export function dbDebugEnabled(search) {
  return new URLSearchParams(search).get("dbdebug") === "1";
}
