import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  /* config options here */
  experimental: {
    agentFeedback: true,
  },
  // The browser only ever calls this site (/api/...). Locally (npm run dev) Next
  // forwards /api to uvicorn. On Vercel, vercel.json sends /api to the backend
  // service before Next sees it, so this rewrite is only used locally.
  async rewrites() {
    const backend = process.env.BACKEND_URL ?? "http://localhost:8000";
    return [{ source: "/api/:path*", destination: `${backend}/:path*` }, { source: "/api/navigation", destination: "http://localhost:8000/navigation" }];
  },
  cacheComponents: true,
  partialPrefetching: true,
  turbopack: {
    rules: {
      "*.css": {
        loaders: ["@tailwindcss/turbopack"],
        as: "*.css",
      },
    },
  },
};

export default nextConfig;