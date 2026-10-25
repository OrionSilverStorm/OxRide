"use client";

import "leaflet/dist/leaflet.css";
<<<<<<< HEAD
import { useState, useEffect, useMemo } from "react";
=======
import { useState, useEffect, useRef } from "react";
import { useRouter } from "next/navigation";
>>>>>>> bde95d421e2709fbbee14d7c5d4e3ddfbbf96fa3
import {
  MapContainer,
  TileLayer,
  Marker,
  Polyline,
  ZoomControl,
  useMap,
  useMapEvents,
} from "react-leaflet";

import L from "leaflet";
<<<<<<< HEAD
import { getRoute, getNavigation, type NavigationData } from "@/lib/api";
=======
import {
  getBestDeparture,
  getRoute,
  searchPlace,
  type LatLon,
  type RouteResult,
  type VoiceResult,
} from "@/lib/api";
import { DEMO_TRIPS, departureHint, nextAt } from "@/lib/nav";
import { saveTrip } from "@/lib/trip";
import { unlockAudio } from "@/lib/speech";
import { useVoice } from "@/hooks/useVoice";
import RoutePanel from "./RoutePanel";
import VoiceButton from "./VoiceButton";
>>>>>>> bde95d421e2709fbbee14d7c5d4e3ddfbbf96fa3

//define ride types
type Profile = "chill" | "regular" | "fast";
const PROFILES: Profile[] = ["chill", "regular", "fast"];

// Props for UserMarker: the parent's state value + its setter
interface UserMarkerProps {
  pos: L.LatLng | null; // User's position, null until found
  setPos: (p: L.LatLng) => void; // Updates the parent's state
}

// Props for TargetPin: the parent's state value + its setter
interface TargetPinProps {
  target: L.LatLng | null; // Target position, null until the user clicks
  setTarget: (p: L.LatLng) => void; // Updates the parent's state
}

// one Photon result (coordinates are [lon, lat]) for auto search fill
interface Hit {
  geometry: { coordinates: [number, number] };
  properties: { osm_id: number; name?: string; street?: string };
}

//shape of the backend response [ADJUST FOR ACTUAL DATA]
//nav instructions per turn
interface Step {
  instruction: string;
  distance_m: number;
}
//basic trip info
interface Trip {
  route: [number, number][];
  stats: { distance_m: number; duration_s: number };
  steps: Step[];
}

const OXFORD_CENTER: [number, number] = [51.752, -1.2577];
const OXFORD_BOUNDS = L.latLngBounds([51.69, -1.37], [51.82, -1.14]);

const userIcon = L.divIcon({
  className: "",
  html: '<div style="width:16px;height:16px;background:#2563eb;border:3px solid white;border-radius:50%;box-shadow:0 0 4px rgba(0,0,0,.4)"></div>',
  iconSize: [16, 16],
  iconAnchor: [8, 8],
});

// Red dot icon for the target pin, visually distinct from the blue user marker
const targetIcon = L.divIcon({
  className: "", // Remove Leaflet's default white box styling
  html: '<div style="width:16px;height:16px;background:#dc2626;border:3px solid white;border-radius:50%;box-shadow:0 0 4px rgba(0,0,0,.4)"></div>', // Red dot with white border and soft shadow
  iconSize: [16, 16], // Icon dimensions in px
  iconAnchor: [8, 8], // Centre of the dot sits exactly on the clicked point
});

// Green dot for a start point picked on the map (or a demo trip) instead of GPS
const startIcon = L.divIcon({
  className: "",
  html: '<div style="width:16px;height:16px;background:#16a34a;border:3px solid white;border-radius:50%;box-shadow:0 0 4px rgba(0,0,0,.4)"></div>',
  iconSize: [16, 16],
  iconAnchor: [8, 8],
});

// When to leave: the route changes with the time (dark streets at night)
type When = "now" | "noon" | "night";
const WHEN_LABEL: Record<When, string> = { now: "Now", noon: "Noon", night: "Night" };
const departAtFor = (w: When): string | null =>
  w === "now" ? null : nextAt(w === "noon" ? 12 : 22, new Date());

function TargetPin({ target, setTarget }: TargetPinProps) {
  // Attach map event handlers (react-leaflet removes them automatically on unmount)
  useMapEvents({
    click: (e) => setTarget(e.latlng), // Move the pin to wherever the user clicks
  });

  return target && <Marker position={target} icon={targetIcon} />; // Render the pin once placed, nothing before
}

function UserMarker({ pos, setPos }: UserMarkerProps) {
  const map = useMap(); // Get the Leaflet map instance

  useEffect(() => {
    // Runs when the browser returns the user's location
    const onFound = (e: L.LocationEvent) => {
      if (OXFORD_BOUNDS.contains(e.latlng)) {
        // Only continue if inside Oxford bounds
        setPos(e.latlng); // Save position so the marker renders
        map.flyTo(e.latlng, 16); // Animate the map to the user, zoom 16
      }
    };

    // Register the listener, then ask the browser for the location
    map
      .on("locationfound", onFound)
      .locate({ enableHighAccuracy: true, maximumAge: 0, timeout: 20000 });

    // Cleanup on unmount: remove listener and stop locating
    return () => {
      map.off("locationfound", onFound).stopLocate();
    };
  }, [map]); // Re-run only if the map instance changes

  return pos && <Marker position={pos} icon={userIcon} />; // Render marker once we have a valid position, else nothing
}

export default function Map() {
  //start and end location
  const [userPos, setUserPos] = useState<L.LatLng | null>(null); // User's position, null until found
  const [targetPos, setTargetPos] = useState<L.LatLng | null>(null); // Target position, null until the user clicks
  const [result, setResult] = useState<RouteResult | null>(null); // The planned ride (line, stats, steps), null until planned
  const route = result?.route ?? null; // Route as [lat, lon] points
  const [profile, setProfile] = useState<Profile>("regular"); //defaults to regular
<<<<<<< HEAD
  //nav settings
  const [nav, setNav] = useState<NavigationData | null>(null); // Non-null = navigation mode
=======
  const [when, setWhen] = useState<When>("now"); // Departure: now, noon or night
  const [startPick, setStartPick] = useState<L.LatLng | null>(null); // Start picked on the map/demo (overrides GPS)
  const [tapSetsStart, setTapSetsStart] = useState(false); // Next map tap moves the start instead of the destination
  const [hintFor, setHintFor] = useState<{ result: RouteResult; text: string | null } | null>(null); // "Leave in 20 min: ..." for one route
  const [busy, setBusy] = useState(false); // Waiting for /route
  const [error, setError] = useState<string | null>(null); // Shown above the bottom panel
  const [endName, setEndName] = useState<string | undefined>(undefined); // Destination name from search/voice
  const router = useRouter();
  const voice = useVoice();
  const start = startPick ?? userPos; // Where the ride starts
>>>>>>> bde95d421e2709fbbee14d7c5d4e3ddfbbf96fa3
  //////////////////////////////////////////////////////////////////////////

  // Moves the target and removes the stale route line
  const placeTarget = (p: L.LatLng) => {
    setTargetPos(p);
    setResult(null);
    setEndName(undefined);
  };

  // A map tap sets the destination, or the start when "Start: tap map" is on
  const onMapTap = (p: L.LatLng) => {
    if (tapSetsStart) {
      setStartPick(p);
      setTapSetsStart(false);
      setResult(null);
    } else {
      placeTarget(p);
    }
  };

  // Routing
  const lastRequest = useRef(0); // Ignore answers to older requests
  const sendPositions = async (
    p: Profile = profile,
    w: When = when,
    from: L.LatLng | null = start,
    to: L.LatLng | null = targetPos,
  ) => {
    if (!from || !to) return; // Need both points
    const id = ++lastRequest.current;
    setBusy(true);
    setError(null);
    let data;
    try {
      data = await getRoute({
        start: [from.lat, from.lng], // [lat, lon], latitude first
        end: [to.lat, to.lng], // [lat, lon], latitude first
        profile: p, // "fast" | "regular" | "chill"
        depart_at: departAtFor(w) ?? undefined, // left out = leaving now
      });
    } catch (e) {
      console.warn(e); // 404 no route, 503 graph not loaded, or backend down
      if (id === lastRequest.current) setError("Couldn't find a route. Try other points.");
      return;
    } finally {
      if (id === lastRequest.current) setBusy(false);
    }
    if (id !== lastRequest.current) return;
    setResult(data); // Draws the line below and fills the panel
  };

  // "Best time to leave" hint, only when leaving now (TIME theme)
  const hint = hintFor?.result === result && when === "now" ? hintFor.text : null;
  useEffect(() => {
    if (!result || when !== "now" || !start || !targetPos) return;
    let cancelled = false;
    getBestDeparture([start.lat, start.lng], [targetPos.lat, targetPos.lng], profile)
      .then((slots) => !cancelled && setHintFor({ result, text: departureHint(slots, Date.now()) }))
      .catch(() => {}); // no hint is fine
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [result]);

  // Demo trips: set both ends and plan straight away
  const runDemo = (trip: (typeof DEMO_TRIPS)[number]) => {
    const from = L.latLng(trip.start[0], trip.start[1]);
    const to = L.latLng(trip.end[0], trip.end[1]);
    setStartPick(from);
    setTargetPos(to);
    setEndName(trip.name.split(" → ")[1]);
    map?.fitBounds(L.latLngBounds([from, to]), { padding: [80, 80] });
    sendPositions(profile, when, from, to);
  };

  // Start navigating: hand the trip to /navigate
  const startRide = () => {
    if (!result || !start || !targetPos) return;
    unlockAudio(); // a tap: lets the phone play spoken directions later
    saveTrip({
      start: [start.lat, start.lng],
      end: [targetPos.lat, targetPos.lng],
      endName,
      profile,
      departAt: departAtFor(when),
      result,
    });
    router.push("/navigate");
  };

  // What the rider said (Gemini): a new place, a different way, or just an answer
  const onVoice = (r: VoiceResult) => {
    const s = r.settings;
    const p = (s.profile as Profile | undefined) ?? profile;
    if (s.profile) setProfile(p);
    if (r.action === "new_route" && s.end) {
      const to = L.latLng(s.end[0], s.end[1]);
      setTargetPos(to);
      setEndName(s.end_name);
      map?.flyTo(to, 15);
      sendPositions(p, when, start, to);
    } else if (r.action === "reroute") {
      sendPositions(p);
    }
<<<<<<< HEAD
    console.log(data); // { route, elevations_m, stats, steps }
    setRoute(data.route); // Draws the line below
    //set nav bar data
    setNav(
      await getNavigation({
        start: [userPos.lat, userPos.lng],
        end: [targetPos.lat, targetPos.lng],
        profile: p,
      }),
    );
=======
>>>>>>> bde95d421e2709fbbee14d7c5d4e3ddfbbf96fa3
  };

  ///******************************************************************************************** */
  //Search Bar
  const [query, setQuery] = useState(""); // Text in the search box
  const [map, setMap] = useState<L.Map | null>(null); // Lets us fly the map from outside MapContainer

  const search = async () => {
    if (!query.trim()) return; // Ignore empty input
    try {
      // Our backend asks Nominatim (Oxford only, rate-limited, cached)
      const [hit] = await searchPlace(query); // First result, or undefined
      if (!hit) return setError(`Nothing called "${query}" in Oxford`); // Nothing found
      const p = L.latLng(hit.lat, hit.lon);
      if (!OXFORD_BOUNDS.contains(p)) return; // Safety check
      placeTarget(p); // Drop the red pin
      setEndName(hit.name);
      setResults([]);
      map?.flyTo(p, 16); // Move the map there
    } catch (err) {
      console.warn("Search failed:", err); // Network or parse error
    }
  };

  //autocomplete search
  const [results, setResults] = useState<Hit[]>([]); // Suggestions

  // Fetch suggestions as the user types, cancelling stale requests
  useEffect(() => {
    // Too short to search: clear the list and stop (no request sent)
    if (query.length < 2) return setResults([]);
    // Lets us cancel this request if the user types again before it finishes
    const ctrl = new AbortController();
    fetch(
      `https://photon.komoot.io/api/?q=${encodeURIComponent(query)}` + // Search text, escaped for the URL
        `&limit=5` + // Max 5 suggestions
        `&bbox=-1.37,51.69,-1.14,51.82`, // Oxford only: left,bottom,right,top (lon,lat)
      { signal: ctrl.signal }, // Connects the request to the AbortController
    )
      .then((r) => r.json()) // Parse the response body as JSON
      .then((d) => setResults(d.features)) // Photon returns GeoJSON: store the list of features
      .catch(() => {}); // Ignore errors, including the abort from the cleanup below
    // Cleanup: runs before the next effect (next keystroke) or on unmount
    return () => ctrl.abort(); // Cancel the in-flight request so stale results never overwrite newer ones
  }, [query]); // Re-run every time the search text changes

  // Click a suggestion: drop the pin, fly there, close the list
  const pick = (h: Hit) => {
    const [lon, lat] = h.geometry.coordinates;
    placeTarget(L.latLng(lat, lon));
    setEndName(h.properties.name ?? h.properties.street);
    map?.flyTo([lat, lon], 16);
    setResults([]);
  };

  //nav bar data
  // Index of the step closest to the user (0 if no data or no GPS)
  let i = 0; // Default: first step
  if (nav && userPos) {
    // Only search if we have navigation data AND the user's position
    let best = Infinity; // Smallest distance found so far (starts huge so any real distance beats it)
    nav.steps.forEach((s, k) => {
      // Visit every step: s = the step, k = its index
      const d = userPos.distanceTo([s.lat, s.lon]); // Straight-line metres from user to this step's start point
      if (d < best) {
        best = d;
        i = k;
      } // Closer than anything before: save the distance and this index
    }); // End of loop: i now holds the closest step's index
  } // End of the "have data and GPS" check
  const step = nav?.steps[i]; // Current step object (undefined if nav is null); drives the top banner

  // Distance left: this step plus all later ones
  let left = 0; // Running total in metres
  if (nav)
    for (let k = i; k < nav.steps.length; k++) left += nav.steps[k].distance_m; // From the current step to the last, add each step's length

  // Time left (assumes constant speed) and ETA clock time
  const secs = nav ? nav.duration_s * (left / nav.distance_m) : 0; // Total time * share of distance remaining; 0 when not navigating
  const eta = new Date(Date.now() + secs * 1000).toLocaleTimeString([], {
    hour: "2-digit",
    minute: "2-digit",
  }); // Now + time left (ms), formatted like "01:40"

  // "650 m" or "1.2 km"
  const fmt = (m: number) =>
    m >= 1000 ? `${(m / 1000).toFixed(1)} km` : `${Math.round(m)} m`; // 1000+ m: km with one decimal; otherwise whole metres

  return (
    <div className="h-full w-full">
      <MapContainer
        ref={setMap}
        center={OXFORD_CENTER}
        zoom={14}
        minZoom={12}
        maxBounds={OXFORD_BOUNDS}
        maxBoundsViscosity={1.0}
        className="h-full w-full"
        zoomControl={false} // turn off the default top-left +/- buttons...
      >
        <ZoomControl position="bottomright" />{" "}
        {/* ...and put them bottom-right instead */}
        <TileLayer
          url="https://tile.openstreetmap.org/{z}/{x}/{y}.png"
          attribution="&copy; OpenStreetMap contributors"
        />
        <UserMarker pos={userPos} setPos={setUserPos} />
        <TargetPin target={targetPos} setTarget={onMapTap} />
        {startPick && <Marker position={startPick} icon={startIcon} />}
        {route && (
          <Polyline
            positions={route}
            pathOptions={{ color: "#2563eb", weight: 5, opacity: 0.8 }}
          />
        )}{" "}
        {/* The planned route */}
      </MapContainer>
      {/* Search bar */}
      {/* Search bar: input + clear button + message, stacked */}

      {nav && (
        <>
          {/* Top: current direction */}
          <div className="absolute inset-x-3 top-3 z-[1000] rounded-2xl bg-teal-800 p-4 text-white shadow">
            <p className="text-lg font-semibold">{step?.instruction}</p>
            <p className="text-sm opacity-80">
              then {nav.steps[i + 1]?.instruction ?? "arrive"}
            </p>
          </div>

          {/* Bottom: duration, distance left, ETA, exit */}
          <div className="absolute inset-x-3 bottom-3 z-[1000] flex items-center justify-between rounded-2xl bg-neutral-900 p-4 text-white shadow">
            <div>
              <p className="text-2xl font-semibold">
                {Math.max(1, Math.round(secs / 60))} min
              </p>
              <p className="text-sm opacity-70">
                {fmt(left)} · {eta}
              </p>
            </div>
            <button
              onClick={() => {
                setNav(null);
                setRoute(null);
              }}
              className="rounded-full bg-red-600 px-5 py-2 font-semibold"
            >
              Exit
            </button>
          </div>
        </>
      )}

      {!nav && (
        <div className="absolute left-1/2 top-4 z-[1000] w-64 -translate-x-1/2">
          <div className="relative">
            <input
              value={query}
              onChange={(e) => setQuery(e.target.value)} // Keep state in sync
              onKeyDown={(e) => e.key === "Enter" && search()} // Search on Enter
              placeholder="Search Oxford..."
              className="w-full rounded bg-white py-2 pl-3 pr-8 shadow"
            />
            {query && (
              <button
                onClick={() => {
                  setQuery("");
                }} // Clear text and message
                className="absolute right-2 top-1/2 -translate-y-1/2 text-gray-400"
              >
                ✕
              </button>
            )}
          </div>
          {/* autocomplete searchbar */}
          {results.length > 0 && (
            <ul className="mt-1 rounded bg-white text-sm shadow">
              {results.map((h) => (
                <li
                  key={h.properties.osm_id}
                  onClick={() => pick(h)}
                  className="cursor-pointer px-3 py-2 hover:bg-gray-100"
                >
                  {h.properties.name ?? h.properties.street}
                </li>
              ))}
            </ul>
          )}
          {/* // Inside the search bar wrapper div, after the results list (so it sits
        under the input) */}
          <div className="mt-1 flex gap-1">
            {/* Row of buttons: small top margin, small gap between them */}
            {PROFILES.map(
              (
                p, // Loop over ["chill", "regular", "fast"], one button each
              ) => (
                <button
                  key={p} // React needs a unique key per item in a list
                  onClick={() => {
                    setProfile(p); // Highlight the selected ride type
                    sendPositions(p); // Reroute now with the new type (returns early if a pin is missing)
                  }}
                  className={`flex-1 rounded px-2 py-1 text-sm capitalize shadow ${
                    // flex-1: equal widths; capitalize: "chill" shows as "Chill"
                    profile === p ? "bg-blue-600 text-white" : "bg-white" // Active one is blue, the rest are white
                  }`}
                >
                  {p} {/* Button label: the ride type name */}
                </button>
              ),
            )}
          </div>
        </div>
<<<<<<< HEAD
      )}

      {/* Button inside the wrapper div, outside <MapContainer> */}
      {/*z-[1000] sits above Leaflet's panes */}
      {!nav && (
        <button
          onClick={() => sendPositions()}
          className="absolute bottom-4 left-1/2 z-[1000] -translate-x-1/2 rounded bg-blue-600 px-4 py-2 text-white disabled:opacity-50"
          disabled={!userPos || !targetPos}
        >
          Ride
        </button>
      )}
      <button
        onClick={() => userPos && map?.flyTo(userPos, 16)} // Fly back to the blue dot
        disabled={!userPos}
        className={`absolute left-3 z-[1000] rounded bg-white px-3 py-2 shadow disabled:opacity-50 ${
          nav ? "bottom-28" : "bottom-20" // Higher when the navigation bar is showing
        }`}
=======
        {/* When to leave: the night route prefers lit streets */}
        <div className="mt-1 flex gap-1">
          {(Object.keys(WHEN_LABEL) as When[]).map((w) => (
            <button
              key={w}
              onClick={() => {
                setWhen(w);
                sendPositions(profile, w);
              }}
              className={`flex-1 rounded px-2 py-1 text-sm shadow ${when === w ? "bg-neutral-900 text-white" : "bg-white"}`}
            >
              {WHEN_LABEL[w]}
            </button>
          ))}
        </div>
        {/* Start point: GPS, or tap the map (handy indoors / outside Oxford) */}
        <div className="mt-1 flex gap-1 text-xs">
          <button
            onClick={() => setTapSetsStart((v) => !v)}
            className={`flex-1 rounded px-2 py-1 shadow ${tapSetsStart ? "bg-green-600 text-white" : "bg-white"}`}
          >
            {tapSetsStart ? "Tap the map for the start" : start ? "Move start" : "Set start on map"}
          </button>
          {DEMO_TRIPS.map((t) => (
            <button key={t.name} onClick={() => runDemo(t)} className="flex-1 rounded bg-white px-1 py-1 shadow">
              {t.name}
            </button>
          ))}
        </div>
      </div>

      {/* Bottom: the planned ride, or the Ride button. z-[1000] sits above Leaflet's panes */}
      <div className="pointer-events-none absolute inset-x-0 bottom-0 z-[1000] flex flex-col items-center gap-2 p-3">
        {error && (
          <div className="pointer-events-auto rounded bg-red-50 px-3 py-1 text-sm text-red-700 shadow">{error}</div>
        )}
        <VoiceButton
          voice={voice}
          context={() => ({ position: start ? ([start.lat, start.lng] as LatLon) : null, route: result })}
          onResult={onVoice}
          className="pointer-events-auto"
        />
        <div className="pointer-events-auto flex w-full max-w-md items-end justify-center gap-3">
          {result ? (
            <RoutePanel
              result={result}
              whenLabel={when === "now" ? "Leaving now" : `${WHEN_LABEL[when]} (${departAtFor(when)?.slice(11)})`}
              dark={when === "night"}
              hint={hint}
              onStart={startRide}
              busy={busy}
            />
          ) : (
            <button
              onClick={() => sendPositions()}
              className="h-12 rounded-xl bg-blue-600 px-6 text-white shadow disabled:opacity-50"
              disabled={!start || !targetPos || busy}
            >
              {busy ? "Finding route…" : !start ? "Set a start" : !targetPos ? "Tap a destination" : "Ride"}
            </button>
          )}
        </div>
      </div>

      <button
        onClick={() => userPos && map?.flyTo(userPos, 16)} // Fly back to the blue dot
        disabled={!userPos}
        className="absolute left-3 top-4 z-[1000] rounded bg-white px-3 py-2 shadow disabled:opacity-50"
>>>>>>> bde95d421e2709fbbee14d7c5d4e3ddfbbf96fa3
      >
        📍
      </button>
    </div>
  );
}
