"""Entry point on Vercel (see vercel.json).

On Vercel the public URLs are /api/route, /api/health, ... and the backend receives
that full path. main.py's routes have no /api prefix (locally Next strips it), so here
the same app is mounted under /api. main.lifespan still loads the graph at startup.
"""

from fastapi import FastAPI

import main

app = FastAPI(lifespan=main.lifespan)
app.mount("/api", main.app)
