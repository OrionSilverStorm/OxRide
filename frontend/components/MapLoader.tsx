"use client";

import dynamic from "next/dynamic";

const Map = dynamic(() => import("./Map"), {
  ssr: false,
  loading: () => <div className="map-loading h-full w-full bg-background" />,
});

export default Map;
