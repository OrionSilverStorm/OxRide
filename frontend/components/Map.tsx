"use client";

import "leaflet/dist/leaflet.css";
import { useState, useEffect, useMemo, useRef } from "react";
import { MapContainer, TileLayer, Marker, Polyline, useMap, useMapEvents } from "react-leaflet";

import L from "leaflet";
import {
  ArrowUp,
  Bike,
  Clock,
  CornerUpLeft,
  CornerUpRight,
  Flag,
  Leaf,
  LocateFixed,
  MapPin,
  Mic,
  Moon,
  Navigation,
  Search,
  Sun,
  Volume2,
  VolumeX,
  X,
  Zap,
  type LucideIcon,
} from "lucide-react";
import { getRoute, searchPlace, sendVoice, type Maneuver, type RouteResult } from "@/lib/api";
import { cumulativeM, currentStepIndex, ON_ROUTE, projectOnRoute, stepsAlongM, updateOffRoute } from "@/lib/nav";
import { say } from "@/lib/speak";
import { useTheme } from "@/hooks/useTheme";
import { useVoice } from "@/hooks/useVoice";

//define ride types
type Profile = "chill" | "regular" | "fast";
const PROFILES: Profile[] = ["fast", "regular", "chill"];
const PROFILE_ICON: Record<Profile, LucideIcon> = { fast: Zap, regular: Bike, chill: Leaf };

// Arrow for each kind of turn (banner and "then" row)
const MANEUVER_ICON: Record<Maneuver, LucideIcon> = {
  left: CornerUpLeft,
  right: CornerUpRight,
  straight: ArrowUp,
  arrive: Flag,
};

// OpenStreetMap tiles in both palettes; dark mode darkens them with a CSS filter (.tiles-dark).
// (CARTO's light/Dark Matter tiles now need an API key and show "API KEY REQUIRED" without one.)
const TILES = {
  light: "https://tile.openstreetmap.org/{z}/{x}/{y}.png",
  dark: "https://tile.openstreetmap.org/{z}/{x}/{y}.png",
};

// Round floating map button (Google Maps style), at least 48px
const FAB =
  "pointer-events-auto flex size-12 items-center justify-center rounded-full bg-card text-foreground shadow-md disabled:opacity-50";

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

const OXFORD_CENTER: [number, number] = [51.752, -1.2577];
const OXFORD_BOUNDS = L.latLngBounds([51.69, -1.37], [51.82, -1.14]);

// Live position dot (colours come from globals.css, so it follows the theme)
const userIcon = L.divIcon({
  className: "",
  html: '<div class="user-dot"></div>',
  iconSize: [20, 20],
  iconAnchor: [10, 10],
});

// Destination pin: a map-pin shape whose tip sits on the chosen point
const targetIcon = L.divIcon({
  className: "target-pin", // Our class instead of Leaflet's default white box
  html: '<svg width="32" height="40" viewBox="0 0 32 40"><path d="M16 39C16 39 30 24.5 30 15A14 14 0 0 0 2 15C2 24.5 16 39 16 39Z"/><circle cx="16" cy="15" r="5"/></svg>',
  iconSize: [32, 40],
  iconAnchor: [16, 39], // Tip of the pin
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
  const [voiceOn, setVoiceOn] = useState(true); // Spoken directions, on by default (the button mutes them)
  //////////////////////////////////////////////////////////////////////////

  const [targetName, setTargetName] = useState<string | null>(null); // "Radcliffe Camera"; null = tapped on the map

  // Moves the target and removes the stale route line
  const placeTarget = (p: L.LatLng, name: string | null = null) => {
    setTargetPos(p);
    setTargetName(name);
    setNav(null);
    setResults([]); // Close the suggestions
  };

  // Routing
  // One /route call gives the line, the stats and the turn-by-turn steps
  const [hint, setHint] = useState<string | null>(null); // "Leave in 20 min: ..." for the ride just planned
  const sendPositions = async (p: Profile = profile, t: L.LatLng | null = targetPos, reroute = false) => {
    if (!userPos || !t) return; // Need both points
    try {
      const data = await getRoute({
        start: [userPos.lat, userPos.lng], // [lat, lon], latitude first
        end: [t.lat, t.lng], // [lat, lon], latitude first
        profile: p, // "fast" | "regular" | "chill"
        // depart_at left out = leaving now
      });
      setNav(data); // Draws the line and opens the directions
      setHint(reroute ? null : (data.hint?.text ?? null)); // A "when to leave" tip is pointless after a reroute
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
      placeTarget(p, hit.name); // Drop the pin
      map?.flyTo(p, 16); // Move the map there
      sendPositions(profile, p); // A searched place: plan the route straight away
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
    const t = L.latLng(lat, lon);
    placeTarget(t, h.properties.name ?? h.properties.street ?? null);
    map?.flyTo([lat, lon], 16);
    setResults([]);
    setQuery(h.properties.name ?? h.properties.street ?? "");
    sendPositions(profile, t); // Picked a place: plan the route straight away
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
  // A spoken command from the mic
  const [voiceStatus, setVoiceStatus] = useState<"" | "Thinking…">(""); // Shown above the mic
  // What it heard and what it answered, shown for a few seconds so a mishearing is obvious
  const [caption, setCaption] = useState<{ heard: string; reply: string | null } | null>(null);
  const captionTimer = useRef<ReturnType<typeof setTimeout>>(undefined);
  const showCaption = (heard: string, reply: string | null) => {
    clearTimeout(captionTimer.current);
    setCaption({ heard, reply });
    if (reply) captionTimer.current = setTimeout(() => setCaption(null), 8000);
  };
  const handleCommand = async (text: string) => {
    let r;
    setVoiceStatus("Thinking…");
    showCaption(text, null);
    try {
      // Gemini (via /voice) works out the place and ride type, and finds the place's coordinates
      r = await sendVoice({
        text,
        position: userPos ? [userPos.lat, userPos.lng] : undefined,
        route: nav ?? undefined,
      });
    } catch {
      showCaption(text, "Sorry, I couldn't reach OxRide.");
      say("Sorry, I couldn't reach OxRide.");
      return;
    } finally {
      setVoiceStatus("");
    }
    showCaption(text, r.reply);
    say(r.reply); // Spoken reply (ElevenLabs): the user just asked, so it's not muted
    const p = (r.settings.profile as Profile | undefined) ?? profile;
    if (r.settings.profile) setProfile(p); // Highlight chill/regular/fast
    if (r.action === "new_route" && r.settings.end) {
      const t = L.latLng(r.settings.end[0], r.settings.end[1]);
      placeTarget(t, r.settings.end_name ?? null); // Drop the pin
      map?.flyTo(t, 15);
      sendPositions(p, t); // Plan the route now
    } else if (r.action === "reroute") {
      sendPositions(p); // Same destination, new way (e.g. "quieter please")
    }
  };
  // The mic: hold to talk (sent when you let go), or tap once to keep listening until tapped again
  const voice = useVoice(handleCommand);
  const listening =
    voice.mode === "hold" ? "Listening… let go to send" : voice.mode === "continuous" ? "Listening… tap the mic to stop" : "";

  // Off the route by more than ~30 m for a few seconds: plan again from here
  const off = useRef(ON_ROUTE);
  const lastReroute = useRef(0);
  useEffect(() => {
    if (!nav || !proj || !fix) return;
    off.current = updateOffRoute(off.current, proj.distanceToRoute, fix.time, { accuracyM: fix.accuracy });
    if (off.current.offRoute && Date.now() - lastReroute.current > REROUTE_GAP_MS) {
      lastReroute.current = Date.now();
      off.current = ON_ROUTE;
      sendPositions(profile, targetPos, true); // From the current position to the same destination
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

  // Light or dark: follows the phone, always dark while navigating, the toggle overrides both
  const { theme, toggle: toggleTheme } = useTheme(!!nav);

  // Distance to the next maneuver, for the "then" row of the banner
  const toNext = nav && i + 1 < stepAlong.length ? Math.max(0, stepAlong[i + 1] - (proj?.alongM ?? 0)) : null;
  const next = nav?.steps[i + 1];
  const StepIcon = MANEUVER_ICON[step?.maneuver ?? "straight"];
  const NextIcon = MANEUVER_ICON[next?.maneuver ?? "arrive"];

  // Ride type picker: chips under the search bar, a segmented row while navigating
  const profileButtons = (onPick: (p: Profile) => void) =>
    PROFILES.map((p) => {
      const Icon = PROFILE_ICON[p];
      const on = profile === p;
      return (
        <button
          key={p}
          onClick={() => onPick(p)}
          aria-pressed={on}
          className={`pointer-events-auto flex h-12 flex-1 items-center justify-center gap-2 rounded-full px-4 text-base capitalize shadow-md ${
            on ? "bg-primary text-primary-foreground" : "bg-card text-foreground"
          }`}
        >
          <Icon className="size-5" />
          {p}
        </button>
      );
    });

  const status = voiceStatus || listening;

  return (
    <div
      className={`relative h-full w-full overflow-hidden bg-background text-foreground ${theme}`}
      style={{ colorScheme: theme }}
    >
      <MapContainer
        ref={setMap}
        center={OXFORD_CENTER}
        zoom={14}
        minZoom={12}
        maxBounds={OXFORD_BOUNDS}
        maxBoundsViscosity={1.0}
        className="h-full w-full"
        zoomControl={false} // Pinch and scroll to zoom, like Google Maps on a phone
        attributionControl={false} // Drawn ourselves above the bottom sheet so it stays visible
      >
        <TileLayer key={theme} url={TILES[theme]} maxZoom={19} className={theme === "dark" ? "tiles-dark" : ""} />
        <UserMarker pos={userPos} onFix={setFix} follow={!!nav} />
        <TargetPin target={targetPos} setTarget={(p) => placeTarget(p)} />
        {/* The planned route: 6px primary line over a thin outline in the background colour */}
        {route && <Polyline positions={route} pathOptions={{ className: "route-outline", weight: 9, opacity: 1 }} />}
        {route && <Polyline positions={route} pathOptions={{ className: "route-line", weight: 6, opacity: 1 }} />}
      </MapContainer>

      {/* ---- Top: search + ride type (planning) or the next-turn banner (navigating) ---- */}
      <div className="pointer-events-none absolute inset-x-0 top-0 z-[1000] flex flex-col gap-2 p-4">
        {!nav && (
          <>
            <div className="relative">
              <div className="pointer-events-auto flex h-12 items-center gap-2 rounded-full bg-card pl-4 pr-1 shadow-md">
                <Search className="size-5 shrink-0 text-muted-foreground" />
                <input
                  value={query}
                  onChange={(e) => setQuery(e.target.value)} // Keep state in sync
                  onKeyDown={(e) => e.key === "Enter" && search()} // Search on Enter
                  placeholder="Search Oxford"
                  aria-label="Search Oxford"
                  className="h-full min-w-0 flex-1 bg-transparent text-base text-foreground outline-none placeholder:text-muted-foreground"
                />
                {query && (
                  <button
                    onClick={() => setQuery("")}
                    aria-label="Clear search"
                    className="flex size-10 shrink-0 items-center justify-center rounded-full text-foreground"
                  >
                    <X className="size-5" />
                  </button>
                )}
              </div>
              {/* Suggestions as you type */}
              {query.length >= 2 && results.length > 0 && (
                <ul className="pointer-events-auto absolute inset-x-0 top-full mt-2 overflow-hidden rounded-2xl bg-card py-2 shadow-md">
                  {results.map((h) => (
                    <li key={h.properties.osm_id}>
                      <button
                        onClick={() => pick(h)}
                        className="flex min-h-12 w-full items-center gap-4 px-4 text-left text-base text-foreground"
                      >
                        <MapPin className="size-5 shrink-0 text-muted-foreground" />
                        <span className="truncate">{h.properties.name ?? h.properties.street}</span>
                      </button>
                    </li>
                  ))}
                </ul>
              )}
            </div>
            {/* Ride type chips: only choose the type, the route starts with "Start" */}
            <div className="flex gap-2">{profileButtons(setProfile)}</div>
          </>
        )}

        {nav && (
          <div className="pointer-events-auto overflow-hidden rounded-2xl shadow-md">
            {/* Current instruction */}
            <div className="flex items-start gap-4 bg-primary p-4 text-primary-foreground">
              <StepIcon className="mt-1 size-10 shrink-0" strokeWidth={2.5} />
              <p className="text-[28px] font-bold leading-tight">{step?.text}</p>
            </div>
            {/* What comes after it */}
            <div className="flex items-center gap-2 bg-card px-4 py-2 text-base text-foreground">
              <span>Then</span>
              <NextIcon className="size-5 shrink-0" />
              <span className="min-w-0 flex-1 truncate">{next?.text ?? "arrive"}</span>
              {toNext !== null && <span className="shrink-0">in {fmt(toNext)}</span>}
            </div>
          </div>
        )}

        {/* Right-hand map buttons, under the search bar or the banner */}
        <div className="flex flex-col items-end gap-2">
          <button
            onClick={toggleTheme}
            aria-label={theme === "dark" ? "Switch to light map" : "Switch to dark map"}
            title={theme === "dark" ? "Light map" : "Dark map"}
            className={FAB}
          >
            {theme === "dark" ? <Sun className="size-5" /> : <Moon className="size-5" />}
          </button>
          {nav && (
            <button
              onClick={() => setVoiceOn((v) => !v)} // Click = user gesture, so the browser allows audio
              aria-label={voiceOn ? "Mute directions" : "Speak directions"}
              className={FAB}
            >
              {voiceOn ? <Volume2 className="size-5" /> : <VolumeX className="size-5" />}
            </button>
          )}
        </div>
      </div>

      {/* ---- Bottom: attribution, mic, my location, then the sheet ---- */}
      <div className="pointer-events-none absolute inset-x-0 bottom-0 z-[1000] flex flex-col gap-2">
        {/* What the voice command is doing right now */}
        {(status || caption || voice.error) && (
          <div className="flex justify-center px-4">
            <div aria-live="polite" className="max-w-sm rounded-2xl bg-card px-4 py-2 text-base text-foreground shadow-md">
              {status && <p className="font-semibold">{status}</p>}
              {caption && <p className="text-sm">Heard: “{caption.heard}”</p>}
              {caption?.reply && <p>{caption.reply}</p>}
              {voice.error && <p className="text-danger">{voice.error}</p>}
            </div>
          </div>
        )}
        <div className="relative flex min-h-[72px] items-end justify-between px-4">
          <p className="pointer-events-auto max-w-[35%] rounded-lg bg-card/90 px-2 py-1 text-xs leading-snug text-foreground">
            &copy; <a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noreferrer" className="underline">OpenStreetMap</a>{" "}
            contributors
          </p>
          {/* Mic: hold and speak ("chill ride to the Bodleian"), or tap once to keep listening */}
          <button
            onPointerDown={(e) => {
              e.currentTarget.setPointerCapture(e.pointerId); // still "held" if the finger slides off
              voice.press();
            }}
            onPointerUp={voice.release}
            onPointerCancel={voice.release}
            onContextMenu={(e) => e.preventDefault()} // no long-press menu on phones
            aria-label="Speak a command"
            aria-pressed={voice.mode !== "off"}
            className="pointer-events-auto absolute bottom-0 left-1/2 flex size-[72px] -translate-x-1/2 touch-none select-none items-center justify-center rounded-full bg-primary text-primary-foreground shadow-md"
          >
            {voice.mode !== "off" && (
              <span className="absolute inset-0 animate-ping rounded-full bg-primary opacity-50" />
            )}
            <Mic className="relative size-8" />
          </button>
          <button
            onClick={() => userPos && map?.flyTo(userPos, 16)} // Back to the blue dot
            disabled={!userPos}
            aria-label="Back to my location"
            className={FAB}
          >
            <LocateFixed className="size-5 text-info" />
          </button>
        </div>

        <div className="pointer-events-auto rounded-t-2xl bg-card px-4 pt-2 pb-[max(16px,env(safe-area-inset-bottom))] text-foreground shadow-md">
          <div className="mx-auto mb-2 h-1 w-8 rounded-full bg-border" /> {/* sheet handle */}

          {!nav && !targetPos && (
            <div className="pb-2">
              <p className="text-xl font-bold">Where to?</p>
              <p className="text-base">Search, tap the map, or press the mic and say where.</p>
            </div>
          )}

          {!nav && targetPos && (
            <div className="flex flex-col gap-4">
              <div>
                <p className="truncate text-xl font-bold">{targetName ?? "Dropped pin"}</p>
                <p className="text-base">
                  {userPos ? `${profile[0].toUpperCase()}${profile.slice(1)} ride from your location` : "Finding your location…"}
                </p>
              </div>
              <div className="flex gap-2">
                <button
                  onClick={() => sendPositions()}
                  disabled={!userPos}
                  className="flex h-12 flex-1 items-center justify-center gap-2 rounded-full bg-primary text-base font-bold text-primary-foreground disabled:opacity-50"
                >
                  <Navigation className="size-5" />
                  Start
                </button>
                <button
                  onClick={() => {
                    setTargetPos(null);
                    setTargetName(null);
                  }}
                  aria-label="Clear destination"
                  className="flex size-12 items-center justify-center rounded-full bg-surface text-foreground"
                >
                  <X className="size-5" />
                </button>
              </div>
            </div>
          )}

          {nav && (
            <div className="flex flex-col gap-4">
              <div className="flex items-center gap-4">
                <button
                  onClick={() => setNav(null)}
                  aria-label="Exit navigation"
                  className="flex size-12 shrink-0 items-center justify-center rounded-full bg-surface text-foreground"
                >
                  <X className="size-6" />
                </button>
                <div className="min-w-0 flex-1 text-center">
                  <p className="text-[28px] font-bold leading-tight">{Math.max(1, Math.round(secs / 60))} min</p>
                  <p className="text-base">
                    {fmt(left)} · arrive {eta}
                  </p>
                </div>
                <div className="size-12 shrink-0" /> {/* balances the exit button so the time stays centred */}
              </div>
              {/* When to leave: only before you've really set off */}
              {hint && (proj?.alongM ?? 0) < 100 && (
                <p className="flex items-start gap-2 text-base">
                  <Clock className="mt-0.5 size-5 shrink-0 text-warning" />
                  {hint}
                </p>
              )}
              {/* Change ride type mid-ride: re-plans from where the user is now */}
              <div className="flex gap-2">
                {profileButtons((p) => {
                  setProfile(p);
                  sendPositions(p);
                })}
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
