"""Property administration (§6 Admin CMS › Properties): details, features that drive applies-to rules, geofence,
licences and their conditions (CMS-11), locations and assets with QR codes, legal hold (AUD-04). Plus web push
subscriptions, saved views (§10.4) and the data-subject export (§9.7).
"""

import io
import json
import secrets
import uuid
import zipfile
from datetime import date

from fastapi import APIRouter, Request
from fastapi.responses import Response
from pydantic import BaseModel
from sqlalchemy import select, update

from bide_comply import audit, clock
from bide_comply.api.register import resolve_property
from bide_comply.audit import canonical
from bide_comply.auth import Current, actor_for
from bide_comply.db import ConnDep
from bide_comply.schema import (
    action,
    approval_request,
    audit_event,
    dutyholder,
    evidence,
    leave,
    licence,
    location,
    location_type,
    notification,
    person,
    property_,
    push_subscription,
    role_assignment,
    saved_view,
    staff_requirement,
    submission,
    verification,
)
from bide_comply.services.common import problem

router = APIRouter(prefix="/api", tags=["admin"])

FEATURES = {
    "has_fire_alarm": "Fire alarm",
    "has_gas": "Gas heating",
    "has_oil": "Oil heating",
    "has_stove": "Stove or flue",
    "has_hot_tub": "Hot tub",
    "has_sauna": "Sauna",
    "has_salto": "Salto doors",
    "has_lift": "Lift",
    "has_food": "Food prepared or served",
    "has_alcohol": "Alcohol sold",
    "has_cctv": "CCTV",
    "unmanned": "Unmanned (keyholder response)",
    "pre_2000": "Built before 2000 (asbestos register)",
    "sponsor_licence": "SPV holds a sponsor licence",
    "visitor_levy": "Council runs a visitor levy",
}


def _detail(conn, p: dict) -> dict:
    lic = [dict(r) for r in conn.execute(select(licence).where(licence.c.property_id == p["id"])).mappings()]
    locs = [
        dict(r)
        for r in conn.execute(
            select(location).where(location.c.property_id == p["id"]).order_by(location.c.sort)
        ).mappings()
    ]
    dh = (
        conn.execute(select(dutyholder.c.name).where(dutyholder.c.id == p["dutyholder_id"])).scalar()
        if p["dutyholder_id"]
        else None
    )
    return {
        "id": str(p["id"]),
        "name": p["name"],
        "code": p["code"],
        "town": p["town"],
        "dutyholder_id": str(p["dutyholder_id"]) if p["dutyholder_id"] else None,
        "dutyholder": dh,
        "jurisdiction": p["jurisdiction"],
        "local_authority": p["local_authority"],
        "licence_regime": p["licence_regime"],
        "stage": p["stage"],
        "stage_note": p["stage_note"],
        "opening_date": p["opening_date"],
        "trading_since": p["trading_since"],
        "features": p["features"] or {},
        "feature_labels": FEATURES,
        "geofence": {"lat": p["geofence_lat"], "lng": p["geofence_lng"], "radius_m": p["geofence_radius_m"]},
        "legal_hold": p["legal_hold"],
        "accent": p["accent"],
        "licences": [{**{k: v for k, v in x.items() if k not in ("property_id",)}, "id": str(x["id"])} for x in lic],
        "locations": [
            {"id": str(x["id"]), "name": x["name"], "type": x["type"], "qr_code": x["qr_code"], "active": x["active"]}
            for x in locs
        ],
        "location_types": [{"key": r.key, "name": r.name} for r in conn.execute(select(location_type))],
        "dutyholders": [
            {"id": str(r.id), "name": r.name} for r in conn.execute(select(dutyholder.c.id, dutyholder.c.name))
        ],
    }


@router.get("/admin/properties/{key}")
def property_admin(key: str, pr: Current, conn: ConnDep) -> dict:
    pr.require("settings.view")
    return _detail(conn, resolve_property(conn, pr, key))


class PropertyIn(BaseModel):
    name: str | None = None
    code: str | None = None
    town: str | None = None
    dutyholder_id: uuid.UUID | None = None
    jurisdiction: str | None = None
    local_authority: str | None = None
    licence_regime: str | None = None
    stage: str | None = None
    stage_note: str | None = None
    opening_date: date | None = None
    trading_since: date | None = None
    features: dict[str, bool] | None = None
    geofence_lat: float | None = None
    geofence_lng: float | None = None
    geofence_radius_m: int | None = None
    legal_hold: bool | None = None


def _validate(body: PropertyIn) -> dict:
    vals = {k: v for k, v in body.model_dump().items() if v is not None}
    if "jurisdiction" in vals and vals["jurisdiction"] not in ("scotland", "england"):
        raise problem(422, "jurisdiction", "Jurisdiction is Scotland or England.")
    if "licence_regime" in vals and vals["licence_regime"] not in ("class7_hotel", "stl", "other"):
        raise problem(422, "licence_regime", "Unknown licence regime.")
    if "stage" in vals and vals["stage"] not in ("setup", "pre_opening", "trading", "closed"):
        raise problem(422, "stage", "Unknown stage.")
    if "features" in vals:
        vals["features"] = {k: bool(v) for k, v in vals["features"].items() if k in FEATURES}
    if "code" in vals:
        vals["code"] = vals["code"].upper()
        if not (2 <= len(vals["code"]) <= 4 and vals["code"].isalpha()):
            raise problem(422, "code", "The code is 2 to 4 letters, like TV.")
    if "geofence_radius_m" in vals and not (25 <= vals["geofence_radius_m"] <= 2000):
        raise problem(422, "radius", "The geofence radius is 25 to 2000 metres.")
    return vals


@router.post("/admin/properties")
def create_property(body: PropertyIn, request: Request, pr: Current, conn: ConnDep) -> dict:
    """Adding a property: create it, then load the master list in Property setup (CMS-10 proposes the templates)."""
    pr.require("register.toggle")
    vals = _validate(body)
    if not vals.get("name") or not vals.get("code"):
        raise problem(422, "name", "A property needs a name and a code.")
    if conn.execute(select(property_.c.id).where(property_.c.code == vals["code"])).first():
        raise problem(409, "code", f"The code {vals['code']} is already used.")
    pid = uuid.uuid4()
    sort = (conn.execute(select(property_.c.sort).order_by(property_.c.sort.desc()).limit(1)).scalar() or 0) + 1
    conn.execute(property_.insert().values(id=pid, sort=sort, stage=vals.pop("stage", "setup"), **vals))
    audit.record(
        conn,
        actor_for(request, pr),
        category="settings",
        action="property.create",
        summary=f"Added the property {vals['name']}",
        entity_type="property",
        entity_id=pid,
        property_id=pid,
        after=vals,
    )
    return {"id": str(pid), "code": vals["code"]}


@router.patch("/admin/properties/{key}")
def update_property(key: str, body: PropertyIn, request: Request, pr: Current, conn: ConnDep) -> dict:
    p = resolve_property(conn, pr, key)
    pr.require("register.toggle", p["id"])
    vals = _validate(body)
    if "legal_hold" in vals and not pr.has_role("super_admin"):
        raise problem(403, "forbidden", "Only the Super Admin can set or lift a legal hold.")
    if vals.get("code") and vals["code"] != p["code"]:
        raise problem(409, "code", "A property's code can't change once its register has IDs.")
    conn.execute(update(property_).where(property_.c.id == p["id"]).values(**vals))
    if "legal_hold" in vals:
        conn.execute(update(evidence).where(evidence.c.property_id == p["id"]).values(legal_hold=vals["legal_hold"]))
    b, a = audit.diff(p, {**p, **vals})
    audit.record(
        conn,
        actor_for(request, pr),
        category="settings",
        action="property.update",
        summary=f"Changed {p['name']}'s details",
        entity_type="property",
        entity_id=p["id"],
        property_id=p["id"],
        before=b,
        after=a,
    )
    return {"ok": True}


class LicenceIn(BaseModel):
    type: str
    number: str | None = None
    authority: str | None = None
    issued_on: date | None = None
    expires_on: date | None = None
    max_occupancy: int | None = None
    conditions: list[dict] = []  # [{text, kind: mandatory|local, template_ids: []}]


@router.post("/admin/properties/{key}/licences")
def add_licence(key: str, body: LicenceIn, request: Request, pr: Current, conn: ConnDep) -> dict:
    p = resolve_property(conn, pr, key)
    pr.require("register.toggle", p["id"])
    lid = uuid.uuid4()
    conn.execute(licence.insert().values(id=lid, property_id=p["id"], **body.model_dump()))
    audit.record(
        conn,
        actor_for(request, pr),
        category="settings",
        action="licence.add",
        summary=f"Added a {body.type} licence",
        entity_type="licence",
        entity_id=lid,
        property_id=p["id"],
        after=body.model_dump(),
    )
    return {"id": str(lid)}


@router.put("/admin/licences/{licence_id}")
def edit_licence(licence_id: uuid.UUID, body: LicenceIn, request: Request, pr: Current, conn: ConnDep) -> dict:
    row = conn.execute(select(licence).where(licence.c.id == licence_id)).mappings().first()
    if not row:
        raise problem(404, "not_found", "Not found.")
    pr.require("register.toggle", row["property_id"])
    conn.execute(update(licence).where(licence.c.id == licence_id).values(**body.model_dump()))
    audit.record(
        conn,
        actor_for(request, pr),
        category="settings",
        action="licence.update",
        summary="Changed a licence",
        entity_type="licence",
        entity_id=licence_id,
        property_id=row["property_id"],
    )
    return {"ok": True}


class LocationIn(BaseModel):
    name: str
    type: str = "other"
    active: bool = True


@router.post("/admin/properties/{key}/locations")
def add_location(key: str, body: LocationIn, request: Request, pr: Current, conn: ConnDep) -> dict:
    p = resolve_property(conn, pr, key)
    pr.require("register.toggle", p["id"])
    lid = uuid.uuid4()
    sort = (
        conn.execute(
            select(location.c.sort).where(location.c.property_id == p["id"]).order_by(location.c.sort.desc()).limit(1)
        ).scalar()
        or 0
    ) + 1
    conn.execute(
        location.insert().values(
            id=lid,
            property_id=p["id"],
            name=body.name.strip(),
            type=body.type,
            sort=sort,
            active=body.active,
            qr_code=secrets.token_urlsafe(9),
        )
    )
    audit.record(
        conn,
        actor_for(request, pr),
        category="settings",
        action="location.add",
        summary=f"Added the location {body.name}",
        entity_type="location",
        entity_id=lid,
        property_id=p["id"],
    )
    return {"id": str(lid)}


@router.patch("/admin/locations/{location_id}")
def edit_location(location_id: uuid.UUID, body: LocationIn, pr: Current, conn: ConnDep) -> dict:
    row = conn.execute(select(location).where(location.c.id == location_id)).mappings().first()
    if not row:
        raise problem(404, "not_found", "Not found.")
    pr.require("register.toggle", row["property_id"])
    conn.execute(
        update(location)
        .where(location.c.id == location_id)
        .values(name=body.name.strip(), type=body.type, active=body.active)
    )
    return {"ok": True}


@router.get("/admin/locations/{location_id}/qr.svg")
def location_qr(location_id: uuid.UUID, pr: Current, conn: ConnDep) -> Response:
    """A printable label for the location. Scanning it at the location is the P2 proof-of-presence rule (EXE-08)."""
    row = (
        conn.execute(
            select(location, property_.c.name.label("property"))
            .join(property_, property_.c.id == location.c.property_id)
            .where(location.c.id == location_id)
        )
        .mappings()
        .first()
    )
    if not row:
        raise problem(404, "not_found", "Not found.")
    pr.require_property(row["property_id"])
    svg = f"""<svg xmlns="http://www.w3.org/2000/svg" width="320" height="160" viewBox="0 0 320 160">
<rect width="320" height="160" rx="12" fill="#fff" stroke="#111113"/>
<text x="20" y="40" font-family="Inter,sans-serif" font-size="14" font-weight="600">{_esc(row["name"])}</text>
<text x="20" y="62" font-family="Inter,sans-serif" font-size="12" fill="#6B6B76">{_esc(row["property"])}</text>
<text x="20" y="130" font-family="JetBrains Mono,monospace" font-size="16">{row["qr_code"] or ""}</text>
</svg>"""
    return Response(svg, media_type="image/svg+xml")


def _esc(s: str) -> str:
    return s.replace("&", "&amp;").replace("<", "&lt;").replace(">", "&gt;")


# --- Web push (PWA, §7 Channels) -------------------------------------------------------------------------------------


class PushIn(BaseModel):
    endpoint: str
    keys: dict


@router.get("/push/key")
def push_key() -> dict:
    from bide_comply.config import settings

    return {"public_key": settings.vapid_public_key or None}


@router.post("/push/subscribe")
def push_subscribe(body: PushIn, pr: Current, conn: ConnDep) -> dict:
    if not body.endpoint.startswith("https://"):
        raise problem(422, "endpoint", "Not a push endpoint.")
    from sqlalchemy.dialects.postgresql import insert as pg_insert

    conn.execute(
        pg_insert(push_subscription)
        .values(id=uuid.uuid4(), person_id=pr.person_id, device_id=pr.device_id, endpoint=body.endpoint, keys=body.keys)
        .on_conflict_do_update(index_elements=["endpoint"], set_={"person_id": pr.person_id, "keys": body.keys})
    )
    return {"ok": True}


@router.post("/push/unsubscribe")
def push_unsubscribe(body: PushIn, pr: Current, conn: ConnDep) -> dict:
    conn.execute(
        push_subscription.delete().where(
            push_subscription.c.endpoint == body.endpoint, push_subscription.c.person_id == pr.person_id
        )
    )
    return {"ok": True}


# --- Saved views (§10.4) ---------------------------------------------------------------------------------------------


class ViewIn(BaseModel):
    page: str
    name: str
    query: str


@router.get("/saved-views")
def saved_views(page: str, pr: Current, conn: ConnDep) -> dict:
    rows = conn.execute(
        select(saved_view)
        .where(saved_view.c.person_id == pr.person_id, saved_view.c.page == page)
        .order_by(saved_view.c.created_at)
    ).mappings()
    return {"rows": [{"id": str(r["id"]), "name": r["name"], "query": r["query"]} for r in rows]}


@router.post("/saved-views")
def save_view(body: ViewIn, pr: Current, conn: ConnDep) -> dict:
    if not body.name.strip() or len(body.query) > 2000:
        raise problem(422, "name", "Give the view a name.")
    vid = uuid.uuid4()
    conn.execute(
        saved_view.insert().values(
            id=vid, person_id=pr.person_id, page=body.page, name=body.name.strip(), query=body.query
        )
    )
    return {"id": str(vid)}


@router.delete("/saved-views/{view_id}")
def delete_view(view_id: uuid.UUID, pr: Current, conn: ConnDep) -> dict:
    conn.execute(saved_view.delete().where(saved_view.c.id == view_id, saved_view.c.person_id == pr.person_id))
    return {"ok": True}


# --- Data subject access (§9.7): everything held about a person, in one action ---------------------------------------


@router.get("/privacy/export/{person_id}")
def dsar_export(person_id: uuid.UUID, request: Request, pr: Current, conn: ConnDep) -> Response:
    if person_id != pr.person_id:
        pr.require("people.manage")
    p = conn.execute(select(person).where(person.c.id == person_id)).mappings().first()
    if not p:
        raise problem(404, "not_found", "Not found.")

    def rows(q):
        return [dict(r) for r in conn.execute(q).mappings()]

    data = {
        "person": {k: v for k, v in dict(p).items() if k not in ("google_sub",)},
        "roles": rows(select(role_assignment).where(role_assignment.c.person_id == person_id)),
        "staff_requirements": rows(select(staff_requirement).where(staff_requirement.c.person_id == person_id)),
        "submissions": rows(select(submission).where(submission.c.submitter_id == person_id)),
        "verifications_done": rows(select(verification).where(verification.c.verifier_id == person_id)),
        "actions_owned": rows(select(action).where(action.c.owner_id == person_id)),
        "requests": rows(select(approval_request).where(approval_request.c.requested_by == person_id)),
        "leave": rows(select(leave).where(leave.c.person_id == person_id)),
        "notifications": rows(select(notification).where(notification.c.person_id == person_id)),
        "audit_events": rows(
            select(audit_event).where(audit_event.c.actor_id == person_id).order_by(audit_event.c.seq)
        ),
        "evidence_uploaded": rows(
            select(evidence.c.id, evidence.c.file_name, evidence.c.captured_at, evidence.c.sha256).where(
                evidence.c.uploaded_by == person_id
            )
        ),
        "exported_at": clock.now(),
    }
    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w", zipfile.ZIP_DEFLATED) as z:
        z.writestr("data.json", json.dumps(json.loads(canonical(data)), indent=2, ensure_ascii=False))
        z.writestr(
            "README.txt",
            "Everything bide Comply holds about this person. Photos are listed by file name and hash; "
            "ask the register keeper for copies.\n",
        )
    audit.record(
        conn,
        actor_for(request, pr),
        category="export",
        action="privacy.export",
        summary=f"Exported everything held about {p['name']} (subject access)",
        entity_type="person",
        entity_id=person_id,
    )
    return Response(
        buf.getvalue(),
        media_type="application/zip",
        headers={
            "Content-Disposition": f'attachment; filename="subject-access-{p["name"].strip("[]").replace(" ", "-")}.zip"'
        },
    )


# --- Escalations: open until a manager acknowledges them with a note (§7) -------------------------------------------


@router.get("/escalations")
def escalations_open(pr: Current, conn: ConnDep, property: uuid.UUID | None = None) -> dict:  # noqa: A002
    from bide_comply.authz import scope_filter
    from bide_comply.schema import escalation

    q = (
        select(escalation, property_.c.name.label("property"))
        .outerjoin(property_, property_.c.id == escalation.c.property_id)
        .where(escalation.c.acknowledged_at.is_(None), scope_filter(pr, escalation.c.property_id))
    )
    if property:
        q = q.where(escalation.c.property_id == property)
    rows = conn.execute(q.order_by(escalation.c.created_at.desc()).limit(200)).mappings().all()
    # Time to acknowledge per manager, last 90 days (§7).
    acked = conn.execute(
        select(escalation.c.acknowledged_by, escalation.c.created_at, escalation.c.acknowledged_at).where(
            escalation.c.acknowledged_at.isnot(None)
        )
    ).all()
    per: dict = {}
    for a in acked:
        per.setdefault(a.acknowledged_by, []).append((a.acknowledged_at - a.created_at).total_seconds() / 3600)
    from bide_comply.services.common import names

    who = names(conn, set(per))
    return {
        "rows": [
            {
                "id": str(r["id"]),
                "trigger": r["trigger"],
                "summary": r["summary"],
                "property": r["property"],
                "level": r["level"],
                "created_at": r["created_at"],
                "mine": str(pr.person_id) in (r["recipients"] or []),
            }
            for r in rows
        ],
        "time_to_acknowledge": sorted(
            [
                {"person": who.get(k, "?"), "median_hours": round(sorted(v)[len(v) // 2], 1), "count": len(v)}
                for k, v in per.items()
            ],
            key=lambda x: x["median_hours"],
        ),
    }


class AckIn(BaseModel):
    note: str


@router.post("/escalations/{escalation_id}/ack")
def acknowledge(escalation_id: uuid.UUID, body: AckIn, request: Request, pr: Current, conn: ConnDep) -> dict:
    from bide_comply.schema import escalation

    e = conn.execute(select(escalation).where(escalation.c.id == escalation_id)).mappings().first()
    if not e:
        raise problem(404, "not_found", "Not found.")
    pr.require_property(e["property_id"])
    if not (pr.is_admin or pr.can("assign", e["property_id"]) or str(pr.person_id) in (e["recipients"] or [])):
        raise problem(403, "forbidden", "Only a manager can acknowledge this.")
    if not body.note.strip():
        raise problem(422, "note", "Add a note saying what's being done.")
    conn.execute(
        update(escalation)
        .where(escalation.c.id == escalation_id)
        .values(acknowledged_at=clock.now(), acknowledged_by=pr.person_id, ack_note=body.note.strip())
    )
    audit.record(
        conn,
        actor_for(request, pr),
        category="record",
        action="escalation.ack",
        summary="Acknowledged an escalation",
        entity_type="escalation",
        entity_id=escalation_id,
        property_id=e["property_id"],
        after={"note": body.note},
    )
    return {"ok": True}
