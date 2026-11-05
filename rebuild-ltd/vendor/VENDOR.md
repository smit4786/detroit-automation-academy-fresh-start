# Vendor slot — LTD clean-room rebuild

Third-party builds fetched from their official upstream source for
local verification of the renderer adapter (Tranche T3, 2026-11-04).
Nothing in this directory comes from the old codebase.

**Owner's ruling (T9 gate, decided 2026-11-04 17:37 EST): the
shipped form is this vendored, pinned file.** No CDN import, no
CSP exception. The renderer stays structured against the adapter
interface (src/gl-three.mjs is the sole vendor importer), so a
future re-pin is a deliberate swap of this slot plus a new row
below.

| File | Library | Version | Source URL | Bytes | SHA-256 |
|---|---|---|---|---|---|
| three.module.min.js | three.js (MIT) | 0.160.0 (REVISION "160" in file) | https://cdn.jsdelivr.net/npm/three@0.160.0/build/three.module.min.js | 670,681 | 3e690ac7d180b0aadf0891bea39eec643e29e2d3e75c99b18689518665f69ba6 |

Fetched 2026-11-04 via the estate proxy. OrbitControls was NOT
fetched: the rebuild's camera rig is fresh code behind the adapter
interface (src/camera.mjs), so no controls build is needed for
verification; if the owner rules the shipped form carries vendor
controls, the pinned file joins this slot at that gate with its own
row here.
