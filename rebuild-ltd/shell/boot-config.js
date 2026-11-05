/**
 * LTD rebuild — boot configuration (shell layer, M1).
 *
 * Loaded by the generated shell as a classic script BEFORE the
 * application module. Sets the live-data seam (R-07): the
 * published payloads the app polls live under
 * window.FORGE_LIVE_DATA_URL.
 *
 * This assignment lives in an external file because the shell's
 * Content-Security-Policy runs script-src 'self', which blocks
 * inline scripts (DV-T10-2: the inline form never executed, so
 * createApp threw at its liveBase check and the placed page
 * showed the fatal boot notice). The bootstrap at the end of
 * src/app.mjs also falls back to this same URL when the seam is
 * undefined, so a missing config script can never brick the
 * boot on its own.
 */
window.FORGE_LIVE_DATA_URL = "https://www.detroitautomationacademy.com/live-data";
