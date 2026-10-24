"""API endpoints."""

from fastapi import FastAPI

app = FastAPI(title="OxRide")


@app.get("/health")
def health() -> dict:
    return {"status": "ok"}
