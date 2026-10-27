"""Append-only, hash-chained audit log (AUD-01, §9.6).

Each event stores the SHA-256 of its own content plus the previous event's hash, so editing or removing any row
breaks the chain from that point on. The database refuses UPDATE and DELETE on the table (migration trigger); the
nightly job re-walks the chain and records the result as an event of its own.
"""

import hashlib
import json
import uuid
from dataclasses import dataclass
from datetime import UTC, date, datetime
from decimal import Decimal
from typing import Any

from sqlalchemy import Connection, select, text

from bide_comply import clock
from bide_comply.schema import audit_event

GENESIS = "0" * 64


def _default(o: Any) -> Any:
    if isinstance(o, (datetime, date)):
        return o.isoformat()
    if isinstance(o, uuid.UUID):
        return str(o)
    if isinstance(o, Decimal):
        return float(o)
    if isinstance(o, set):
        return sorted(o)
    raise TypeError(f"not serialisable: {type(o)}")


def canonical(obj: Any) -> str:
    return json.dumps(obj, sort_keys=True, separators=(",", ":"), default=_default, ensure_ascii=False)


def jsonable(obj: Any) -> Any:
    return json.loads(canonical(obj)) if obj is not None else None


def _hash(prev: str, payload: dict) -> str:
    return hashlib.sha256((prev + canonical(payload)).encode()).hexdigest()


@dataclass
class Actor:
    id: uuid.UUID | None
    label: str
    ip: str | None = None
    client: str | None = None


SYSTEM = Actor(None, "System")
NIGHTLY = Actor(None, "Nightly job")


def record(
    conn: Connection,
    actor: Actor,
    *,
    category: str,
    action: str,
    summary: str,
    entity_type: str | None = None,
    entity_id: uuid.UUID | None = None,
    entity_ref: str | None = None,
    property_id: uuid.UUID | None = None,
    before: dict | None = None,
    after: dict | None = None,
) -> None:
    # One writer at a time extends the chain; the lock is released when the request's transaction commits.
    conn.execute(text("SELECT pg_advisory_xact_lock(4242)"))
    prev = conn.execute(select(audit_event.c.hash).order_by(audit_event.c.seq.desc()).limit(1)).scalar() or GENESIS
    at = clock.now()
    eid = uuid.uuid4()
    payload = {
        "id": str(eid),
        "at": at.astimezone(UTC).isoformat(),
        "actor_id": str(actor.id) if actor.id else None,
        "actor_label": actor.label,
        "category": category,
        "action": action,
        "summary": summary,
        "entity_type": entity_type,
        "entity_id": str(entity_id) if entity_id else None,
        "entity_ref": entity_ref,
        "property_id": str(property_id) if property_id else None,
        "before": jsonable(before),
        "after": jsonable(after),
    }
    conn.execute(
        audit_event.insert().values(
            id=eid,
            at=at,
            actor_id=actor.id,
            actor_label=actor.label,
            category=category,
            action=action,
            summary=summary,
            entity_type=entity_type,
            entity_id=entity_id,
            entity_ref=entity_ref,
            property_id=property_id,
            before=payload["before"],
            after=payload["after"],
            ip=actor.ip,
            client=actor.client,
            prev_hash=prev,
            hash=_hash(prev, payload),
        )
    )


def verify_chain(conn: Connection) -> tuple[bool, int, int | None]:
    """Walk every event in order. Returns (intact, events checked, first broken seq)."""
    prev = GENESIS
    n = 0
    for row in conn.execute(select(audit_event).order_by(audit_event.c.seq)).mappings():
        payload = {
            "id": str(row["id"]),
            "at": row["at"].astimezone(UTC).isoformat(),
            "actor_id": str(row["actor_id"]) if row["actor_id"] else None,
            "actor_label": row["actor_label"],
            "category": row["category"],
            "action": row["action"],
            "summary": row["summary"],
            "entity_type": row["entity_type"],
            "entity_id": str(row["entity_id"]) if row["entity_id"] else None,
            "entity_ref": row["entity_ref"],
            "property_id": str(row["property_id"]) if row["property_id"] else None,
            "before": row["before"],
            "after": row["after"],
        }
        if row["prev_hash"] != prev or _hash(prev, payload) != row["hash"]:
            return False, n, row["seq"]
        prev = row["hash"]
        n += 1
    return True, n, None


def diff(before: dict, after: dict) -> tuple[dict, dict]:
    """Only the fields that changed, for a readable "Field · Before · After" view."""
    keys = [k for k in after if before.get(k) != after.get(k)]
    return {k: before.get(k) for k in keys}, {k: after.get(k) for k in keys}
