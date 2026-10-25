"use client";

// Navigation screen: live (or simulated) position, next-turn banner, spoken directions,
// automatic rerouting when off route, push-to-talk. Reads the trip saved by the planning screen.

import "leaflet/dist/leaflet.css";
import { useCallback, useEffect, useRef, useState } from "react";
import Link from "next/link";
import L from "leaflet";
import { MapContainer, Marker, Polyline, TileLayer, useMap } from "react-leaflet";
import { ArrowLeft, ArrowRight, ArrowUp, Flag, LocateFixed } from "lucide-react";
import { getRoute, type LatLon, type Maneuver, type Profile, type RouteResult, type VoiceResult } from "@/lib/api";
import { announcement, formatDistance } from "@/lib/nav";
import { say, unlockAudio } from "@/lib/speech";
import { loadTrip, saveTrip, type Trip } from "@/lib/trip";
import { useLocation } from "@/hooks/useLocation";
import { useNavigation } from "@/hooks/useNavigation";
import { useSimulatedRide } from "@/hooks/useSimulatedRide";
import { useVoice } from "@/hooks/useVoice";
import VoiceButton from "./VoiceButton";

const REROUTE_GAP_MS = 8000; // don't ask for a new route more often than this

const riderIcon = L.divIcon({
  className: "",
  html: '<div style="width:20px;height:20px;background:#2563eb;border:4px solid white;border-radius:50%;box-shadow:0 0 6px rgba(0,0,0,.5)"></div>',
  iconSize: [20, 20],
  iconAnchor: [10, 10],
});
const endIcon = L.divIcon({
  className: "",
  html: '<div style="width:16px;height:16px;background:#dc2626;border:3px solid white;border-radius:50%;box-shadow:0 0 4px rgba(0,0,0,.4)"></div>',
  iconSize: [16, 16],
  iconAnchor: [8, 8],
});

function Arrow({ m }: { m: Maneuver | undefined }) {
  const cls = "size-10 shrink-0";
  if (m === "left") return <ArrowLeft className={cls} />;
  if (m === "right") return <ArrowRight className={cls} />;
  if (m === "arrive") return <Flag className={cls} />;
  return <ArrowUp className={cls} />;
}

// Keeps the map centred on the rider unless they've dragged it away.
function Follow({ position, follow, onDrag }: { position: LatLon | null; follow: boolean; onDrag: () => void }) {
  const map = useMap();
  useEffect(() => {
    map.on("dragstart", onDrag);
    return () => {
      map.off("dragstart", onDrag);
    };
  }, [map, onDrag]);
  useEffect(() => {
    if (follow && position) map.panTo(position, { animate: true, duration: 0.4 });
  }, [map, position, follow]);
  return null;
}

// Keep the screen on while riding (where the browser allows it).
function useWakeLock() {
  useEffect(() => {
    let lock: { release: () => Promise<void> } | null = null;
    const nav = navigator as Navigator & { wakeLock?: { request: (t: "screen") => Promise<{ release: () => Promise<void> }> } };
    const get = () => nav.wakeLock?.request("screen").then((l) => (lock = l)).catch(() => {});
    get();
    const again = () => document.visibilityState === "visible" && get();
    document.addEventListener("visibilitychange", again);
    return () => {
      document.removeEventListener("visibilitychange", again);
      lock?.release().catch(() => {});
    };
  }, []);
}

export default function Navigator() {
  const [trip, setTrip] = useState<Trip | null>(() => loadTrip());
  const [result, setResult] = useState<RouteResult | null>(trip?.result ?? null);
  const [simulate, setSimulate] = useState(true); // indoor demo by default; switch to live GPS outside
  const [follow, setFollow] = useState(true);
  const [rerouting, setRerouting] = useState(false);
  const [arrived, setArrived] = useState(false);
  const [reroutes, setReroutes] = useState(0); // how many times we planned again (shown to tests)
  const said = useRef(new Set<string>());
  const lastReroute = useRef(0);
  const voice = useVoice();
  const stopFollowing = useCallback(() => setFollow(false), []);
  useWakeLock();

  const gps = useLocation(!simulate);
  const sim = useSimulatedRide(result?.route ?? null, simulate && !arrived);
  const position = simulate ? sim.position : gps.position;
  const nav = useNavigation(result, position, simulate ? null : gps.accuracy);

  // Speak the first instruction when the ride starts
  useEffect(() => {
    if (result?.steps[0] && !said.current.has("start")) {
      said.current.add("start");
      say(result.steps[0].text);
    }
  }, [result]);

  // Spoken directions: early warning, then at the turn
  useEffect(() => {
    if (!nav.nextStep || rerouting) return;
    const a = announcement(nav.nextIndex, nav.nextStep, nav.distToStepM, said.current);
    if (a) {
      said.current.add(a.key);
      say(a.text);
    }
    if (nav.nextStep.maneuver === "arrive" && nav.distToStepM < 15) setArrived(true);
  }, [nav.nextIndex, nav.nextStep, nav.distToStepM, rerouting]);

  // Plan again from where the rider is now
  const replan = async (opts: { end?: LatLon; endName?: string; profile?: Profile; why?: string } = {}) => {
    if (!trip || !position) return;
    lastReroute.current = Date.now();
    setRerouting(true);
    if (opts.why) say(opts.why);
    try {
      const end = opts.end ?? trip.end;
      const profile = opts.profile ?? trip.profile;
      const next = await getRoute({ start: position, end, profile });
      const updated: Trip = { ...trip, start: position, end, endName: opts.endName ?? trip.endName, profile, result: next };
      said.current = new Set(["start"]);
      setTrip(updated);
      saveTrip(updated);
      setResult(next);
      setArrived(false);
      setReroutes((n) => n + 1);
      if (next.steps[1]) say(`New route. ${next.steps[0].text}`);
    } catch {
      say("I couldn't find a new route. Keep going and I'll try again.");
    } finally {
      setRerouting(false);
    }
  };

  // Off route for a few seconds: reroute automatically
  useEffect(() => {
    if (nav.offRoute && !rerouting && Date.now() - lastReroute.current > REROUTE_GAP_MS) {
      replan({ why: "You're off the route. Finding a new way." });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [nav.offRoute]);

  const onVoice = (r: VoiceResult) => {
    const s = r.settings;
    if (r.action === "new_route" && s.end) replan({ end: s.end, endName: s.end_name, profile: s.profile });
    else if (r.action === "reroute") replan({ profile: s.profile });
  };

  if (!trip || !result) {
    return (
      <main className="flex h-dvh flex-col items-center justify-center gap-3 p-6 text-center">
        <p>No ride planned yet.</p>
        <Link href="/" className="rounded-xl bg-blue-600 px-5 py-3 text-white">
          Plan a ride
        </Link>
      </main>
    );
  }

  const fraction = result.stats.distance_m ? nav.remainingM / result.stats.distance_m : 1;
  const minutesLeft = Math.max(1, Math.round(result.stats.eta_min * fraction));
  const step = nav.nextStep;

  return (
    <main
      className="relative h-dvh w-full"
      data-remaining-m={Math.round(nav.remainingM)}
      data-reroutes={reroutes}
      data-off-route={nav.offRoute}
      data-distance-to-route={Math.round(nav.distanceToRoute)}
    >
      <MapContainer center={result.route[0]} zoom={17} zoomControl={false} className="h-full w-full">
        <TileLayer
          url="https://tile.openstreetmap.org/{z}/{x}/{y}.png"
          attribution="&copy; OpenStreetMap contributors"
        />
        <Polyline positions={result.route} pathOptions={{ color: "#2563eb", weight: 7, opacity: 0.85 }} />
        <Marker position={result.route[result.route.length - 1]} icon={endIcon} />
        {position && <Marker position={position} icon={riderIcon} />}
        <Follow position={position} follow={follow} onDrag={stopFollowing} />
      </MapContainer>

      {/* Next turn */}
      <div className="absolute inset-x-0 top-0 z-[1000] p-3">
        <div className="mx-auto flex max-w-md items-center gap-3 rounded-2xl bg-neutral-900 p-4 text-white shadow-lg">
          <Arrow m={arrived ? "arrive" : step?.maneuver} />
          <div className="min-w-0">
            {arrived ? (
              <div className="text-[28px] font-bold leading-tight">You have arrived</div>
            ) : rerouting ? (
              <div className="text-[28px] font-bold leading-tight">Finding a new route…</div>
            ) : (
              <>
                <div className="text-[28px] font-bold leading-tight">{formatDistance(nav.distToStepM)}</div>
                <div className="text-base leading-snug text-neutral-200">{step?.text}</div>
              </>
            )}
          </div>
        </div>
        {!simulate && gps.error && (
          <div className="mx-auto mt-2 max-w-md rounded bg-red-50 px-3 py-1 text-sm text-red-700">
            GPS: {gps.error}
          </div>
        )}
      </div>

      {/* Bottom bar */}
      <div className="absolute inset-x-0 bottom-0 z-[1000] flex flex-col items-center gap-2 p-3">
        <VoiceButton
          voice={voice}
          context={() => ({ position, route: result })}
          onResult={onVoice}
        />
        <div className="w-full max-w-md rounded-2xl bg-white p-3 shadow-lg">
          <div className="flex items-baseline justify-between">
            <div className="text-xl font-semibold">
              {minutesLeft} min <span className="text-sm font-normal text-neutral-600">· {formatDistance(nav.remainingM)} left</span>
            </div>
            <div className="truncate text-sm text-neutral-600">{trip.endName ?? "Destination"}</div>
          </div>
          <div className="mt-2 flex gap-2">
            <button
              onClick={() => {
                unlockAudio();
                setSimulate((v) => !v);
              }}
              className="h-12 flex-1 rounded-xl border border-neutral-300 text-sm"
            >
              {simulate ? "Simulated ride" : "Live GPS"}
            </button>
            {simulate && (
              <button
                onClick={() => sim.wrongTurn()}
                disabled={rerouting || arrived}
                className="h-12 flex-1 rounded-xl border border-neutral-300 text-sm disabled:opacity-50"
              >
                Take a wrong turn
              </button>
            )}
            {!follow && (
              <button
                aria-label="Follow me"
                onClick={() => setFollow(true)}
                className="flex h-12 w-12 items-center justify-center rounded-xl border border-neutral-300"
              >
                <LocateFixed className="size-5" />
              </button>
            )}
            <Link href="/" className="flex h-12 items-center rounded-xl bg-neutral-900 px-4 text-sm text-white">
              End
            </Link>
          </div>
        </div>
      </div>
    </main>
  );
}
