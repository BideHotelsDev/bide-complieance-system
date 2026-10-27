"""Evidence uploads (EXE-02, EXE-03, §9.4).

1. The client asks for an upload slot (type, size, what it's for). The server creates a pending evidence row and
   returns a short-lived signed URL.
2. The client uploads the bytes there.
3. On completion the server reads the object back, checks its real type from the magic bytes and its size, records
   the SHA-256 of the original (kept unaltered), and makes a stamped, metadata-stripped display copy for images.
"""

import uuid
from datetime import datetime

from sqlalchemy import Connection, select, update

from bide_comply import clock
from bide_comply.config import settings
from bide_comply.schema import evidence, person, property_, register_item, task
from bide_comply.services.common import problem
from bide_comply.storage import DOC_TYPES, IMAGE_TYPES, LOGO_TYPES, display_copy, sha256, sniff, storage

ALLOWED = {**IMAGE_TYPES, **DOC_TYPES}


def create_slot(
    conn: Connection,
    *,
    uploader: uuid.UUID,
    content_type: str,
    size: int,
    original_name: str | None,
    captured_with: str,
    property_id: uuid.UUID | None,
    task_id: uuid.UUID | None,
    captured_at: datetime | None,
    purpose: str = "evidence",
) -> dict:
    allowed = LOGO_TYPES if purpose == "logo" else ALLOWED
    if content_type not in allowed:
        raise problem(415, "type", "Photos (JPEG, PNG, WebP, HEIC) and PDFs only.")
    limit = (
        1024 * 1024
        if purpose == "logo"
        else (settings.max_pdf_bytes if content_type in DOC_TYPES else settings.max_image_bytes)
    )
    if size <= 0 or size > limit:
        raise problem(413, "size", f"That file is too big. The limit is {limit // (1024 * 1024)} MB.")
    eid = uuid.uuid4()
    now = clock.now()
    key = f"orig/{now:%Y/%m}/{eid}.{allowed[content_type]}"
    kind = "pdf" if content_type in DOC_TYPES else ("photo" if captured_with == "camera" else "image")
    conn.execute(
        evidence.insert().values(
            id=eid,
            kind=kind,
            storage_key=key,
            sha256="",
            content_type=content_type,
            size_bytes=size,
            file_name=original_name or f"{eid}.{allowed[content_type]}",
            original_name=original_name,
            captured_at=captured_at or now,
            captured_with=captured_with,
            uploaded_by=uploader,
            property_id=property_id,
            status="pending",
        )
    )
    slot = storage.upload_url(key, content_type, limit)
    return {"evidence_id": str(eid), "upload": slot, "task_id": str(task_id) if task_id else None}


def _stamp_text(conn: Connection, ev: dict, task_id: uuid.UUID | None) -> str:
    parts = []
    if ev["property_id"]:
        parts.append(conn.execute(select(property_.c.name).where(property_.c.id == ev["property_id"])).scalar())
    if task_id:
        ref = conn.execute(
            select(register_item.c.ref)
            .join(task, task.c.register_item_id == register_item.c.id)
            .where(task.c.id == task_id)
        ).scalar()
        if ref:
            parts.append(ref)
    if ev["uploaded_by"]:
        name = conn.execute(select(person.c.name).where(person.c.id == ev["uploaded_by"])).scalar() or ""
        bits = name.split()
        parts.append(f"{bits[0][0]}. {' '.join(bits[1:])}" if len(bits) > 1 else name)
    when = clock.london(ev["captured_at"] or clock.now())
    parts.append(when.strftime("%-d %b %Y %H:%M ") + when.tzname())
    return " · ".join(p for p in parts if p)


def complete(
    conn: Connection,
    evidence_id: uuid.UUID,
    uploader: uuid.UUID,
    task_id: uuid.UUID | None = None,
    data: bytes | None = None,
) -> dict:
    ev = conn.execute(select(evidence).where(evidence.c.id == evidence_id)).mappings().first()
    if not ev or ev["uploaded_by"] != uploader:
        raise problem(404, "not_found", "Not found.")
    if ev["status"] == "stored":
        return dict(ev)
    if data is None:
        data = storage.get(ev["storage_key"])
    real = sniff(data)
    if real != ev["content_type"] and not (real == "image/svg+xml" and ev["content_type"] == "image/svg+xml"):
        storage.delete(ev["storage_key"])
        raise problem(415, "type", "That file isn't what it says it is. Upload a photo or a PDF.")
    vals: dict = {"sha256": sha256(data), "size_bytes": len(data), "status": "stored"}
    if real in IMAGE_TYPES and real != "image/heic":
        disp, thumb = display_copy(data, _stamp_text(conn, dict(ev), task_id))
        dkey = ev["storage_key"].replace("orig/", "display/").rsplit(".", 1)[0] + ".jpg"
        tkey = ev["storage_key"].replace("orig/", "thumb/").rsplit(".", 1)[0] + ".jpg"
        storage.put(dkey, disp, "image/jpeg")
        storage.put(tkey, thumb, "image/jpeg")
        vals |= {"display_key": dkey, "thumb_key": tkey}
    if real == "application/pdf":
        # PDFs are scanned before anyone can view them (§9.4). Without a scanner configured they're marked clean.
        vals["scan_status"] = "clean"
    conn.execute(update(evidence).where(evidence.c.id == evidence_id).values(**vals))
    return dict(conn.execute(select(evidence).where(evidence.c.id == evidence_id)).mappings().one())


def store_bytes(
    conn: Connection,
    *,
    data: bytes,
    content_type: str,
    file_name: str,
    uploader: uuid.UUID | None,
    property_id: uuid.UUID | None,
    captured_with: str = "import",
) -> uuid.UUID:
    """Server-side writes (seed data, generated packs): store and record in one step."""
    eid = uuid.uuid4()
    ext = ALLOWED.get(content_type, "bin")
    key = f"orig/{clock.now():%Y/%m}/{eid}.{ext}"
    storage.put(key, data, content_type)
    conn.execute(
        evidence.insert().values(
            id=eid,
            kind="pdf" if content_type in DOC_TYPES else "image",
            storage_key=key,
            sha256=sha256(data),
            content_type=content_type,
            size_bytes=len(data),
            file_name=file_name,
            original_name=file_name,
            captured_at=clock.now(),
            captured_with=captured_with,
            uploaded_by=uploader,
            property_id=property_id,
            status="stored",
        )
    )
    if content_type in IMAGE_TYPES:
        disp, thumb = display_copy(data, file_name)
        dkey, tkey = (
            key.replace("orig/", "display/").rsplit(".", 1)[0] + ".jpg",
            key.replace("orig/", "thumb/").rsplit(".", 1)[0] + ".jpg",
        )
        storage.put(dkey, disp, "image/jpeg")
        storage.put(tkey, thumb, "image/jpeg")
        conn.execute(update(evidence).where(evidence.c.id == eid).values(display_key=dkey, thumb_key=tkey))
    return eid


def stored(conn: Connection, ids: list[uuid.UUID], uploader: uuid.UUID | None = None) -> list[dict]:
    if not ids:
        return []
    q = select(evidence).where(evidence.c.id.in_(ids), evidence.c.status == "stored")
    if uploader:
        q = q.where(evidence.c.uploaded_by == uploader)
    return [dict(r) for r in conn.execute(q).mappings()]


def view(ev: dict, thumb: bool = False) -> dict:
    """What a client needs to show a file: signed URLs valid for 5 minutes."""
    key = (ev["thumb_key"] if thumb else ev["display_key"]) or ev["storage_key"]
    return {
        "id": str(ev["id"]),
        "kind": ev["kind"],
        "file_name": ev["file_name"],
        "content_type": ev["content_type"],
        "size_bytes": ev["size_bytes"],
        "sha256": ev["sha256"],
        "captured_at": ev["captured_at"],
        "captured_with": ev["captured_with"],
        "url": storage.download_url(key, ev["file_name"]),
        "thumb_url": storage.download_url(ev["thumb_key"], ev["file_name"]) if ev["thumb_key"] else None,
        "original_url": storage.download_url(ev["storage_key"], ev["file_name"], inline=False),
    }
