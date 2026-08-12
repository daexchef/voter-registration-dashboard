"""
Voter Registration Dashboard API + static frontend.

Endpoints:
  GET  /api/health
  GET  /api/states          full dataset (for map/table/charts)
  GET  /api/status          pipeline status
  POST /api/refresh         trigger scrape pipeline now
  GET  /api/geo/us-states   US states GeoJSON (cached proxy)

Also serves the dashboard static files from the project root.
"""

from __future__ import annotations

import logging
import os
from contextlib import asynccontextmanager
from pathlib import Path
from typing import Any

import httpx
from apscheduler.schedulers.asyncio import AsyncIOScheduler
from fastapi import FastAPI, Query, Response
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse, JSONResponse
from fastapi.staticfiles import StaticFiles

from pipeline import bootstrap_revision, get_revision, get_status, load_data, run_pipeline

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s %(levelname)s [%(name)s] %(message)s",
)
log = logging.getLogger("api")

ROOT = Path(__file__).resolve().parent.parent
GEO_CACHE = ROOT / "data" / "us-states.geojson"
GEO_SOURCE = (
    "https://raw.githubusercontent.com/PublicaMundi/MappingAPI/master/data/geojson/us-states.json"
)

# Default: refresh every 15 minutes
REFRESH_MINUTES = int(os.environ.get("PIPELINE_INTERVAL_MINUTES", "15"))
RUN_ON_STARTUP = os.environ.get("PIPELINE_RUN_ON_STARTUP", "1") not in ("0", "false", "False")

scheduler = AsyncIOScheduler()


async def _ensure_geojson() -> bytes:
    if GEO_CACHE.exists() and GEO_CACHE.stat().st_size > 1000:
        return GEO_CACHE.read_bytes()
    async with httpx.AsyncClient(timeout=60.0, follow_redirects=True) as client:
        resp = await client.get(GEO_SOURCE)
        resp.raise_for_status()
        GEO_CACHE.parent.mkdir(parents=True, exist_ok=True)
        GEO_CACHE.write_bytes(resp.content)
        return resp.content


async def _scheduled_job() -> None:
    log.info("Scheduled pipeline run")
    await run_pipeline(trigger="schedule")


@asynccontextmanager
async def lifespan(app: FastAPI):
    bootstrap_revision()
    # Warm GeoJSON cache (non-fatal)
    try:
        await _ensure_geojson()
        log.info("GeoJSON cache ready")
    except Exception as exc:  # noqa: BLE001
        log.warning("GeoJSON prefetch failed: %s", exc)

    scheduler.add_job(
        _scheduled_job,
        "interval",
        minutes=REFRESH_MINUTES,
        id="pipeline_refresh",
        replace_existing=True,
        max_instances=1,
        coalesce=True,
    )
    scheduler.start()
    log.info("Scheduler started: every %s minutes", REFRESH_MINUTES)

    if RUN_ON_STARTUP:
        # Fire-and-forget initial scrape so UI comes up immediately
        async def _startup_run():
            try:
                await run_pipeline(trigger="startup")
            except Exception as exc:  # noqa: BLE001
                log.warning("Startup pipeline: %s", exc)

        import asyncio

        asyncio.create_task(_startup_run())

    yield
    scheduler.shutdown(wait=False)
    log.info("Scheduler stopped")


app = FastAPI(
    title="Voter Registration Dashboard API",
    version="1.1.0",
    lifespan=lifespan,
)

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["*"],
    allow_headers=["*"],
)


@app.get("/api/health")
async def health() -> dict[str, Any]:
    return {
        "ok": True,
        "revision": get_revision(),
        "pipeline_interval_minutes": REFRESH_MINUTES,
    }


@app.get("/api/states")
async def api_states(response: Response) -> dict[str, Any]:
    data = load_data()
    rev = int(data.get("meta", {}).get("data_revision") or get_revision() or 0)
    response.headers["X-Data-Revision"] = str(rev)
    response.headers["Cache-Control"] = "no-store"
    # Attach live pipeline status snapshot
    data = dict(data)
    data["pipeline"] = get_status()
    return data


@app.get("/api/status")
async def api_status() -> dict[str, Any]:
    st = get_status()
    st["pipeline_interval_minutes"] = REFRESH_MINUTES
    st["data_revision"] = get_revision()
    return st


@app.post("/api/refresh")
async def api_refresh(
    force: bool = Query(False, description="Reserved; pipeline already de-dupes concurrent runs"),
) -> JSONResponse:
    result = await run_pipeline(trigger="manual")
    code = 200 if result.get("ok") else 409 if "already running" in (result.get("message") or "") else 500
    return JSONResponse(result, status_code=code)


@app.get("/api/geo/us-states")
async def api_geo() -> Response:
    try:
        raw = await _ensure_geojson()
    except Exception as exc:  # noqa: BLE001
        return JSONResponse(
            {"error": f"GeoJSON unavailable: {exc}", "source": GEO_SOURCE},
            status_code=502,
        )
    return Response(
        content=raw,
        media_type="application/geo+json",
        headers={"Cache-Control": "public, max-age=86400"},
    )


# Static assets
app.mount("/css", StaticFiles(directory=ROOT / "css"), name="css")
app.mount("/js", StaticFiles(directory=ROOT / "js"), name="js")
app.mount("/data", StaticFiles(directory=ROOT / "data"), name="data")


@app.get("/")
async def index() -> FileResponse:
    return FileResponse(ROOT / "index.html")


if __name__ == "__main__":
    import uvicorn

    uvicorn.run(
        "main:app",
        host="0.0.0.0",
        port=int(os.environ.get("PORT", "8080")),
        reload=False,
    )
