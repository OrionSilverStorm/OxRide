"use client";

import "leaflet/dist/leaflet.css";
import { useState, useEffect } from "react";
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

// Module level: one Photon result (coordinates are [lon, lat])
interface Hit {
  geometry: { coordinates: [number, number] };
  properties: { osm_id: number; name?: string; street?: string };
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
  let [userPos, setUserPos] = useState<L.LatLng | null>(null); // User's position, null until found
  let [targetPos, setTargetPos] = useState<L.LatLng | null>(null); // Target position, null until the user clicks
  let [route, setRoute] = useState<[number, number][] | null>(null); // Route as [lat, lon] points, null until a ride is planned
  //////////////////////////////////////////////////////////////////////////

  // Moves the target and removes the stale route line
  const placeTarget = (p: L.LatLng) => {
    setTargetPos(p);
    setRoute(null);
  };

  // Routing
  const sendPositions = async () => {
    if (!userPos || !targetPos) return; // Need both points
    const res = await fetch("/api/route", {
      // Proxied to FastAPI /route
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        start: [userPos.lat, userPos.lng], // [lat, lon], latitude first
        end: [targetPos.lat, targetPos.lng], // [lat, lon], latitude first
        profile: "regular", // "fast" | "regular" | "chill"
        // depart_at left out = leaving now
      }),
    });
    if (!res.ok) return console.warn(res.status, await res.text()); // 404/422/503 reasons (text, so a down backend doesn't crash JSON parsing)
    const data = await res.json(); // { route, elevations_m, stats, steps }
    console.log(data);
    setRoute(data.route); // Draws the line below
  };

  ///******************************************************************************************** */
  //Search Bar
  const [query, setQuery] = useState(""); // Text in the search box
  const [map, setMap] = useState<L.Map | null>(null); // Lets us fly the map from outside MapContainer

  const search = async () => {
    if (!query.trim()) return; // Ignore empty input
    try {
      const url =
        `https://nominatim.openstreetmap.org/search?format=json&limit=1&bounded=1` + // bounded=1: only results inside the viewbox
        `&viewbox=-1.37,51.82,-1.14,51.69` + // Oxford bounds: left,top,right,bottom (lng,lat)
        `&q=${encodeURIComponent(query)}`; // Escape the text
      const [hit] = await (await fetch(url)).json(); // First result, or undefined
      if (!hit) return console.warn("No results"); // Nothing found
      const p = L.latLng(+hit.lat, +hit.lon); // Nominatim returns strings, so convert
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
    if (query.length < 2) return setResults([]);
    const ctrl = new AbortController();
    fetch(
      `https://photon.komoot.io/api/?q=${encodeURIComponent(query)}&limit=5&bbox=-1.37,51.69,-1.14,51.82`,
      { signal: ctrl.signal },
    )
      .then((r) => r.json())
      .then((d) => setResults(d.features))
      .catch(() => {});
    return () => ctrl.abort();
  }, [query]);

  // Click a suggestion: drop the pin, fly there, close the list
  const pick = (h: Hit) => {
    const [lon, lat] = h.geometry.coordinates;
    setTargetPos(L.latLng(lat, lon));
    map?.flyTo([lat, lon], 16);
    setResults([]);
  };

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
      </div>

      {/* Button inside the wrapper div, outside <MapContainer> */}
      {/*z-[1000] sits above Leaflet's panes */}
      <button
        onClick={sendPositions}
        className="absolute bottom-4 left-1/2 z-[1000] -translate-x-1/2 rounded bg-blue-600 px-4 py-2 text-white disabled:opacity-50"
        disabled={!userPos || !targetPos}
      >
        Ride
      </button>
      <button
        onClick={() => userPos && map?.flyTo(userPos, 16)} // Fly back to the blue dot
        disabled={!userPos}
        className="absolute bottom-20 left-3 z-[1000] rounded bg-white px-3 py-2 shadow disabled:opacity-50"
      >
        📍
      </button>
    </div>
  );
}
