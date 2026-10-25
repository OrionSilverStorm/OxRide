"use client";

import "leaflet/dist/leaflet.css";
import { useState, useEffect, useMemo, useRef } from "react";
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
import { LocateFixed, Mic, Volume2, VolumeX } from "lucide-react";
import { getRoute, searchPlace, sendVoice, speak, type RouteResult } from "@/lib/api";
import { cumulativeM, currentStepIndex, ON_ROUTE, projectOnRoute, stepsAlongM, updateOffRoute } from "@/lib/nav";

//define ride types
type Profile = "chill" | "regular" | "fast";
const PROFILES: Profile[] = ["chill", "regular", "fast"];

// Props for UserMarker: the parent's state value + its setter
interface UserMarkerProps {
  pos: L.LatLng | null; // User's position, null until found
  onFix: (f: Fix) => void; // Every new GPS reading
  follow: boolean; // Keep the map centred on the user (while navigating)
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

// A GPS reading: where, how precise (m), and when (ms)
interface Fix {
  pos: L.LatLng;
  accuracy: number;
  time: number;
}

const REROUTE_GAP_MS = 8000; // don't ask for a new route more often than this

// Speak with ElevenLabs (via /speak); the browser's own voice if that fails.
// Returns a function that stops the sound.
function say(text: string): () => void {
  let stopped = false;
  let audio: HTMLAudioElement | undefined;
  speak(text)
    .then((mp3) => {
      if (stopped) return; // Don't play outdated audio
      audio = new Audio(URL.createObjectURL(mp3));
      return audio.play();
    })
    .catch(() => {
      if (stopped || !("speechSynthesis" in window)) return;
      const u = new SpeechSynthesisUtterance(text);
      u.lang = "en-GB";
      window.speechSynthesis.speak(u);
    });
  return () => {
    stopped = true;
    audio?.pause();
    if ("speechSynthesis" in window) window.speechSynthesis.cancel();
  };
}

// The bits of the browser's SpeechRecognition API we use
interface SpeechRec {
  lang: string;
  start: () => void;
  onresult: (e: { results: { [i: number]: { [j: number]: { transcript: string } } } }) => void;
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

function TargetPin({ target, setTarget }: TargetPinProps) {
  // Attach map event handlers (react-leaflet removes them automatically on unmount)
  useMapEvents({
    click: (e) => setTarget(e.latlng), // Move the pin to wherever the user clicks
  });

  return target && <Marker position={target} icon={targetIcon} />; // Render the pin once placed, nothing before
}

function UserMarker({ pos, onFix, follow }: UserMarkerProps) {
  const map = useMap(); // Get the Leaflet map instance
  const first = useRef(true); // Fly to the user only on the first reading
  const onFixRef = useRef(onFix); // Latest callback without restarting GPS
  useEffect(() => {
    onFixRef.current = onFix;
  });

  useEffect(() => {
    // Runs every time the browser has a new location (watch: true keeps it coming)
    const onFound = (e: L.LocationEvent) => {
      if (OXFORD_BOUNDS.contains(e.latlng)) {
        // Only continue if inside Oxford bounds
        onFixRef.current({ pos: e.latlng, accuracy: e.accuracy, time: e.timestamp }); // Save position so the marker renders
        if (first.current) {
          first.current = false;
          map.flyTo(e.latlng, 16); // Animate the map to the user, zoom 16
        }
      }
    };

    // Register the listener, then ask the browser to keep sending the location
    map
      .on("locationfound", onFound)
      .locate({ watch: true, enableHighAccuracy: true, maximumAge: 2000, timeout: 20000 });

    // Cleanup on unmount: remove listener and stop locating
    return () => {
      map.off("locationfound", onFound).stopLocate();
    };
  }, [map]); // Re-run only if the map instance changes

  // While navigating, keep the user in the middle of the map
  useEffect(() => {
    if (follow && pos) map.panTo(pos, { animate: true });
  }, [map, pos, follow]);

  return pos && <Marker position={pos} icon={userIcon} />; // Render marker once we have a valid position, else nothing
}

export default function Map() {
  //start and end location
  const [fix, setFix] = useState<Fix | null>(null); // Latest GPS reading, null until found
  const userPos = fix?.pos ?? null; // User's position
  const [targetPos, setTargetPos] = useState<L.LatLng | null>(null); // Target position, null until the user clicks
  const [profile, setProfile] = useState<Profile>("regular"); //defaults to regular
  //nav settings
  const [nav, setNav] = useState<RouteResult | null>(null); // The ride from /route; non-null = navigation mode
  const route = nav?.route ?? null; // Route as [lat, lon] points, drawn on the map
  const [voiceOn, setVoiceOn] = useState(false); // Speaker mode, off by default (also acts as mute)
  //////////////////////////////////////////////////////////////////////////

  // Moves the target and removes the stale route line
  const placeTarget = (p: L.LatLng) => {
    setTargetPos(p);
    setNav(null);
  };

  // Routing
  // One /route call gives the line, the stats and the turn-by-turn steps
  const sendPositions = async (p: Profile = profile, t: L.LatLng | null = targetPos) => {
    if (!userPos || !t) return; // Need both points
    try {
      const data = await getRoute({
        start: [userPos.lat, userPos.lng], // [lat, lon], latitude first
        end: [t.lat, t.lng], // [lat, lon], latitude first
        profile: p, // "fast" | "regular" | "chill"
        // depart_at left out = leaving now
      });
      setNav(data); // Draws the line and opens the directions
    } catch (e) {
      console.warn(e); // 404 no route, 503 graph not loaded, or backend down
    }
  };

  ///******************************************************************************************** */
  //Search Bar
  const [query, setQuery] = useState(""); // Text in the search box
  const [map, setMap] = useState<L.Map | null>(null); // Lets us fly the map from outside MapContainer

  const search = async () => {
    if (!query.trim()) return; // Ignore empty input
    try {
      const [hit] = await searchPlace(query); // Backend asks Nominatim (Oxford only); first result or undefined
      if (!hit) return console.warn("No results"); // Nothing found
      const p = L.latLng(hit.lat, hit.lon);
      if (!OXFORD_BOUNDS.contains(p)) return; // Safety check
      placeTarget(p); // Drop the red pin
      map?.flyTo(p, 16); // Move the map there
    } catch (err) {
      console.warn("Search failed:", err); // Network or parse error
    }
  };

  //autocomplete search
  const [results, setResults] = useState<Hit[]>([]); // Suggestions

  // Fetch suggestions as the user types, cancelling stale requests
  useEffect(() => {
    // Too short to search: no request (the list is hidden below)
    if (query.length < 2) return;
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
    setTargetPos(L.latLng(lat, lon));
    map?.flyTo([lat, lon], 16);
    setResults([]);
  };

  //nav bar data
  // Where the user is along the route decides the current step and what's left
  const cum = useMemo(() => (nav ? cumulativeM(nav.route) : []), [nav]); // Metres from the start to each route point
  const stepAlong = useMemo(() => (nav ? stepsAlongM(nav.route, cum, nav.steps) : []), [nav, cum]); // Where each step begins
  const total = cum.at(-1) ?? 0; // Route length in metres
  const proj = nav && userPos ? projectOnRoute(nav.route, cum, [userPos.lat, userPos.lng]) : null; // User snapped onto the route
  const i = proj ? currentStepIndex(stepAlong, proj.alongM) : 0; // The step the user is on now
  const step = nav?.steps[i]; // Current step object (undefined if nav is null); drives the top banner

  // Distance and time left, from where the user is now
  const left = Math.max(0, total - (proj?.alongM ?? 0)); // Metres to the destination
  const secs = nav && total ? nav.stats.eta_min * 60 * (left / total) : 0; // Total time * share of distance remaining; 0 when not navigating
  const eta = new Date((fix?.time ?? 0) + secs * 1000).toLocaleTimeString([], {
    hour: "2-digit",
    minute: "2-digit",
  }); // Time of the latest GPS reading + time left, formatted like "01:40"

  // "650 m" or "1.2 km"
  const fmt = (m: number) =>
    m >= 1000 ? `${(m / 1000).toFixed(1)} km` : `${Math.round(m)} m`; // 1000+ m: km with one decimal; otherwise whole metres

  //************************************************************************************* */ gemini api voice listen
  const listen = () => {
    // Browser speech-to-text (Chrome/Safari). Needs HTTPS or localhost
    const SR =
      (window as unknown as { SpeechRecognition?: new () => SpeechRec }).SpeechRecognition ||
      (window as unknown as { webkitSpeechRecognition?: new () => SpeechRec }).webkitSpeechRecognition;
    if (!SR) return alert("Speech recognition not supported");
    const rec = new SR();
    rec.lang = "en-GB";
    rec.onresult = async (e) => {
      const text = e.results[0][0].transcript; // What the user said
      let r;
      try {
        // Gemini (via /voice) works out the place and ride type, and finds the place's coordinates
        r = await sendVoice({
          text,
          position: userPos ? [userPos.lat, userPos.lng] : undefined,
          route: nav ?? undefined,
        });
      } catch {
        say("Sorry, I couldn't reach OxRide.");
        return;
      }
      say(r.reply); // Spoken reply (ElevenLabs): the user just asked, so it's not muted
      const p = (r.settings.profile as Profile | undefined) ?? profile;
      if (r.settings.profile) setProfile(p); // Highlight chill/regular/fast
      if (r.action === "new_route" && r.settings.end) {
        const t = L.latLng(r.settings.end[0], r.settings.end[1]);
        placeTarget(t); // Drop the red pin
        map?.flyTo(t, 15);
        sendPositions(p, t); // Plan the route now
      } else if (r.action === "reroute") {
        sendPositions(p); // Same destination, new way (e.g. "quieter please")
      }
    };
    rec.start(); // Starts listening
  };

  // Off the route by more than ~30 m for a few seconds: plan again from here
  const off = useRef(ON_ROUTE);
  const lastReroute = useRef(0);
  useEffect(() => {
    if (!nav || !proj || !fix) return;
    off.current = updateOffRoute(off.current, proj.distanceToRoute, fix.time, { accuracyM: fix.accuracy });
    if (off.current.offRoute && Date.now() - lastReroute.current > REROUTE_GAP_MS) {
      lastReroute.current = Date.now();
      off.current = ON_ROUTE;
      sendPositions(profile, targetPos); // From the current position to the same destination
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [fix]); // Every new GPS reading

  //************************************************************************************* */ ElevenLabs AI voice
  // Speaks the current step and distance left whenever the step changes
  useEffect(() => {
    if (!voiceOn || !step) return; // Muted or not navigating: do nothing
    // Cleanup (returned): runs on the next step, on mute, and on exit. Cuts the audio off immediately
    return say(`${step.text}. ${fmt(left)} remaining.`);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [voiceOn, i, nav]); // Re-run only when the step changes, not every GPS update

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
        <UserMarker pos={userPos} onFix={setFix} follow={!!nav} />
        <TargetPin target={targetPos} setTarget={placeTarget} />
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
            <p className="text-lg font-semibold">{step?.text}</p>
            <p className="text-sm opacity-80">
              then {nav.steps[i + 1]?.text ?? "arrive"}
            </p>
          </div>

          {/* Bottom: time left, distance left, ETA, ride type, mute, exit */}
          <div className="absolute inset-x-3 bottom-3 z-[1000] rounded-2xl bg-neutral-900 p-4 text-white shadow">
            <div className="flex items-center justify-between">
              <div>
                <p className="text-2xl font-semibold">
                  {Math.max(1, Math.round(secs / 60))} min left
                </p>
                <p className="text-sm opacity-70">
                  {fmt(left)} · arrive {eta}
                </p>
              </div>
              <div className="flex gap-2">
                <button
                  onClick={() => setVoiceOn((v) => !v)} // Click = user gesture, so the browser allows audio
                  aria-label={voiceOn ? "Mute directions" : "Speak directions"}
                  className="rounded-full bg-neutral-700 px-4 py-2"
                >
                  {voiceOn ? <Volume2 className="size-5" /> : <VolumeX className="size-5" />}
                </button>
                <button
                  onClick={() => setNav(null)}
                  className="rounded-full bg-red-600 px-5 py-2 font-semibold"
                >
                  Exit
                </button>
              </div>
            </div>
            {/* Change ride type mid-ride: re-plans from where the user is now */}
            <div className="mt-3 flex gap-1">
              {PROFILES.map((p) => (
                <button
                  key={p}
                  onClick={() => {
                    setProfile(p);
                    sendPositions(p);
                  }}
                  className={`flex-1 rounded-full px-2 py-1 text-sm capitalize ${
                    profile === p ? "bg-blue-600" : "bg-neutral-700"
                  }`}
                >
                  {p}
                </button>
              ))}
            </div>
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
          {query.length >= 2 && results.length > 0 && (
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
      )}

      {/* Button inside the wrapper div, outside <MapContainer> */}
      {/*z-[1000] sits above Leaflet's panes */}
      {!nav && (
        <button
          onClick={() => sendPositions()}
          className="absolute bottom-6 left-1/2 z-[1000] -translate-x-1/2 rounded bg-blue-600 px-4 py-2 text-white disabled:opacity-50"
          disabled={!userPos || !targetPos}
        >
          Drop a Pin and Ride
        </button>
      )}
      <button
        onClick={() => userPos && map?.flyTo(userPos, 16)} // Fly back to the blue dot
        disabled={!userPos}
        aria-label="Back to my location"
        className={`absolute left-3 z-[1000] rounded bg-white px-3 py-2 shadow disabled:opacity-50 ${
          nav ? "bottom-44" : "bottom-20" // Higher when the navigation bar is showing
        }`}
      >
        <LocateFixed className="size-5" />
      </button>
      <button
        onClick={listen} // Press, then speak: "chill ride to the Bodleian"
        aria-label="Speak a command"
        className={`absolute left-3 z-[1000] rounded bg-white px-3 py-2 shadow ${nav ? "bottom-56" : "bottom-36"}`}
      >
        <Mic className="size-5" />
      </button>
    </div>
  );
}
