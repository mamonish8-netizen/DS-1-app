"""FastAPI entrypoint, CORS middleware, WebSocket telemetry stream, and static frontend mount."""

from __future__ import annotations

import asyncio
from collections import deque
from contextlib import asynccontextmanager
from pathlib import Path
from typing import Any

from fastapi import FastAPI, WebSocket, WebSocketDisconnect
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse, HTMLResponse
from fastapi.staticfiles import StaticFiles

from backend.api.routes import TelemetryFrame, TelemetryHistoryPoint, build_telemetry_frame, router
from backend.core.config import PROJECT_ROOT, settings
from backend.core.database import db
from backend.services.hardware_reader import hardware_reader
from backend.services.tuner_controller import tuner_controller


class TelemetryConnectionManager:
    """Tracks active WebSocket clients and broadcasts live TelemetryFrame payloads."""

    def __init__(self) -> None:
        self._connections: set[WebSocket] = set()

    async def connect(self, websocket: WebSocket) -> None:
        await websocket.accept()
        self._connections.add(websocket)

    def disconnect(self, websocket: WebSocket) -> None:
        self._connections.discard(websocket)

    async def broadcast(self, payload: dict[str, Any]) -> None:
        if not self._connections:
            return
        stale: list[WebSocket] = []
        for ws in list(self._connections):
            try:
                await ws.send_json(payload)
            except Exception:
                stale.append(ws)
        for ws in stale:
            self._connections.discard(ws)


ws_manager = TelemetryConnectionManager()


async def _telemetry_sampler_loop(app: FastAPI) -> None:
    """Continuously samples hardware telemetry, updates ring buffer, logs SQLite TGP, and broadcasts."""
    tick = 0
    while True:
        try:
            persist_now = tick % settings.db_write_interval_ticks == 0
            frame: TelemetryFrame = await build_telemetry_frame(persist_peaks=persist_now)
            app.state.latest_frame = frame

            history_buffer: deque[TelemetryHistoryPoint] = app.state.history_buffer
            history_buffer.append(frame.history_point)

            if persist_now:
                await db.insert_tgp_log(
                    recorded_at=frame.timestamp,
                    epoch_ms=frame.epoch_ms,
                    cpu_temp_c=frame.cpu.temp_c,
                    gpu_temp_c=frame.gpu.temp_c,
                    cpu_power_w=frame.cpu.package_power_w,
                    gpu_power_w=frame.gpu.power_w,
                    gpu_voltage_mv=frame.gpu.voltage_mv,
                    cpu_voltage_mv=frame.cpu.voltage_mv,
                    fan_rpm=frame.cpu.fan_rpm,
                    fan_pct=frame.cpu.fan_pct,
                    active_profile=frame.active_profile,
                )

            await ws_manager.broadcast(frame.model_dump())
            tick += 1
        except asyncio.CancelledError:
            raise
        except Exception as exc:
            # Keep sampler alive across transient sensor read errors
            print(f"[AeroCool Telemetry Loop] Non-fatal sampling error: {exc}")

        await asyncio.sleep(settings.poll_interval_seconds)


@asynccontextmanager
async def lifespan(app: FastAPI):
    await db.init_db()
    await tuner_controller.load_state()

    max_points = max(60, int(settings.history_buffer_seconds / settings.poll_interval_seconds))
    app.state.history_buffer = deque(maxlen=max_points)
    app.state.latest_frame = await build_telemetry_frame(persist_peaks=False)
    app.state.history_buffer.append(app.state.latest_frame.history_point)

    sampler_task = asyncio.create_task(_telemetry_sampler_loop(app))
    try:
        yield
    finally:
        sampler_task.cancel()
        try:
            await sampler_task
        except asyncio.CancelledError:
            pass
        hardware_reader.shutdown()


app = FastAPI(
    title=settings.app_name,
    version=settings.app_version,
    description="Real-time hardware thermal telemetry, TGP process tracking, and cooling tuner backend.",
    lifespan=lifespan,
)

app.add_middleware(
    CORSMiddleware,
    allow_origins=settings.cors_origins,
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

app.include_router(router)


@app.websocket("/ws/telemetry")
async def websocket_telemetry_endpoint(websocket: WebSocket) -> None:
    await ws_manager.connect(websocket)
    try:
        latest: TelemetryFrame | None = getattr(app.state, "latest_frame", None)
        if latest is not None:
            await websocket.send_json(latest.model_dump())

        while True:
            raw_msg = await websocket.receive_text()
            if raw_msg.strip() == "ping":
                await websocket.send_json({"type": "pong"})
    except WebSocketDisconnect:
        ws_manager.disconnect(websocket)
    except Exception:
        ws_manager.disconnect(websocket)


def _resolve_frontend_dist() -> Path | None:
    candidates = [
        PROJECT_ROOT / "frontend" / "dist",
        PROJECT_ROOT / "frontend" / "build",
        PROJECT_ROOT / "dist",
    ]
    for candidate in candidates:
        if (candidate / "index.html").is_file():
            return candidate
    return None


_FRONTEND_DIST = _resolve_frontend_dist()

if _FRONTEND_DIST is not None:
    assets_dir = _FRONTEND_DIST / "assets"
    if assets_dir.is_dir():
        app.mount("/assets", StaticFiles(directory=str(assets_dir)), name="frontend-assets")

    @app.get("/{full_path:path}", include_in_schema=False)
    async def serve_spa(full_path: str):
        candidate_file = _FRONTEND_DIST / full_path
        if full_path and candidate_file.is_file():
            return FileResponse(str(candidate_file))
        return FileResponse(str(_FRONTEND_DIST / "index.html"))
else:
    @app.get("/", response_class=HTMLResponse, include_in_schema=False)
    async def backend_status_page() -> str:
        return """<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>AeroCool Monitor — Telemetry Backend</title>
  <style>
    body { font-family: Inter, system-ui, sans-serif; background: #ffffff; color: #0f172a; margin: 0; padding: 48px 24px; }
    .card { max-width: 680px; margin: 0 auto; border: 1px solid #e2e8f0; border-radius: 12px; padding: 32px; }
    h1 { margin: 0 0 8px; font-size: 24px; }
    p { color: #475569; line-height: 1.6; }
    code { background: #f1f5f9; padding: 2px 6px; border-radius: 4px; font-size: 13px; }
    .links { display: flex; gap: 12px; margin-top: 24px; flex-wrap: wrap; }
    a { text-decoration: none; padding: 10px 16px; border-radius: 8px; font-weight: 600; font-size: 14px; }
    .primary { background: #38bdf8; color: #082f49; }
    .secondary { background: #fff7ed; color: #c2410c; border: 1px solid #fdba74; }
  </style>
</head>
<body>
  <div class="card">
    <h1>AeroCool Monitor Backend Active</h1>
    <p>FastAPI hardware telemetry and WebSocket streaming server is running. Build your frontend into <code>frontend/dist</code> to serve the UI directly from this port, or connect your Stitch/Vite frontend to <code>ws://127.0.0.1:8000/ws/telemetry</code>.</p>
    <div class="links">
      <a class="primary" href="/docs">Open API Docs</a>
      <a class="secondary" href="/api/telemetry/current">Inspect Live Telemetry JSON</a>
    </div>
  </div>
</body>
</html>"""
