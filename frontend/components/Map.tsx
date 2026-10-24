"use client";

import "leaflet/dist/leaflet.css";
import { useState } from "react";
import {
  MapContainer,
  TileLayer,
  CircleMarker,
  Polyline,
  useMapEvents,
  useMap,
} from "react-leaflet";

const OXFORD_CENTER: [number, number] = [51.752, -1.2577];
const OXFORD_BOUNDS: [[number, number], [number, number]] = [
  [51.69, -1.37], // south-west
  [51.82, -1.14], // north-east
];

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
      </MapContainer>
    </div>
  );
}
