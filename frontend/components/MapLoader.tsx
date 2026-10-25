"use client";

import dynamic from "next/dynamic";

// The map only works in the browser (Leaflet needs `window`), so it loads after the page.
// Meanwhile a plain box in the theme's background colour fills the screen; map-loading
// makes it dark on phones in dark mode (globals.css) so there's no light flash.
const Map = dynamic(() => import("./Map"), {
  ssr: false,
  loading: () => <div className="map-loading h-full w-full bg-background" />,
});

export default Map;
