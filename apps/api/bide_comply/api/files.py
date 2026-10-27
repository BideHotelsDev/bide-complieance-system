"""Uploads and downloads (§9.4). Signed URLs expire after 5 minutes; every view of a staff document is logged."""

import uuid
from datetime import datetime

from fastapi import APIRouter, Request
from fastapi.responses import Response
from pydantic import BaseModel
from sqlalchemy import select

from bide_comply import audit
from bide_comply.auth import Current, actor_for
from bide_comply.config import settings
from bide_comply.db import ConnDep
from bide_comply.schema import evidence, staff_requirement
from bide_comply.services import evidence as ev_service
from bide_comply.services.common import problem
from bide_comply.storage import signer, storage

router = APIRouter(prefix="/api", tags=["files"])


class SlotIn(BaseModel):
    content_type: str
    size: int
    file_name: str | None = None
    captured_with: str = "upload"  # camera | upload
    property_id: uuid.UUID | None = None
    task_id: uuid.UUID | None = None
    captured_at: datetime | None = None
    purpose: str = "evidence"  # evidence | logo


@router.post("/uploads")
def create_upload(body: SlotIn, pr: Current, conn: ConnDep) -> dict:
    if body.property_id:
        pr.require_property(body.property_id)
    if body.captured_with not in ("camera", "upload"):
        raise problem(422, "captured_with", "Unknown capture method.")
    return ev_service.create_slot(
        conn,
        uploader=pr.person_id,
        content_type=body.content_type,
        size=body.size,
        original_name=body.file_name,
        captured_with=body.captured_with,
        property_id=body.property_id,
        task_id=body.task_id,
        captured_at=body.captured_at,
        purpose=body.purpose,
    )


@router.put("/files/upload/{token}")
async def local_upload(token: str, request: Request) -> dict:
    """The development storage backend's stand-in for an S3 presigned PUT."""
    try:
        d = signer.load(token, settings.signed_url_seconds)
    except PermissionError:
        raise problem(403, "expired", "The upload link expired. Try again.") from None
    if d.get("op") != "put":
        raise problem(403, "expired", "The upload link expired. Try again.")
    data = await request.body()
    if len(data) > d["m"]:
        raise problem(413, "size", "That file is too big.")
    if request.headers.get("content-type", "").split(";")[0] != d["t"]:
        raise problem(415, "type", "Wrong file type for this upload.")
    try:
        storage.put(d["k"], data, d["t"])
    except FileExistsError:
        raise problem(409, "exists", "This upload has already been used.") from None
    return {"ok": True}


class CompleteIn(BaseModel):
    task_id: uuid.UUID | None = None


@router.post("/uploads/{evidence_id}/complete")
def complete_upload(evidence_id: uuid.UUID, body: CompleteIn, pr: Current, conn: ConnDep) -> dict:
    ev = ev_service.complete(conn, evidence_id, pr.person_id, body.task_id)
    return ev_service.view(ev, thumb=True)


@router.get("/evidence/{evidence_id}")
def view_evidence(evidence_id: uuid.UUID, request: Request, pr: Current, conn: ConnDep) -> dict:
    ev = conn.execute(select(evidence).where(evidence.c.id == evidence_id)).mappings().first()
    if not ev or ev["status"] != "stored":
        raise problem(404, "not_found", "Not found.")
    pr.require_property(ev["property_id"])
    # Staff identity and right-to-work documents: register keeper and Super Admin only, and the person themselves.
    req = conn.execute(
        select(staff_requirement.c.person_id).where(staff_requirement.c.evidence_id == evidence_id)
    ).first()
    if req:
        if req.person_id != pr.person_id and not pr.can("identity_docs.view"):
            raise problem(404, "not_found", "Not found.")
        audit.record(
            conn,
            actor_for(request, pr),
            category="record",
            action="document.view",
            summary="Viewed a staff document",
            entity_type="evidence",
            entity_id=evidence_id,
        )
    if ev["scan_status"] != "clean":
        raise problem(409, "scanning", "This file is still being checked. Try again in a minute.")
    return ev_service.view(dict(ev))


@router.get("/files/download/{token}")
def local_download(token: str) -> Response:
    try:
        d = signer.load(token, settings.signed_url_seconds)
    except PermissionError:
        raise problem(403, "expired", "This link has expired. Open the file again.") from None
    if d.get("op") != "get":
        raise problem(403, "expired", "This link has expired.")
    data = storage.get(d["k"])
    from bide_comply.storage import sniff

    ctype = sniff(data) or "application/octet-stream"
    disp = "inline" if d.get("i") else "attachment"
    return Response(
        data,
        media_type=ctype,
        headers={"Content-Disposition": f'{disp}; filename="{d["n"]}"', "Cache-Control": "private, max-age=300"},
    )
