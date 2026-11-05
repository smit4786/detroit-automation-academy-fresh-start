/**
 * LTD rebuild — fullscreen contract (Tranche T3, P-14 / R-30).
 *
 * Two states with honest labels: native fullscreen where the
 * platform grants it, "expanded view" where it does not. The label
 * is written ONLY by change events — never optimistically at click
 * time. While fullscreen is active the fs-lock body class is on:
 * the shell's CSS locks document scroll and sets touch-action none
 * on non-scrollable chrome, pan-y on genuinely scrollable panels —
 * never none on an ancestor of a scrollable panel (iOS Safari
 * exits fullscreen on an unconsumed downward swipe, 2026-10-05).
 *
 * DOM access goes through the injected document so tests drive it
 * with a stub.
 */

export function createFullscreen({ doc, stage, onLabel = () => {} }) {
  let mode = "windowed"; // windowed | fullscreen | expanded

  function currentLabel() {
    if (mode === "fullscreen") return "Fullscreen";
    if (mode === "expanded") return "Expanded view";
    return "Expand";
  }

  function applyFsLock() {
    const active = mode !== "windowed";
    doc.body.classList.toggle("fs-lock", active);
    stage.classList.toggle("is-expanded", mode === "expanded");
  }

  function handleChange() {
    // The only place the label is written.
    if (doc.fullscreenElement) mode = "fullscreen";
    else mode = stage.classList.contains("is-expanded") ? "expanded" : "windowed";
    applyFsLock();
    onLabel(currentLabel(), mode);
  }

  async function toggle() {
    if (mode === "fullscreen") {
      await doc.exitFullscreen();
      return mode;
    }
    if (mode === "expanded") {
      mode = "windowed";
      applyFsLock();
      onLabel(currentLabel(), mode);
      return mode;
    }
    if (typeof stage.requestFullscreen === "function") {
      try {
        await stage.requestFullscreen();
        // Label waits for the change event; nothing is written here.
        return mode;
      } catch {
        mode = "expanded";
        applyFsLock();
        onLabel(currentLabel(), mode);
        return mode;
      }
    }
    mode = "expanded";
    applyFsLock();
    onLabel(currentLabel(), mode);
    return mode;
  }

  return {
    toggle,
    handleChange,
    currentLabel,
    get mode() { return mode; },
  };
}
