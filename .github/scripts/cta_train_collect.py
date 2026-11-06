#!/usr/bin/env python3
"""CTA Train Tracker + Bus Tracker -> Chicago live-data/vehicles.json.

Runs in GitHub Actions (Fresh Start repo). Reads the CTA keys from the
CTA_TRAIN_KEY / CTA_BUS_KEY environment variables (repo Actions
secrets); the keys never appear in any file, log, or commit. Writes
the static vehicles envelope the staged Chicago page consumes,
mirroring the Detroit vehicles.json conventions (generated_at / count
/ vehicles / sources), with per-leg source blocks so the page can
report each feed's state honestly.

Train leg: Train Tracker ttpositions, one request for all 8 'L'
routes. CTA route codes arrive lowercase in the JSON response and are
mapped to the page's GTFS route ids (Red, Blue, Brn, G, Org, P, Pink,
Y). Vehicle ids are 'train-<run number>'.

Bus leg: Bus Tracker API v3 getvehicles, batched 10 routes per
request (the API's per-request route cap). The bus route list is read
from the checked-out cities/chicago/cta-routes-3d.json (group
'cta-bus') so the collector's id space always matches the page's.
ok = at least one batch succeeded; batches_ok / batches_failed are
reported in the source block.
"""
import json
import os
import sys
import urllib.request
from datetime import datetime, timezone
from zoneinfo import ZoneInfo

TRAIN_API_URL = "http://lapi.transitchicago.com/api/1.0/ttpositions.aspx"
BUS_API_URL = "http://www.ctabustracker.com/bustime/api/v3/getvehicles"
TRAIN_ROUTES = "Red,Blue,Brn,G,Org,P,Pink,Y"
ROUTE_ID_MAP = {
    "red": "Red", "blue": "Blue", "brn": "Brn", "g": "G",
    "org": "Org", "p": "P", "pink": "Pink", "y": "Y",
}
BUS_BATCH = 10
CHICAGO_TZ = ZoneInfo("America/Chicago")


def now_iso():
    n = datetime.now(timezone.utc)
    return n.strftime("%Y-%m-%dT%H:%M:%S.") + f"{n.microsecond // 1000:03d}Z"


def chicago_local_to_utc_iso(ts, fmt):
    """CTA timestamps are America/Chicago local."""
    try:
        dt = datetime.strptime(ts, fmt).replace(tzinfo=CHICAGO_TZ)
        return dt.astimezone(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")
    except Exception:
        return None


def fetch_json(url):
    req = urllib.request.Request(url, headers={"User-Agent": "daa-chicago-live-collector"})
    with urllib.request.urlopen(req, timeout=25) as r:
        return json.loads(r.read().decode("utf-8"))


def train_leg(key, gen):
    block = {"ok": False, "configured": bool(key), "vehicles": 0}
    vehicles = []
    if not key:
        return block, vehicles
    try:
        data = fetch_json(f"{TRAIN_API_URL}?key={key}&rt={TRAIN_ROUTES}&outputType=JSON")
        ctatt = data.get("ctatt") or {}
        if str(ctatt.get("errCd")) != "0":
            print(f"train api errCd={ctatt.get('errCd')} errNm={ctatt.get('errNm')}", file=sys.stderr)
            return block, vehicles
        block["ok"] = True
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
                v["updated_at"] = chicago_local_to_utc_iso(t.get("prdt") or "", "%Y-%m-%dT%H:%M:%S") or gen
                vehicles.append(v)
    except Exception as e:
        print(f"train fetch failed: {e}", file=sys.stderr)
        block["ok"] = False
        vehicles = []
    block["vehicles"] = len(vehicles)
    return block, vehicles


def bus_routes(root):
    path = os.path.join(root, "cities", "chicago", "cta-routes-3d.json")
    with open(path, encoding="utf-8") as f:
        data = json.load(f)
    return [r["id"] for r in data.get("routes") or [] if r.get("group") == "cta-bus"]


def bus_leg(key, gen, root):
    block = {"ok": False, "configured": bool(key), "vehicles": 0,
             "batches_ok": 0, "batches_failed": 0}
    vehicles = []
    if not key:
        return block, vehicles
    try:
        routes = bus_routes(root)
    except Exception as e:
        print(f"bus route list unreadable: {e}", file=sys.stderr)
        return block, vehicles
    for i in range(0, len(routes), BUS_BATCH):
        batch = routes[i:i + BUS_BATCH]
        try:
            data = fetch_json(f"{BUS_API_URL}?key={key}&rt={','.join(batch)}&format=json")
            resp = data.get("bustime-response")
            if resp is None:
                raise ValueError("no bustime-response")
            block["batches_ok"] += 1
            for t in resp.get("vehicle") or []:
                lat, lon = t.get("lat"), t.get("lon")
                if lat in (None, "") or lon in (None, ""):
                    continue
                v = {
                    "agency": "cta",
                    "route_id": str(t.get("rt")),
                    "vehicle_id": str(t.get("vid")),
                    "lat": float(lat),
                    "lon": float(lon),
                }
                hdg = t.get("hdg")
                if hdg not in (None, ""):
                    try:
                        v["bearing"] = int(float(hdg))
                    except (TypeError, ValueError):
                        pass
                if t.get("des"):
                    v["destination"] = t["des"]
                v["updated_at"] = chicago_local_to_utc_iso(t.get("tmstmp") or "", "%Y%m%d %H:%M") or gen
                vehicles.append(v)
        except Exception as e:
            print(f"bus batch {batch[0]}.. failed: {e}", file=sys.stderr)
            block["batches_failed"] += 1
    block["ok"] = block["batches_ok"] > 0
    if not block["ok"]:
        vehicles = []
    block["vehicles"] = len(vehicles)
    return block, vehicles


def main():
    root = os.environ.get("GITHUB_WORKSPACE") or os.path.join(
        os.path.dirname(os.path.abspath(__file__)), "..", "..")
    gen = now_iso()
    trains_block, train_vehicles = train_leg(os.environ.get("CTA_TRAIN_KEY", "").strip(), gen)
    buses_block, bus_vehicles = bus_leg(os.environ.get("CTA_BUS_KEY", "").strip(), gen, root)
    vehicles = train_vehicles + bus_vehicles
    vehicles.sort(key=lambda v: (v["route_id"], v["vehicle_id"]))
    envelope = {
        "generated_at": gen,
        "count": len(vehicles),
        "vehicles": vehicles,
        "sources": {
            "cta": {
                "ok": bool(trains_block["ok"] or buses_block["ok"]),
                "configured": bool(trains_block["configured"] or buses_block["configured"]),
                "at": gen,
                "vehicles": len(vehicles),
                "trains": trains_block,
                "buses": buses_block,
            }
        },
    }
    out = os.path.join(root, "cities", "chicago", "live-data", "vehicles.json")
    with open(out, "w", encoding="utf-8") as f:
        json.dump(envelope, f, separators=(",", ":"))
        f.write("\n")
    print(f"wrote {out}: count={envelope['count']} "
          f"trains ok={trains_block['ok']} n={trains_block['vehicles']} | "
          f"buses ok={buses_block['ok']} n={buses_block['vehicles']} "
          f"batches {buses_block['batches_ok']}/{buses_block['batches_ok'] + buses_block['batches_failed']}")


if __name__ == "__main__":
    main()
