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

function TargetPin() {
  const [target, setTarget] = useState<L.LatLng | null>(null); // Target position, null until the user clicks

  // Attach map event handlers (react-leaflet removes them automatically on unmount)
  useMapEvents({
    click: (e) => setTarget(e.latlng), // Move the pin to wherever the user clicks
  });

  return target && <Marker position={target} icon={targetIcon} />; // Render the pin once placed, nothing before
}

function UserMarker() {
  const map = useMap(); // Get the Leaflet map instance
  const [pos, setPos] = useState<L.LatLng | null>(null); // User's position, null until found

  useEffect(() => {
    // Runs when the browser returns the user's location
    const onFound = (e: L.LocationEvent) => {
      if (OXFORD_BOUNDS.contains(e.latlng)) {
        // Only continue if inside Oxford bounds
        setPos(e.latlng); // Save position so the marker renders
        map.flyTo(e.latlng, 16); // Animate the map to the user, zoom 16
        console.log(e.latlng);
      }
    };

    // Register the listener, then ask the browser for the location
    map.on("locationfound", onFound).locate();

    // Cleanup on unmount: remove listener and stop locating
    return () => {
      map.off("locationfound", onFound).stopLocate();
    };
  }, [map]); // Re-run only if the map instance changes

  return pos && <Marker position={pos} icon={userIcon} />; // Render marker once we have a valid position, else nothing
}

export default function Map() {
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
        <UserMarker />
        <TargetPin />
      </MapContainer>
    </div>
  );
}
