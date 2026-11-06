#!/usr/bin/env python3
"""CTA Train Tracker -> Chicago live-data/vehicles.json collector.

Runs in GitHub Actions (Fresh Start repo). Reads the Train Tracker key
from the CTA_TRAIN_KEY environment variable (a repo Actions secret);
the key never appears in any file, log, or commit. Writes the static
vehicles envelope the staged Chicago page consumes, mirroring the
Detroit vehicles.json conventions (generated_at / count / vehicles /
sources). Trains only: the bus leg reports configured:false until the
CTA Bus Tracker key is connected.

API: CTA Train Tracker ttpositions, one request for all 8 'L' routes.
CTA route codes in the JSON response arrive lowercase; they are mapped
to the page's GTFS route ids (Red, Blue, Brn, G, Org, P, Pink, Y).
"""
import json
import os
import sys
import urllib.request
from datetime import datetime, timezone
from zoneinfo import ZoneInfo

API_URL = "http://lapi.transitchicago.com/api/1.0/ttpositions.aspx"
ROUTES = "Red,Blue,Brn,G,Org,P,Pink,Y"
ROUTE_ID_MAP = {
    "red": "Red", "blue": "Blue", "brn": "Brn", "g": "G",
    "org": "Org", "p": "P", "pink": "Pink", "y": "Y",
}
CHICAGO_TZ = ZoneInfo("America/Chicago")


def now_iso():
    n = datetime.now(timezone.utc)
    return n.strftime("%Y-%m-%dT%H:%M:%S.") + f"{n.microsecond // 1000:03d}Z"


def chicago_local_to_utc_iso(ts):
    """Train Tracker timestamps are America/Chicago local, ISO-shaped."""
    try:
        dt = datetime.strptime(ts, "%Y-%m-%dT%H:%M:%S").replace(tzinfo=CHICAGO_TZ)
        return dt.astimezone(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")
    except Exception:
        return None


def fetch_positions(key):
    url = f"{API_URL}?key={key}&rt={ROUTES}&outputType=JSON"
    req = urllib.request.Request(url, headers={"User-Agent": "daa-chicago-live-collector"})
    with urllib.request.urlopen(req, timeout=25) as r:
        return json.loads(r.read().decode("utf-8"))


def build_envelope():
    gen = now_iso()
    key = os.environ.get("CTA_TRAIN_KEY", "").strip()
    trains_block = {"ok": False, "configured": bool(key), "vehicles": 0}
    buses_block = {"ok": False, "configured": False, "vehicles": 0}
    vehicles = []
    ok = False
    if key:
        try:
            data = fetch_positions(key)
            ctatt = data.get("ctatt") or {}
            if str(ctatt.get("errCd")) == "0":
                ok = True
                for route in ctatt.get("route") or []:
                    route_id = ROUTE_ID_MAP.get(str(route.get("@name", "")).lower())
                    if not route_id:
                        continue
                    trains = route.get("train") or []
                    if isinstance(trains, dict):
                        trains = [trains]
                    for t in trains:
                        lat, lon = t.get("lat"), t.get("lon")
                        if lat in (None, "") or lon in (None, ""):
                            continue
                        v = {
                            "agency": "cta",
                            "route_id": route_id,
                            "vehicle_id": "train-" + str(t.get("rn")),
                            "lat": float(lat),
                            "lon": float(lon),
                        }
                        heading = t.get("heading")
                        if heading not in (None, ""):
                            try:
                                v["bearing"] = int(float(heading))
                            except (TypeError, ValueError):
                                pass
                        if t.get("destNm"):
                            v["destination"] = t["destNm"]
                        upd = chicago_local_to_utc_iso(t.get("prdt") or "")
                        v["updated_at"] = upd or gen
                        vehicles.append(v)
        except Exception as e:  # source down: publish the down state, don't crash
            print(f"train fetch failed: {e}", file=sys.stderr)
            ok = False
            vehicles = []
    vehicles.sort(key=lambda v: (v["route_id"], v["vehicle_id"]))
    trains_block["ok"] = ok
    trains_block["vehicles"] = len(vehicles)
    envelope = {
        "generated_at": gen,
        "count": len(vehicles),
        "vehicles": vehicles,
        "sources": {
            "cta": {
                "ok": ok,
                "configured": bool(key),
                "at": gen,
                "vehicles": len(vehicles),
                "trains": trains_block,
                "buses": buses_block,
            }
        },
    }
    return envelope


def main():
    root = os.environ.get("GITHUB_WORKSPACE") or os.path.join(
        os.path.dirname(os.path.abspath(__file__)), "..", "..")
    out = os.path.join(root, "cities", "chicago", "live-data", "vehicles.json")
    envelope = build_envelope()
    with open(out, "w", encoding="utf-8") as f:
        json.dump(envelope, f, separators=(",", ":"))
        f.write("\n")
    print(f"wrote {out}: count={envelope['count']} ok={envelope['sources']['cta']['ok']} "
          f"configured={envelope['sources']['cta']['configured']}")


if __name__ == "__main__":
    main()
