"""Settings › People and roles (design: People): directory, roles per property, required training, devices,
offboarding; plus groups (pools), contractors and dutyholders.
"""

import uuid
from datetime import date, timedelta

from fastapi import APIRouter, Query, Request
from pydantic import BaseModel, EmailStr
from sqlalchemy import func, select, update

from bide_comply import audit, clock
from bide_comply.api import listing
from bide_comply.auth import Current, actor_for, revoke_device, revoke_person
from bide_comply.authz import ROLES, scope_filter
from bide_comply.db import ConnDep
from bide_comply.schema import (
    auth_session,
    contractor,
    device,
    dutyholder,
    dutyholder_director,
    person,
    pool,
    pool_member,
    property_,
    register_item,
    role_assignment,
    staff_requirement,
    staff_requirement_type,
)
from bide_comply.services import notify
from bide_comply.services.common import fmt_date, initials, problem

router = APIRouter(prefix="/api/people", tags=["people"])


def _requirements(conn, person_id: uuid.UUID) -> list[dict]:
    t0 = clock.today()
    out = []
    for r in conn.execute(
        select(
            staff_requirement,
            staff_requirement_type.c.name,
            staff_requirement_type.c.key,
            staff_requirement_type.c.restricted,
        )
        .join(staff_requirement_type, staff_requirement_type.c.id == staff_requirement.c.type_id)
        .where(staff_requirement.c.person_id == person_id)
    ).mappings():
        if r["status"] == "done" and r["expires_on"] and r["expires_on"] <= t0 + timedelta(days=60):
            st = "expiring" if r["expires_on"] >= t0 else "expired"
            label = f"Expires in {(r['expires_on'] - t0).days} days" if st == "expiring" else "Expired"
        elif r["status"] == "done":
            st, label = "ok", r["detail"] or {"manual_signed": "Done", "right_to_work": "On file"}.get(r["key"], "Done")
        elif r["status"] == "pending":
            st, label = "pending", "Uploaded, to check"
        else:
            st, label = "missing", "Missing"
        out.append(
            {
                "id": str(r["id"]),
                "key": r["key"],
                "name": r["name"],
                "status": st,
                "label": label,
                "restricted": r["restricted"],
            }
        )
    return out


def _summary(reqs: list[dict]) -> tuple[str, str]:
    bad = [r for r in reqs if r["status"] in ("missing", "expired")]
    soon = [r for r in reqs if r["status"] == "expiring"]
    if bad:
        r = bad[0]
        return "red", f"{r['name'].split(' (')[0]} {'missing' if r['status'] == 'missing' else 'expired'}" if r[
            "key"
        ] != "manual_signed" else "Training manual not signed"
    if soon:
        return "amber", f"{soon[0]['name'].split(' (')[0]} {soon[0]['label'].lower()}"
    done = sum(1 for r in reqs if r["status"] == "ok")
    return "green", f"{done} of {len(reqs)} done" if reqs else "Nothing required"


@router.get("")
def list_people(
    pr: Current,
    conn: ConnDep,
    q: str | None = None,
    prop: list[str] | None = Query(None),
    role: list[str] | None = Query(None),
    training: list[str] | None = Query(None),
    page: int = 1,
    page_size: int = 25,
) -> dict:
    pr.require("people.view")
    people = [
        dict(r)
        for r in conn.execute(
            select(person)
            .where(person.c.employment_status == "active", person.c.kind == "staff")
            .order_by(person.c.name)
        ).mappings()
    ]
    roles = conn.execute(
        select(role_assignment.c.person_id, role_assignment.c.role, property_.c.name, property_.c.code).outerjoin(
            property_, property_.c.id == role_assignment.c.property_id
        )
    ).all()
    last = dict(
        conn.execute(
            select(auth_session.c.person_id, func.max(auth_session.c.last_used_at)).group_by(auth_session.c.person_id)
        ).all()
    )
    rows = []
    for p in people:
        mine = [r for r in roles if r.person_id == p["id"]]
        props = sorted({r.name for r in mine if r.name})
        codes = sorted({r.code for r in mine if r.code})
        reqs = _requirements(conn, p["id"])
        tone, train = _summary(reqs)
        la = last.get(p["id"])
        if la:
            d = clock.london(la).date()
            la_label = (
                f"Today {clock.london(la):%H:%M}"
                if d == clock.today()
                else "Yesterday"
                if d == clock.today() - timedelta(days=1)
                else f"{d:%a}"
                if d > clock.today() - timedelta(days=7)
                else fmt_date(d)
            )
        else:
            la_label = "Never"
        rows.append(
            {
                "id": str(p["id"]),
                "name": p["name"],
                "initials": initials(p["name"]),
                "title": p["title"],
                "property": " · ".join(props) or "Group",
                "codes": codes or ["GROUP"],
                "roles": [
                    {"role": r.role, "label": ROLES.get(r.role, r.role), "property": r.name or "All properties"}
                    for r in mine
                ],
                "role_keys": sorted({r.role for r in mine}),
                "training": train,
                "training_tone": tone,
                "last_active": la_label,
            }
        )
    all_props = conn.execute(select(property_.c.code, property_.c.name).order_by(property_.c.sort)).all()
    views = [listing.View("all", "Everyone", lambda r: True)]
    facets = [
        listing.Facet(
            "prop",
            "Property",
            lambda r: r["codes"],
            [(c, n) for c, n in all_props] + [("GROUP", "Group")],
            multi_value=True,
        ),
        listing.Facet("role", "Role", lambda r: r["role_keys"], [(k, v) for k, v in ROLES.items()], multi_value=True),
        listing.Facet(
            "training",
            "Training",
            lambda r: r["training_tone"],
            [("red", "Needs sorting"), ("amber", "Expiring soon"), ("green", "All done")],
        ),
    ]
    res = listing.run(
        rows,
        q=q,
        search=lambda r: f"{r['name']} {r['property']} {r['title'] or ''}",
        views=views,
        view="all",
        facets=facets,
        selected={"prop": listing.multi(prop), "role": listing.multi(role), "training": listing.multi(training)},
        page=page,
        page_size=page_size,
        noun=("person", "people"),
    )
    out = res.dump()
    n_red = sum(1 for r in res.rows if r["training_tone"] == "red")
    out["summary"] = out["summary"].rstrip(".") + (f". {n_red} need training sorted." if n_red else ".")
    out["tabs"] = {
        "people": len(rows),
        "groups": conn.execute(select(func.count()).select_from(pool)).scalar(),
        "contractors": conn.execute(select(func.count()).where(contractor.c.active.is_(True))).scalar(),
        "dutyholders": conn.execute(select(func.count()).select_from(dutyholder)).scalar(),
    }
    return out


@router.get("/{person_id}")
def person_detail(person_id: uuid.UUID, pr: Current, conn: ConnDep) -> dict:
    pr.require("people.view")
    p = conn.execute(select(person).where(person.c.id == person_id)).mappings().first()
    if not p:
        raise problem(404, "not_found", "Not found.")
    roles = [
        {
            "id": str(r.id),
            "role": r.role,
            "label": ROLES.get(r.role, r.role),
            "property": r.name or "All properties",
            "property_id": str(r.property_id) if r.property_id else None,
        }
        for r in conn.execute(
            select(role_assignment.c.id, role_assignment.c.role, role_assignment.c.property_id, property_.c.name)
            .outerjoin(property_, property_.c.id == role_assignment.c.property_id)
            .where(role_assignment.c.person_id == person_id)
        )
    ]
    reqs = _requirements(conn, person_id)
    if not pr.can("identity_docs.view"):
        for r in reqs:
            if r["restricted"]:
                r["label"] = "On file" if r["status"] == "ok" else r["label"]
    devs = []
    for d in conn.execute(
        select(device).where(device.c.person_id == person_id, device.c.revoked_at.is_(None))
    ).mappings():
        left = (d["trusted_until"] - clock.now()).days if d["trusted_until"] else None
        devs.append(
            {
                "id": str(d["id"]),
                "label": d["label"],
                "detail": f"Trusted since {fmt_date(clock.london(d['trusted_at']).date())} · expires in {left} days"
                if d["trusted_at"] and left is not None
                else "Not trusted yet",
            }
        )
    items = conn.execute(
        select(func.count()).where(
            (register_item.c.accountable_id == person_id) | (register_item.c.done_by_person_id == person_id)
        )
    ).scalar()
    return {
        "id": str(p["id"]),
        "name": p["name"],
        "initials": initials(p["name"]),
        "email": p["email"],
        "title": p["title"],
        "kind": p["kind"],
        "roles": roles,
        "requirements": reqs,
        "devices": devs,
        "items_named": items,
        "can_manage": pr.can("people.manage"),
        "first_name": p["name"].split()[0].strip("["),
    }


class RoleIn(BaseModel):
    role: str
    property_id: uuid.UUID | None = None


@router.post("/{person_id}/roles")
def add_role(person_id: uuid.UUID, body: RoleIn, request: Request, pr: Current, conn: ConnDep) -> dict:
    pr.require("people.manage")
    if body.role not in ROLES:
        raise problem(422, "role", "Unknown role.")
    if body.role == "super_admin" and not pr.has_role("super_admin"):
        raise problem(403, "forbidden", "Only a Super Admin can make someone a Super Admin.")
    conn.execute(
        role_assignment.insert().values(
            id=uuid.uuid4(), person_id=person_id, role=body.role, property_id=body.property_id
        )
    )
    # Required training follows the role (DOC-03).
    for t in conn.execute(
        select(staff_requirement_type).where(staff_requirement_type.c.roles.contains([body.role]))
    ).mappings():
        exists = conn.execute(
            select(staff_requirement.c.id).where(
                staff_requirement.c.person_id == person_id, staff_requirement.c.type_id == t["id"]
            )
        ).first()
        if not exists:
            conn.execute(
                staff_requirement.insert().values(
                    id=uuid.uuid4(), person_id=person_id, type_id=t["id"], status="missing"
                )
            )
    audit.record(
        conn,
        actor_for(request, pr),
        category="settings",
        action="people.role_add",
        summary=f"Gave someone the {ROLES[body.role]} role",
        entity_type="person",
        entity_id=person_id,
        property_id=body.property_id,
        after={"role": body.role},
    )
    return {"ok": True}


@router.delete("/{person_id}/roles/{role_id}")
def remove_role(person_id: uuid.UUID, role_id: uuid.UUID, request: Request, pr: Current, conn: ConnDep) -> dict:
    pr.require("people.manage")
    r = (
        conn.execute(
            select(role_assignment).where(role_assignment.c.id == role_id, role_assignment.c.person_id == person_id)
        )
        .mappings()
        .first()
    )
    if not r:
        raise problem(404, "not_found", "Not found.")
    if (
        r["role"] == "super_admin"
        and conn.execute(select(func.count()).where(role_assignment.c.role == "super_admin")).scalar() <= 1
    ):
        raise problem(409, "last_admin", "There must always be at least one Super Admin.")
    conn.execute(role_assignment.delete().where(role_assignment.c.id == role_id))
    audit.record(
        conn,
        actor_for(request, pr),
        category="settings",
        action="people.role_remove",
        summary=f"Removed the {ROLES.get(r['role'], r['role'])} role",
        entity_type="person",
        entity_id=person_id,
        property_id=r["property_id"],
        before={"role": r["role"]},
    )
    return {"ok": True}


class InviteIn(BaseModel):
    name: str
    email: EmailStr
    kind: str = "staff"
    title: str | None = None
    role: str = "staff"
    property_id: uuid.UUID | None = None


@router.post("")
def invite(body: InviteIn, request: Request, pr: Current, conn: ConnDep) -> dict:
    pr.require("people.manage")
    email = body.email.lower()
    if conn.execute(select(person.c.id).where(person.c.email == email)).first():
        raise problem(409, "exists", "Someone with that email is already set up.")
    pid = uuid.uuid4()
    conn.execute(person.insert().values(id=pid, name=body.name.strip(), email=email, kind=body.kind, title=body.title))
    add_role(pid, RoleIn(role=body.role, property_id=body.property_id), request, pr, conn)
    audit.record(
        conn,
        actor_for(request, pr),
        category="settings",
        action="people.invite",
        summary=f"Added {body.name}",
        entity_type="person",
        entity_id=pid,
    )
    return {"id": str(pid)}


@router.post("/{person_id}/devices/{device_id}/revoke")
def revoke(person_id: uuid.UUID, device_id: uuid.UUID, request: Request, pr: Current, conn: ConnDep) -> dict:
    pr.require("people.manage")
    revoke_device(conn, device_id)
    audit.record(
        conn,
        actor_for(request, pr),
        category="sign_in",
        action="device.revoke",
        summary="Signed out a device",
        entity_type="device",
        entity_id=device_id,
    )
    return {"ok": True}


@router.post("/{person_id}/offboard")
def offboard(person_id: uuid.UUID, request: Request, pr: Current, conn: ConnDep) -> dict:
    """Ends access straight away, signs out every device, and flags their checks "needs owner" (SCH-06)."""
    pr.require("people.manage")
    if person_id == pr.person_id:
        raise problem(409, "self", "You can't offboard yourself.")
    p = conn.execute(select(person).where(person.c.id == person_id)).mappings().first()
    if not p:
        raise problem(404, "not_found", "Not found.")
    conn.execute(
        update(person).where(person.c.id == person_id).values(employment_status="leaver", left_on=clock.today())
    )
    revoke_person(conn, person_id)
    moved, flagged = 0, 0
    for it in conn.execute(
        select(register_item).where(
            (register_item.c.accountable_id == person_id) | (register_item.c.done_by_person_id == person_id)
        )
    ).mappings():
        vals: dict = {}
        if it["cover_id"] and it["cover_id"] != person_id:
            if it["accountable_id"] == person_id:
                vals["accountable_id"] = it["cover_id"]
            if it["done_by_person_id"] == person_id:
                vals["done_by_person_id"] = it["cover_id"]
            moved += 1
        else:
            if it["accountable_id"] == person_id:
                vals["accountable_id"] = None
            if it["done_by_person_id"] == person_id:
                vals |= {"done_by_person_id": None, "done_by_kind": None}
            flagged += 1
        vals["needs_owner"] = not (vals.get("accountable_id", it["accountable_id"]))
        conn.execute(update(register_item).where(register_item.c.id == it["id"]).values(**vals))
    conn.execute(pool_member.delete().where(pool_member.c.person_id == person_id))
    if flagged:
        notify.notify(
            conn,
            notify.resolve(conn, [{"kind": "role", "role": "system_owner"}], None),
            kind="people.needs_owner",
            title=f"{flagged} checks need a new owner after {p['name']} left",
            link="/settings/setup",
        )
    audit.record(
        conn,
        actor_for(request, pr),
        category="settings",
        action="people.offboard",
        summary=f"Offboarded {p['name']}: access ended, {moved} checks moved to cover, {flagged} need a new owner",
        entity_type="person",
        entity_id=person_id,
    )
    return {"moved_to_cover": moved, "needs_owner": flagged}


@router.post("/sync-google")
def sync_google(request: Request, pr: Current, conn: ConnDep) -> dict:
    """Directory sync from Google Workspace. Needs the Admin SDK service account, which isn't configured here."""
    pr.require("people.manage")
    from bide_comply.config import settings

    if not settings.google_client_id:
        raise problem(503, "not_configured", "Google Workspace sync isn't set up yet. Add people by hand for now.")
    raise problem(
        501, "not_configured", "Google Workspace directory sync needs a service account with Admin SDK access."
    )


# --- Groups (pools), contractors, dutyholders ------------------------------------------------------------------------

groups_router = APIRouter(prefix="/api", tags=["people"])


@groups_router.get("/pools")
def pools(pr: Current, conn: ConnDep, property: uuid.UUID | None = None) -> dict:  # noqa: A002
    q = (
        select(pool, property_.c.name.label("property"))
        .outerjoin(property_, property_.c.id == pool.c.property_id)
        .where(scope_filter(pr, pool.c.property_id) | pool.c.property_id.is_(None))
    )
    if property:
        q = q.where(pool.c.property_id == property)
    rows = conn.execute(q.order_by(pool.c.name)).mappings().all()
    members = conn.execute(
        select(pool_member.c.pool_id, person.c.id, person.c.name).join(person, person.c.id == pool_member.c.person_id)
    ).all()
    return {
        "rows": [
            {
                "id": str(r["id"]),
                "name": r["name"],
                "property": r["property"],
                "members": [{"id": str(m.id), "name": m.name} for m in members if m.pool_id == r["id"]],
            }
            for r in rows
        ]
    }


class PoolIn(BaseModel):
    name: str
    property_id: uuid.UUID | None = None
    member_ids: list[uuid.UUID] = []


@groups_router.post("/pools")
def create_pool(body: PoolIn, request: Request, pr: Current, conn: ConnDep) -> dict:
    pr.require("people.manage")
    pid = uuid.uuid4()
    conn.execute(pool.insert().values(id=pid, name=body.name.strip(), property_id=body.property_id))
    for m in body.member_ids:
        conn.execute(pool_member.insert().values(pool_id=pid, person_id=m))
    audit.record(
        conn,
        actor_for(request, pr),
        category="settings",
        action="pool.create",
        summary=f"Created the group {body.name}",
        entity_type="pool",
        entity_id=pid,
        property_id=body.property_id,
    )
    return {"id": str(pid)}


@groups_router.put("/pools/{pool_id}/members")
def set_members(pool_id: uuid.UUID, body: PoolIn, request: Request, pr: Current, conn: ConnDep) -> dict:
    pr.require("people.manage")
    conn.execute(pool_member.delete().where(pool_member.c.pool_id == pool_id))
    for m in body.member_ids:
        conn.execute(pool_member.insert().values(pool_id=pool_id, person_id=m))
    audit.record(
        conn,
        actor_for(request, pr),
        category="settings",
        action="pool.members",
        summary="Changed a group's members",
        entity_type="pool",
        entity_id=pool_id,
        after={"members": len(body.member_ids)},
    )
    return {"ok": True}


@groups_router.get("/contractors")
def contractors(pr: Current, conn: ConnDep) -> dict:
    t0 = clock.today()
    return {
        "rows": [
            {
                "id": str(r["id"]),
                "name": r["name"],
                "trade": r["trade"],
                "accreditation": r["accreditation"],
                "accreditation_expires": r["accreditation_expires"],
                "accreditation_status": "expired"
                if r["accreditation_expires"] and r["accreditation_expires"] < t0
                else "expiring"
                if r["accreditation_expires"] and r["accreditation_expires"] <= t0 + timedelta(days=60)
                else "ok",
                "email": r["email"],
            }
            for r in conn.execute(
                select(contractor).where(contractor.c.active.is_(True)).order_by(contractor.c.name)
            ).mappings()
        ]
    }


class ContractorIn(BaseModel):
    name: str
    trade: str | None = None
    accreditation: str | None = None
    accreditation_expires: date | None = None
    email: EmailStr | None = None


@groups_router.post("/contractors")
def add_contractor(body: ContractorIn, request: Request, pr: Current, conn: ConnDep) -> dict:
    pr.require("people.manage")
    cid = uuid.uuid4()
    conn.execute(contractor.insert().values(id=cid, **body.model_dump()))
    audit.record(
        conn,
        actor_for(request, pr),
        category="settings",
        action="contractor.add",
        summary=f"Added contractor {body.name}",
        entity_type="contractor",
        entity_id=cid,
    )
    return {"id": str(cid)}


@groups_router.get("/dutyholders")
def dutyholders(pr: Current, conn: ConnDep) -> dict:
    rows = conn.execute(select(dutyholder).order_by(dutyholder.c.name)).mappings().all()
    dirs = conn.execute(
        select(dutyholder_director.c.dutyholder_id, person.c.id, person.c.name).join(
            person, person.c.id == dutyholder_director.c.person_id
        )
    ).all()
    props = conn.execute(select(property_.c.dutyholder_id, property_.c.name)).all()
    return {
        "rows": [
            {
                "id": str(r["id"]),
                "name": r["name"],
                "company_number": r["company_number"],
                "directors": [{"id": str(d.id), "name": d.name} for d in dirs if d.dutyholder_id == r["id"]],
                "properties": [p.name for p in props if p.dutyholder_id == r["id"]],
            }
            for r in rows
        ]
    }
