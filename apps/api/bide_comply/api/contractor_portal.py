"""Contractor portal (design: ContractorPortal) and the staff side of what contractors send (Evidence review).

- /api/contractor-portal: for a signed-in contractor contact only. Their visits and the Actions bide has given them;
  "Upload the report after your visit"; "Mark as fixed, add photo". Scoped to their own contractor, never by property.
- /api/contractor-uploads: for verifiers. One upload to check, then approve or send back with a comment.
- /api/contractor-portal/invite: an admin gives a contractor contact portal access and emails the sign-in link.
"""

import uuid

from fastapi import APIRouter, Request
from pydantic import BaseModel
from sqlalchemy import select

from bide_comply import audit, auth
from bide_comply.auth import Current, actor_for
from bide_comply.db import ConnDep
from bide_comply.schema import contractor, contractor_contact, person, role_assignment
from bide_comply.services import contractor_portal as service
from bide_comply.services.common import problem

router = APIRouter(prefix="/api/contractor-portal", tags=["contractor portal"])
staff_router = APIRouter(prefix="/api/contractor-uploads", tags=["contractor portal"])


@router.get("")
def portal(pr: Current, conn: ConnDep) -> dict:
    return service.portal(conn, pr)


class SendIn(BaseModel):
    evidence_ids: list[uuid.UUID]
    note: str | None = None


@router.post("/visits/{visit_id}/report")
def send_report(visit_id: uuid.UUID, body: SendIn, request: Request, pr: Current, conn: ConnDep) -> dict:
    return service.send_report(conn, pr, actor_for(request, pr), visit_id, body.evidence_ids, body.note)


@router.post("/actions/{action_id}/fix")
def send_fix(action_id: uuid.UUID, body: SendIn, request: Request, pr: Current, conn: ConnDep) -> dict:
    return service.send_fix(conn, pr, actor_for(request, pr), action_id, body.evidence_ids, body.note)


class InviteIn(BaseModel):
    contractor_id: uuid.UUID
    email: str
    name: str | None = None


@router.post("/invite")
def invite(body: InviteIn, request: Request, pr: Current, conn: ConnDep) -> dict:
    """Link a contact to a contractor (creating them as an outside person if new) and email the 7-day link."""
    pr.require("people.manage")
    c = conn.execute(select(contractor).where(contractor.c.id == body.contractor_id)).mappings().first()
    email = body.email.strip().lower()
    if not c:
        raise problem(404, "not_found", "Not found.")
    if "@" not in email:
        raise problem(422, "email", "Enter the contractor's email address.")
    p = conn.execute(select(person).where(person.c.email == email)).mappings().first()
    if p and p["kind"] != "external":
        raise problem(409, "staff", "That address belongs to a member of staff. Use the contractor's own address.")
    pid = p["id"] if p else uuid.uuid4()
    if not p:
        conn.execute(
            person.insert().values(
                id=pid,
                name=(body.name or c["name"]).strip(),
                email=email,
                title=f"Contractor · {c['name']}",
                kind="external",
            )
        )
    linked = conn.execute(
        select(contractor_contact.c.contractor_id).where(contractor_contact.c.person_id == pid)
    ).scalar()
    if linked and linked != c["id"]:
        raise problem(409, "linked", "That address is already linked to another contractor.")
    if not linked:
        conn.execute(contractor_contact.insert().values(id=uuid.uuid4(), contractor_id=c["id"], person_id=pid))
    if not conn.execute(
        select(role_assignment.c.id).where(role_assignment.c.person_id == pid, role_assignment.c.role == "contractor")
    ).first():
        conn.execute(
            role_assignment.insert().values(id=uuid.uuid4(), person_id=pid, role="contractor", property_id=None)
        )
    auth.magic_request(auth.MagicIn(email=email, app="field"), conn)
    audit.record(
        conn,
        actor_for(request, pr),
        category="settings",
        action="contractor.invite",
        summary=f"Sent {c['name']} a contractor portal link ({email})",
        entity_type="contractor",
        entity_id=c["id"],
        after={"person_id": str(pid)},
    )
    return {"person_id": str(pid), "ok": True}


@staff_router.get("")
def queue(pr: Current, conn: ConnDep, property: uuid.UUID | None = None) -> dict:  # noqa: A002
    pr.require("verify")
    return {"rows": service.pending_cards(conn, pr, property)}


@staff_router.get("/{upload_id}")
def detail(upload_id: uuid.UUID, pr: Current, conn: ConnDep) -> dict:
    return service.detail(conn, pr, upload_id)


class DecideIn(BaseModel):
    result: str  # approved | rejected
    comment: str | None = None


@staff_router.post("/{upload_id}/decide")
def decide(upload_id: uuid.UUID, body: DecideIn, request: Request, pr: Current, conn: ConnDep) -> dict:
    return service.decide(conn, pr, actor_for(request, pr), upload_id, body.result, body.comment)
