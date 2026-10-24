"use client";

import "leaflet/dist/leaflet.css";
import { useState, useEffect } from "react";
import {
  MapContainer,
  TileLayer,
  Marker,
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
  //////////////////////////////////////////////////////////////////////////

  // In Map: send start/end, get the route back
  const sendPositions = async () => {
    if (!userPos || !targetPos) return; // Need both points
    const res = await fetch("/api/route", {
      // Proxied to FastAPI /route
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        start: { lat: userPos.lat, lon: userPos.lng }, // Match RouteRequest.start shape
        end: { lat: targetPos.lat, lon: targetPos.lng }, // Match RouteRequest.end shape
        profile: "regular", // Must be a value your backend accepts
        depart_at: "null", // Only if the model requires it
      }),
    });
    if (!res.ok) return console.warn(res.status, (await res.json()).detail); // 404/422/503 reasons
    console.log(await res.json()); // The route
  };

  return (
    <div className="h-full w-full">
      <MapContainer
        center={OXFORD_CENTER}
        zoom={14}
        minZoom={12}
        maxBounds={OXFORD_BOUNDS}
        maxBoundsViscosity={1.0}
        className="h-full w-full"
      >
        <TileLayer
          url="https://tile.openstreetmap.org/{z}/{x}/{y}.png"
          attribution="&copy; OpenStreetMap contributors"
        />
        <UserMarker pos={userPos} setPos={setUserPos} />
        <TargetPin target={targetPos} setTarget={setTargetPos} />
      </MapContainer>
      {/* Button inside the wrapper div, outside <MapContainer> */}
      {/*z-[1000] sits above Leaflet's panes */}
      <button
        onClick={sendPositions}
        className="absolute top-4 left-1/2 z-[1000] -translate-x-1/2 rounded bg-blue-600 px-4 py-2 text-white disabled:opacity-50"
        disabled={!userPos || !targetPos}
      >
        Ride
      </button>
    </div>
  );
}
