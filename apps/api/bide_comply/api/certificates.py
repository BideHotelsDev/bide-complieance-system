"""Certificates and the expiry timeline (DOC-01, DOC-02, DSH-05)."""

import uuid
from datetime import date, timedelta

from fastapi import APIRouter, Query, Request
from pydantic import BaseModel
from sqlalchemy import insert, select, update

from bide_comply import audit, clock
from bide_comply.api import listing
from bide_comply.auth import Current, actor_for
from bide_comply.authz import scope_filter
from bide_comply.db import ConnDep
from bide_comply.schema import (
    action,
    certificate,
    evidence,
    person,
    property_,
    staff_requirement,
    staff_requirement_type,
)
from bide_comply.services import evidence as ev_service
from bide_comply.services.common import fmt_date, problem
from bide_comply.services.register import refresh_item

router = APIRouter(prefix="/api/certificates", tags=["certificates"])


def _status(c: dict, today: date) -> tuple[str, str]:
    if c["filing"] == "required":
        if c["expires_on"]:
            return "due", f"Due {fmt_date(c['expires_on'])}"
        return "missing", "Missing"
    if c["filing"] == "partial":
        return "partial", "Partly filed"
    if c["fail_count"]:
        return "fails", "Has open fails"
    if c["expires_on"] and c["expires_on"] < today:
        return "expired", "Expired"
    if c["expires_on"] and c["expires_on"] <= today + timedelta(days=60):
        return "expiring", f"Expires in {(c['expires_on'] - today).days} days"
    return "valid", "Valid"


@router.get("")
def list_certificates(
    pr: Current,
    conn: ConnDep,
    view: str = "all",
    q: str | None = None,
    prop: list[str] | None = Query(None),
    kind: list[str] | None = Query(None),
    property: uuid.UUID | None = None,
    page: int = 1,
    page_size: int = 25,
) -> dict:  # noqa: A002
    today = clock.today()
    qy = (
        select(
            certificate,
            property_.c.name.label("property"),
            property_.c.code,
            action.c.ref.label("action_ref"),
            evidence.c.file_name,
        )
        .outerjoin(property_, property_.c.id == certificate.c.property_id)
        .outerjoin(action, action.c.id == certificate.c.linked_action_id)
        .outerjoin(evidence, evidence.c.id == certificate.c.evidence_id)
        .where(
            certificate.c.superseded_by.is_(None),
            certificate.c.person_id.is_(None),
            scope_filter(pr, certificate.c.property_id),
        )
    )
    if property:
        qy = qy.where(certificate.c.property_id == property)
    rows = []
    for c in conn.execute(qy).mappings():
        c = dict(c)
        st, label = _status(c, today)
        rows.append(
            {
                "id": str(c["id"]),
                "title": c["title"],
                "property": c["property"],
                "property_code": c["code"],
                "property_id": str(c["property_id"]) if c["property_id"] else None,
                "why": c["why_needed"],
                "provider": c["provider_text"] or c["issuer"],
                "issuer": c["issuer"],
                "issued_on": c["issued_on"],
                "expires_on": c["expires_on"],
                "action_ref": c["action_ref"],
                "file_name": c["file_name"],
                "evidence_id": str(c["evidence_id"]) if c["evidence_id"] else None,
                "status": st,
                "status_label": label,
                "type": c["type"],
                "fail_count": c["fail_count"],
                "register_item_id": str(c["register_item_id"]) if c["register_item_id"] else None,
                "kind_label": "Required" if c["filing"] != "filed" else "On file",
            }
        )
    views = [
        listing.View("all", "All", lambda r: True),
        listing.View(
            "expiring",
            "Expiring in 60 days",
            lambda r: r["status"] in ("expiring", "due"),
            suffix=" expiring in 60 days",
        ),
        listing.View("expired", "Expired", lambda r: r["status"] == "expired", phrase="expired "),
        listing.View(
            "missing",
            "Missing",
            lambda r: r["status"] in ("missing", "partial", "due"),
            suffix=" that are required but not on file yet",
        ),
        listing.View("fails", "Has open fails", lambda r: r["status"] == "fails", suffix=" with open fails"),
    ]
    props = sorted({(r["property_code"], r["property"]) for r in rows if r["property"]}, key=lambda x: x[1])
    facets = [
        listing.Facet("prop", "Property", lambda r: r["property_code"], props, hint="Show certificates at"),
        listing.Facet("kind", "Kind", lambda r: r["kind_label"], [("On file", "On file"), ("Required", "Required")]),
    ]
    order = {"missing": 0, "due": 0, "fails": 1, "partial": 2, "expired": 1, "expiring": 3, "valid": 4}
    res = listing.run(
        rows,
        q=q,
        search=lambda r: f"{r['title']} {r['provider'] or ''} {r['property'] or ''}",
        views=views,
        view=view,
        facets=facets,
        selected={"prop": listing.multi(prop), "kind": listing.multi(kind)},
        sort=lambda r: (order[r["status"]], r["expires_on"] or date.max),
        page=page,
        page_size=page_size,
        noun=("certificate", "certificates"),
        where="across all properties" if not property and pr.scope is None else "",
        order_phrase="Most urgent first.",
    )
    # Timeline: the next 12 months of expiries, with the 60-day window marked (design: Expiry timeline).
    horizon = today + timedelta(days=365)
    marks = sorted(
        [r for r in rows if r["expires_on"] and today <= r["expires_on"] <= horizon and r["status"] != "missing"],
        key=lambda r: r["expires_on"],
    )
    months = [(today.replace(day=1) + timedelta(days=32 * i)).replace(day=1) for i in range(1, 13)]
    out = res.dump()
    out["timeline"] = {
        "today": today,
        "start": today,
        "end": horizon,
        "window_days": 60,
        "months": [{"date": m, "label": m.strftime("%b")} for m in months],
        "marks": [
            {
                "id": r["id"],
                "date": r["expires_on"],
                "title": r["title"],
                "property": r["property"],
                "status": r["status"],
            }
            for r in marks
        ],
    }
    return out


class UploadIn(BaseModel):
    evidence_id: uuid.UUID
    issued_on: date
    expires_on: date | None = None
    issuer: str | None = None
    property_id: uuid.UUID | None = None
    title: str | None = None


@router.post("/{certificate_id}/file")
def file_required(certificate_id: uuid.UUID, body: UploadIn, request: Request, pr: Current, conn: ConnDep) -> dict:
    """Upload against a required certificate. It closes its linked Action only if it has no fails."""
    c = conn.execute(select(certificate).where(certificate.c.id == certificate_id)).mappings().first()
    if not c:
        raise problem(404, "not_found", "Not found.")
    pr.require_property(c["property_id"])
    pr.require("assign", c["property_id"])
    if not ev_service.stored(conn, [body.evidence_id], pr.person_id):
        raise problem(422, "evidence", "The file didn't finish uploading. Try again.")
    conn.execute(
        update(certificate)
        .where(certificate.c.id == certificate_id)
        .values(
            filing="filed",
            evidence_id=body.evidence_id,
            issued_on=body.issued_on,
            expires_on=body.expires_on,
            issuer=body.issuer or c["issuer"],
        )
    )
    actor = actor_for(request, pr)
    audit.record(
        conn,
        actor,
        category="check",
        action="certificate.file",
        summary=f"Filed {c['title']}",
        entity_type="certificate",
        entity_id=certificate_id,
        property_id=c["property_id"],
        after={"issued_on": body.issued_on, "expires_on": body.expires_on},
    )
    if c["register_item_id"]:
        refresh_item(conn, c["register_item_id"])
    return {"ok": True, "linked_action": str(c["linked_action_id"]) if c["linked_action_id"] else None}


class NewIn(BaseModel):
    evidence_id: uuid.UUID
    property_id: uuid.UUID
    title: str
    issued_on: date
    expires_on: date | None = None
    issuer: str | None = None
    type: str = "other"
    replaces: uuid.UUID | None = None


@router.post("")
def file_new(body: NewIn, request: Request, pr: Current, conn: ConnDep) -> dict:
    """File a certificate that wasn't on the required list, or a renewal that replaces one on file."""
    pr.require_property(body.property_id)
    pr.require("assign", body.property_id)
    title = body.title.strip()
    if not title:
        raise problem(422, "title", "Say what the certificate is.")
    if not ev_service.stored(conn, [body.evidence_id], pr.person_id):
        raise problem(422, "evidence", "The file didn't finish uploading. Try again.")
    old = None
    if body.replaces:
        old = conn.execute(select(certificate).where(certificate.c.id == body.replaces)).mappings().first()
        if not old or old["property_id"] != body.property_id:
            raise problem(404, "not_found", "The certificate it replaces wasn't found.")
    new_id = uuid.uuid4()
    conn.execute(
        insert(certificate).values(
            id=new_id,
            property_id=body.property_id,
            register_item_id=old["register_item_id"] if old else None,
            type=old["type"] if old else (body.type or "other"),
            title=title,
            why_needed=old["why_needed"] if old else None,
            provider_text=old["provider_text"] if old else None,
            issuer=body.issuer,
            issued_on=body.issued_on,
            expires_on=body.expires_on,
            evidence_id=body.evidence_id,
            filing="filed",
        )
    )
    if old:
        conn.execute(update(certificate).where(certificate.c.id == old["id"]).values(superseded_by=new_id))
    audit.record(
        conn,
        actor_for(request, pr),
        category="check",
        action="certificate.file",
        summary=f"Filed {title}",
        entity_type="certificate",
        entity_id=new_id,
        property_id=body.property_id,
        after={"issued_on": body.issued_on, "expires_on": body.expires_on},
    )
    if old and old["register_item_id"]:
        refresh_item(conn, old["register_item_id"])
    return {"ok": True, "id": str(new_id)}


@router.get("/people")
def staff_certificates(pr: Current, conn: ConnDep) -> dict:
    """Staff requirements with expiry dates, for the same timeline (DSH-05)."""
    pr.require("people.view")
    today = clock.today()
    rows = conn.execute(
        select(staff_requirement, staff_requirement_type.c.name.label("requirement"), person.c.name)
        .join(staff_requirement_type, staff_requirement_type.c.id == staff_requirement.c.type_id)
        .join(person, person.c.id == staff_requirement.c.person_id)
        .where(staff_requirement.c.expires_on.isnot(None), person.c.employment_status == "active")
        .order_by(staff_requirement.c.expires_on)
    ).mappings()
    return {
        "rows": [
            {
                "person": r["name"],
                "requirement": r["requirement"],
                "expires_on": r["expires_on"],
                "days": (r["expires_on"] - today).days,
            }
            for r in rows
        ]
    }
