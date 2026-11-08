"""HTTP API.

The browser uploads the three files of the folder the operator picked once (POST /api/datasets);
the parsed dataset is kept in memory for the session so the replay can ask for the state at any
moment (GET /api/datasets/{id}/state?now=) without re-uploading. Every state request recomputes
detection and plans from the telemetry up to `now`.

    uv run uvicorn app.main:app --port 8000

When the built console exists (frontend/dist, or STATIC_DIR in the Docker image) it is served from
the same origin, so the deployed site needs no proxy; under `make demo` Vite serves it instead. A
presenter's console publishes its dataset and replay position to /api/live so phones on /live can follow it.
"""

from __future__ import annotations

import os
import threading
import uuid
from collections import OrderedDict
from pathlib import Path
from typing import Annotated, Any

from fastapi import FastAPI, File, Form, HTTPException, UploadFile
from fastapi.middleware.gzip import GZipMiddleware
from fastapi.responses import FileResponse
from pydantic import BaseModel

from app import notify as crew
from app.dataset import Dataset, parse_dataset, truncate
from app.detect import Event, detect, iso
from app.plan import FailurePlan, alert_order, plan_failures
from app.whatif import EarlyFix, early_fix

app: FastAPI = FastAPI(title="Oilgorithm")
# State JSON and the JS bundle shrink ~14x / ~3x; phones on /live pull /state every time the presenter moves.
app.add_middleware(GZipMiddleware, minimum_size=1024)

# Most recently used datasets, oldest first. A handful covers switching between folders in a demo.
MAX_DATASETS: int = 4
_datasets: OrderedDict[str, Dataset] = OrderedDict()
_lock: threading.Lock = threading.Lock()


def stored(dataset_id: str) -> Dataset:
    with _lock:
        ds: Dataset | None = _datasets.get(dataset_id)
        if ds is None:
            raise HTTPException(status_code=404, detail="dataset not loaded (server restarted?); choose the folder again")
        _datasets.move_to_end(dataset_id)
        return ds


@app.post("/api/datasets")
async def upload_dataset(
    network: Annotated[UploadFile, File(description="network.json")],
    ops: Annotated[UploadFile, File(description="ops.json")],
    telemetry: Annotated[UploadFile, File(description="telemetry.csv")],
    name: Annotated[str, Form()] = "dataset",
) -> dict[str, Any]:
    """Parse and keep a dataset; returns its id and time range ("now" defaults to the last row)."""
    try:
        ds: Dataset = parse_dataset(name, await network.read(), await ops.read(), telemetry.file)
    except ValueError as err:
        raise HTTPException(status_code=400, detail=str(err)) from err
    dataset_id: str = uuid.uuid4().hex
    with _lock:
        _datasets[dataset_id] = ds
        while len(_datasets) > MAX_DATASETS:
            _datasets.popitem(last=False)
    return {"dataset_id": dataset_id, **time_range(ds)}


def time_range(ds: Dataset) -> dict[str, Any]:
    step: int = int(ds.ts[1] - ds.ts[0]) if len(ds.ts) > 1 else 300
    return {"name": ds.name, "start_unix": int(ds.ts[0]), "end_unix": ds.now_unix, "step_s": step}


@app.get("/api/datasets/{dataset_id}/state")
def get_state(dataset_id: str, now: int | None = None) -> dict[str, Any]:
    """Detected events and pump-failure plans as an operator would see them at `now`
    (unix seconds; default: the last telemetry row). Nothing after `now` is used."""
    full: Dataset = stored(dataset_id)
    try:
        ds: Dataset = full if now is None else truncate(full, now)
    except ValueError as err:
        raise HTTPException(status_code=400, detail=str(err)) from err
    events: list[Event] = detect(ds)
    plans: dict[str, FailurePlan] = plan_failures(ds, events)
    for event in events:
        if event.event_id in plans:
            event.planning = plans[event.event_id].to_json()
    fix: EarlyFix = early_fix(ds, events)
    for event in fix.events:
        if event.event_id in fix.plans:
            event.planning = fix.plans[event.event_id].to_json()
    return {
        "dataset": ds.name,
        "start_unix": int(ds.ts[0]),
        "now_unix": ds.now_unix,
        "now_ts": iso(ds.now_unix),
        "alert_order": alert_order(events, plans),
        "events": [e.to_json() for e in events],
        "early_fix": fix.to_json(plans),
    }


# ---------------------------------------------------------------- crew notifications (placeholder sender)

class NotifyRequest(BaseModel):
    event_id: str
    contact_ids: list[str]
    message: str


@app.get("/api/contacts")
def get_contacts() -> dict[str, Any]:
    """The crew directory (placeholder data, see app/notify.py)."""
    try:
        return {"contacts": crew.load_contacts(), "placeholder": True}
    except (OSError, ValueError, KeyError) as err:
        raise HTTPException(status_code=500, detail=f"contacts file could not be read: {err}") from err


@app.post("/api/notify")
def post_notify(req: NotifyRequest) -> dict[str, Any]:
    """Send a decision to crew members. Placeholder sender: nothing is delivered yet."""
    if not req.contact_ids or not req.message.strip():
        raise HTTPException(status_code=400, detail="choose at least one recipient and write a message")
    return crew.notify(req.contact_ids, req.message.strip(), req.event_id)


@app.get("/api/notifications")
def get_notifications() -> dict[str, Any]:
    return {"sent": crew.sent_log()}


# ---------------------------------------------------------------- live view: phones follow the presenter

class LivePosition(BaseModel):
    dataset_id: str
    now: int
    early: bool = True


# What the presenter's console is showing, for phones on /live. One slot: whoever publishes last
# is the presenter. Kept apart from the dataset so a re-upload or eviction is noticed on read.
_live: LivePosition | None = None


@app.get("/api/live")
def get_live() -> dict[str, Any]:
    """The presenter's dataset and replay position; null when nothing is published or the dataset is gone."""
    with _lock:
        pos: LivePosition | None = _live
        ds: Dataset | None = _datasets.get(pos.dataset_id) if pos else None
    if pos is None or ds is None:
        return {"live": None}
    return {"live": {"dataset_id": pos.dataset_id, **time_range(ds), "now": pos.now, "early": pos.early}}


@app.post("/api/live")
def publish_live(pos: LivePosition) -> dict[str, Any]:
    """Presenter: publish the dataset and replay position (sent on every change)."""
    global _live
    stored(pos.dataset_id)  # 404 for an unknown dataset, so viewers never follow a dangling id
    with _lock:
        _live = pos
    return {"ok": True}


@app.delete("/api/live")
def clear_live() -> dict[str, Any]:
    """Presenter: stop publishing; viewers go back to waiting."""
    global _live
    with _lock:
        _live = None
    return {"ok": True}


@app.get("/api/health")
def health() -> dict[str, str]:
    """Liveness for the host's health check: the app imported and is serving."""
    return {"status": "ok"}


# ---------------------------------------------------------------- built frontend (production)

STATIC_DIR: Path = Path(
    os.environ.get("STATIC_DIR", Path(__file__).resolve().parents[2] / "frontend" / "dist")
).resolve()

if (STATIC_DIR / "index.html").is_file():
    # Registered last so every /api route wins. Unknown paths get index.html because the console
    # picks its view from the URL (/live); unknown /api paths still 404 as JSON.

    @app.get("/{path:path}", include_in_schema=False)
    def console(path: str) -> FileResponse:
        if path == "api" or path.startswith("api/"):
            raise HTTPException(status_code=404, detail="Not Found")
        file: Path = (STATIC_DIR / path).resolve()
        if file.is_file() and file.is_relative_to(STATIC_DIR):
            return FileResponse(file)
        return FileResponse(STATIC_DIR / "index.html")
