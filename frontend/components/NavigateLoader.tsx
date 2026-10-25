"use client";

import dynamic from "next/dynamic";

// Leaflet and sessionStorage need the browser, so the navigation screen renders on the client only.
const Navigator = dynamic(() => import("./Navigator"), {
  ssr: false,
  loading: () => <div className="h-dvh w-full bg-neutral-200" />,
});

export default Navigator;
