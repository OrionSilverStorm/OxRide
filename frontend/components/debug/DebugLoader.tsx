"use client";

import dynamic from "next/dynamic";

// Leaflet needs the browser, so the panel only renders on the client.
const DebugPanel = dynamic(() => import("./DebugPanel"), {
  ssr: false,
  loading: () => <div className="p-4 text-sm text-neutral-500">Loading debug panel…</div>,
});

export default DebugPanel;
