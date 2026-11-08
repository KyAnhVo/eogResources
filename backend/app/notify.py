"""Crew notifications: who to tell about a decision, and the (placeholder) sender.

Contacts come from backend/contacts.json (PLACEHOLDER data for now; override the path with
CONTACTS_FILE). Sending is a stub: `send_via_photon` records the message and returns
"placeholder" without contacting anyone. Replace its body with the real Photon API call once the
API details are known, reading the key from an environment variable (never from the browser).
"""

from __future__ import annotations

import json
import os
import threading
import time
from pathlib import Path
from typing import Any

CONTACTS_FILE: Path = Path(os.environ.get("CONTACTS_FILE", Path(__file__).resolve().parents[1] / "contacts.json"))

_sent: list[dict[str, Any]] = []  # this session's notifications, newest last
_lock: threading.Lock = threading.Lock()


def load_contacts() -> list[dict[str, Any]]:
    data: Any = json.loads(CONTACTS_FILE.read_text())
    return list(data["contacts"] if isinstance(data, dict) else data)


def send_via_photon(contact: dict[str, Any], message: str) -> dict[str, Any]:
    """PLACEHOLDER: nothing leaves this machine. Swap in the Photon API request here, e.g. using
    os.environ["PHOTON_API_KEY"], and return its delivery status."""
    return {"to": contact["id"], "phone": contact["phone"], "email": contact["email"], "status": "placeholder"}


def notify(contact_ids: list[str], message: str, event_id: str) -> dict[str, Any]:
    """Send `message` to each known contact id; unknown ids are reported, not sent."""
    by_id: dict[str, dict[str, Any]] = {c["id"]: c for c in load_contacts()}
    results: list[dict[str, Any]] = []
    unknown: list[str] = []
    for cid in contact_ids:
        contact: dict[str, Any] | None = by_id.get(cid)
        if contact is None:
            unknown.append(cid)
            continue
        results.append(send_via_photon(contact, message))
    record: dict[str, Any] = {"event_id": event_id, "sent_unix": int(time.time()), "message": message, "results": results, "unknown": unknown}
    with _lock:
        _sent.append(record)
    return record


def sent_log() -> list[dict[str, Any]]:
    with _lock:
        return list(_sent)
