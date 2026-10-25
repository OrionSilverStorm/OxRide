"""Benchmark: is OxRide actually better for cyclists than the shortest route and Google?

    python benchmark.py               # 10 fixed Oxford trips, ours vs shortest (+ Google if GOOGLE_MAPS_API_KEY)
    python benchmark.py --night       # find trips where the night route differs most (demo candidates)

Every route is described with the same numbers as the /debug page. Weather is fixed
(dry, no wind, not rush hour) so results don't change from run to run.
"""

import argparse
import itertools
import statistics

import debug
import routing

PLACES = {
    "Station": (51.7535, -1.2700),
    "Radcliffe Camera": (51.7534, -1.2540),
    "Carfax": (51.7518, -1.2578),
    "Summertown": (51.7768, -1.2643),
    "Jericho": (51.7590, -1.2650),
    "Brookes Headington": (51.7550, -1.2240),
    "Headington shops": (51.7600, -1.2135),
    "John Radcliffe": (51.7637, -1.2193),
    "Templars Square": (51.7345, -1.2100),
    "Iffley village": (51.7290, -1.2380),
    "Iffley Road sports": (51.7470, -1.2400),
    "Old Marston": (51.7740, -1.2400),
    "Wolvercote": (51.7800, -1.2850),
    "Science Area": (51.7590, -1.2560),
    "Rose Hill": (51.7270, -1.2240),
    "Westgate": (51.7500, -1.2600),
    "Osney": (51.7510, -1.2780),
    "Wolfson College": (51.7760, -1.2560),
}

TRIPS = [
    ("Station", "Radcliffe Camera"),
    ("Summertown", "Carfax"),
    ("Jericho", "Brookes Headington"),
    ("Templars Square", "Radcliffe Camera"),
    ("Iffley village", "Station"),
    ("Old Marston", "John Radcliffe"),
    ("Wolvercote", "Science Area"),
    ("Rose Hill", "Westgate"),
    ("Headington shops", "Summertown"),
    ("Osney", "Iffley Road sports"),
]

DAY = dict(debug.NEUTRAL_CTX)
NIGHT = {**debug.NEUTRAL_CTX, "dark": True}

COLUMNS = [  # (summary key, header, format)
    ("distance_m", "km", lambda v: f"{v / 1000:.2f}"),
    ("eta_min", "min", lambda v: f"{v}"),
    ("climb_m", "climb m", lambda v: f"{v}"),
    ("main_road_share", "main rd", lambda v: f"{v:.0%}"),
    ("cycleway_share", "cycleway", lambda v: f"{v:.0%}"),
    ("lit_share", "lit", lambda v: f"{v:.0%}"),
    ("turns", "turns", lambda v: f"{v}"),
]


def route(start, end, profile_name, ctx):
    s, _ = debug.nearest_node_fast(*start)
    e, _ = debug.nearest_node_fast(*end)
    profile = routing.PROFILES[profile_name] if isinstance(profile_name, str) else profile_name
    path, _, _ = debug.traced_astar(s, e, profile, ctx)
    return path, s, e


def describe(path, ctx, eta_profile="regular"):
    return debug.describe_path(path, routing.PROFILES[eta_profile], ctx, eta_profile)


def benchmark(profiles, use_google):
    rows = []  # (trip, label, summary)
    for a, b in TRIPS:
        start, end = PLACES[a], PLACES[b]
        trip = f"{a} → {b}"
        sp, s, e = route(start, end, debug.SHORTEST_PROFILE, DAY)
        rows.append((trip, "shortest", describe(sp, DAY)["summary"]))
        for p in profiles:
            path, _, _ = route(start, end, p, DAY)
            rows.append((trip, p, describe(path, DAY, p)["summary"]))
        if use_google:
            g, err = debug.google_route(start, end)
            if g:
                gp = debug.match_polyline(g["points"], s, e)
                summary = describe(gp, DAY)["summary"]
                summary["eta_min"] = g["duration_min"]  # Google's own estimate
                rows.append((trip, "google", summary))
            else:
                print(f"  Google skipped for {trip}: {err}")
    return rows


def print_table(rows):
    labels = list(dict.fromkeys(label for _, label, _ in rows))
    head = "| trip | route | " + " | ".join(h for _, h, _ in COLUMNS) + " |"
    print(head)
    print("|" + "---|" * (len(COLUMNS) + 2))
    last = None
    for trip, label, s in rows:
        cells = [fmt(s[k]) if s[k] is not None else "–" for k, _, fmt in COLUMNS]
        print(f"| {trip if trip != last else ''} | {label} | " + " | ".join(cells) + " |")
        last = trip

    print("\n**Averages over all trips**\n")
    print("| route | " + " | ".join(h for _, h, _ in COLUMNS) + " |")
    print("|" + "---|" * (len(COLUMNS) + 1))
    for label in labels:
        ss = [s for _, l, s in rows if l == label]
        cells = []
        for k, _, fmt in COLUMNS:
            vals = [s[k] for s in ss if s[k] is not None]
            v = statistics.mean(vals) if vals else None
            cells.append("–" if v is None else fmt(round(v, 3) if k.endswith("share") else round(v, 1)))
        print(f"| {label} | " + " | ".join(cells) + " |")


def night_candidates(profile, top):
    # Find trips where the night route (time_model's darkness penalty) moves the most.
    if True:
        found = []
        for a, b in itertools.permutations(PLACES, 2):
            day, _, _ = route(PLACES[a], PLACES[b], profile, DAY)
            night, _, _ = route(PLACES[a], PLACES[b], profile, NIGHT)
            if not day or not night or day == night:
                continue
            d = describe(day, DAY, profile)["summary"]
            n = describe(night, NIGHT, profile)["summary"]
            day_edges = set(zip(day, day[1:]))
            moved = sum(routing.cheapest_edge(routing.GRAPH, u, v, routing.PROFILES[profile], NIGHT)[0]["length"]
                        for u, v in zip(night, night[1:]) if (u, v) not in day_edges)
            share_moved = moved / max(n["distance_m"], 1)
            detour = n["distance_m"] / max(d["distance_m"], 1)
            if detour < 1.35:
                found.append((share_moved * (n["lit_share"] - d["lit_share"]), a, b, share_moved, detour, d, n))
        found.sort(reverse=True)
        print(f"Trips where the night route changes most ({profile})\n")
        print("| trip | route moved | extra distance | lit by day → night |")
        print("|---|---|---|---|")
        for _, a, b, moved, detour, d, n in found[:top]:
            print(f"| {a} → {b} | {moved:.0%} | {detour - 1:+.0%} | {d['lit_share']:.0%} → {n['lit_share']:.0%} |")


if __name__ == "__main__":
    ap = argparse.ArgumentParser()
    ap.add_argument("--night", action="store_true", help="find demo trips for the day/night switch")
    ap.add_argument("--profile", default="regular")
    ap.add_argument("--no-google", action="store_true")
    ap.add_argument("--top", type=int, default=8)
    args = ap.parse_args()

    import os
    routing.load_graph(os.path.join(os.path.dirname(os.path.abspath(__file__)), "oxford_graph.pkl"))
    if args.night:
        night_candidates(args.profile, args.top)
    else:
        import os
        use_google = bool(os.environ.get("GOOGLE_MAPS_API_KEY")) and not args.no_google
        if not use_google:
            print("(No GOOGLE_MAPS_API_KEY: comparing against the shortest route only.)\n")
        print_table(benchmark(["regular", "chill"], use_google))
