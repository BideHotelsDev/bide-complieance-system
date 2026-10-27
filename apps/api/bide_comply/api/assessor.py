"""The competent assessor's quarterly audit walk (design: Assessor audit walk). Each line compares the register with
the building; anything that doesn't match becomes an Action owned by the system owner, with the assessor's priority.
"""

import uuid

from fastapi import APIRouter, Request
from pydantic import BaseModel
from sqlalchemy import select, update

from bide_comply import audit, clock
from bide_comply.api.register import register_rows, resolve_property
from bide_comply.auth import Current, actor_for
from bide_comply.db import ConnDep
from bide_comply.schema import action, audit_walk, audit_walk_line, register_item, signature_request, template
from bide_comply.services import actions as action_service
from bide_comply.services import notify
from bide_comply.services.common import problem

router = APIRouter(prefix="/api/audit-walks", tags=["assessor"])

GROUPS = [
    ("fire", "Fire"),
    ("water", "Water"),
    ("gas_el", "Gas and electrical"),
    ("hot_tub", "Wellness"),
    ("people", "People and guests"),
]


def _group(domain_key: str) -> str:
    return {"fire": "fire", "water": "water", "gas": "gas_el", "electrical": "gas_el", "hot_tub": "hot_tub"}.get(
        domain_key, "people"
    )


def _quarter() -> str:
    t = clock.today()
    return f"{t.year}-Q{(t.month - 1) // 3 + 1}"


@router.get("/{key}")
def walk(key: str, pr: Current, conn: ConnDep, group: str = "fire") -> dict:
    p = resolve_property(conn, pr, key)
    if not (pr.can("assessor.walk", p["id"]) or pr.is_admin):
        raise problem(403, "forbidden", "Only the competent assessor records audit walks.")
    w = (
        conn.execute(select(audit_walk).where(audit_walk.c.property_id == p["id"], audit_walk.c.quarter == _quarter()))
        .mappings()
        .first()
    )
    if not w:
        wid = uuid.uuid4()
        conn.execute(
            audit_walk.insert().values(id=wid, property_id=p["id"], assessor_id=pr.person_id, quarter=_quarter())
        )
        w = conn.execute(select(audit_walk).where(audit_walk.c.id == wid)).mappings().one()
    rows = [r for r in register_rows(conn, p["id"]) if r["status"] != "grey" and r["class"] in ("A", "B")]
    lines = {
        r.register_item_id: dict(r._mapping)
        for r in conn.execute(select(audit_walk_line).where(audit_walk_line.c.walk_id == w["id"]))
    }
    acts = {
        r.register_item_id: r
        for r in conn.execute(
            select(action.c.register_item_id, action.c.ref, action.c.gate_ref).where(
                action.c.property_id == p["id"], action.c.status != "closed"
            )
        )
    }
    items = []
    for r in rows:
        ln = lines.get(uuid.UUID(r["id"]))
        a = acts.get(uuid.UUID(r["id"]))
        says = f"{r['status_label']} · {r['last_done_label']}" + (f" · {a.ref} open" if a else "")
        items.append(
            {
                "register_item_id": r["id"],
                "ref": r["ref"],
                "check": r["check"],
                "class": r["class"],
                "group": _group(r["domain_key"]),
                "register_says": says,
                "verdict": ln["verdict"] if ln else None,
                "finding": ln["finding"] if ln else None,
                "priority": ln["priority"] if ln else None,
                "action_ref": None,
                "photo_ids": ln["photo_ids"] if ln else [],
            }
        )
    done = [i for i in items if i["verdict"]]
    return {
        "walk_id": str(w["id"]),
        "property": p["name"],
        "code": p["code"],
        "quarter": w["quarter"],
        "status": w["status"],
        "progress": {"done": len(done), "total": len(items)},
        "groups": [{"key": k, "label": v, "count": sum(1 for i in items if i["group"] == k)} for k, v in GROUPS],
        "group": group,
        "items": [i for i in items if i["group"] == group],
        "tally": {
            "matches": sum(1 for i in done if i["verdict"] == "matches"),
            "doesnt": sum(1 for i in done if i["verdict"] == "doesnt"),
            "cant_check": sum(1 for i in done if i["verdict"] == "cant_check"),
            "to_do": len(items) - len(done),
        },
        "also_waiting": [
            {"title": f"{s.title}", "due_on": s.due_on}
            for s in conn.execute(
                select(signature_request.c.title, signature_request.c.due_on).where(
                    signature_request.c.property_id == p["id"],
                    signature_request.c.type == "fra_countersign",
                    signature_request.c.status == "open",
                )
            )
        ]
        + [
            {"title": f"{a.description[:60]} ({a.ref})", "due_on": a.due_on, "priority": a.priority}
            for a in conn.execute(
                select(action.c.ref, action.c.description, action.c.due_on, action.c.priority).where(
                    action.c.property_id == p["id"], action.c.owner_id == pr.person_id, action.c.status != "closed"
                )
            )
        ],
        "can_finish": len(done) == len(items) and w["status"] != "sent",
    }


class LineIn(BaseModel):
    register_item_id: uuid.UUID
    verdict: str | None = None
    finding: str | None = None
    priority: str | None = None
    photo_ids: list[uuid.UUID] = []


@router.put("/{walk_id}/lines")
def save_line(walk_id: uuid.UUID, body: LineIn, pr: Current, conn: ConnDep) -> dict:
    w = conn.execute(select(audit_walk).where(audit_walk.c.id == walk_id)).mappings().first()
    if not w:
        raise problem(404, "not_found", "Not found.")
    pr.require_property(w["property_id"])
    pr.require("assessor.walk", w["property_id"])
    if w["status"] == "sent":
        raise problem(409, "sent", "This walk has been sent.")
    if body.verdict and body.verdict not in ("matches", "doesnt", "cant_check"):
        raise problem(422, "verdict", "Unknown answer.")
    vals = {
        "verdict": body.verdict,
        "finding": body.finding,
        "priority": body.priority,
        "photo_ids": [str(x) for x in body.photo_ids],
    }
    existing = conn.execute(
        select(audit_walk_line.c.id).where(
            audit_walk_line.c.walk_id == walk_id, audit_walk_line.c.register_item_id == body.register_item_id
        )
    ).scalar()
    if existing:
        conn.execute(update(audit_walk_line).where(audit_walk_line.c.id == existing).values(**vals))
    else:
        conn.execute(
            audit_walk_line.insert().values(
                id=uuid.uuid4(), walk_id=walk_id, register_item_id=body.register_item_id, **vals
            )
        )
    return {"ok": True}


@router.post("/{walk_id}/send")
def send(walk_id: uuid.UUID, request: Request, pr: Current, conn: ConnDep) -> dict:
    w = conn.execute(select(audit_walk).where(audit_walk.c.id == walk_id)).mappings().first()
    if not w:
        raise problem(404, "not_found", "Not found.")
    pr.require("assessor.walk", w["property_id"])
    actor = actor_for(request, pr)
    owner = action_service.system_owner(conn)
    made = []
    for ln in conn.execute(
        select(audit_walk_line, register_item.c.ref, template.c["class"].label("klass"), template.c.name)
        .join(register_item, register_item.c.id == audit_walk_line.c.register_item_id)
        .join(template, template.c.id == register_item.c.template_id)
        .where(audit_walk_line.c.walk_id == walk_id, audit_walk_line.c.verdict == "doesnt")
    ).mappings():
        if ln["action_id"]:
            continue
        r = action_service.raise_action(
            conn,
            actor,
            property_id=w["property_id"],
            type_="action",
            source="assessor",
            source_ref=f"Audit walk {w['quarter']} ({pr.name})",
            description=ln["finding"] or f"{ln['name']}: doesn't match the register",
            priority=ln["priority"] or "high",
            klass=ln["klass"],
            owner_id=owner,
            register_item_id=ln["register_item_id"],
            evidence_ids=[uuid.UUID(x) for x in ln["photo_ids"]],
        )
        conn.execute(update(audit_walk_line).where(audit_walk_line.c.id == ln["id"]).values(action_id=r["id"]))
        made.append(r["ref"])
    conn.execute(update(audit_walk).where(audit_walk.c.id == walk_id).values(status="sent", sent_at=clock.now()))
    notify.notify(
        conn,
        notify.resolve(conn, [{"kind": "role", "role": "super_admin"}, {"kind": "dutyholders"}], w["property_id"]),
        kind="assessor.report",
        title=f"Audit walk report from {pr.name}",
        body=f"{len(made)} findings became Actions: {', '.join(made) or 'none'}.",
        link="/actions?source=assessor",
    )
    audit.record(
        conn,
        actor,
        category="record",
        action="assessor.walk_sent",
        summary=f"Sent the {w['quarter']} audit walk report",
        entity_type="audit_walk",
        entity_id=walk_id,
        property_id=w["property_id"],
        after={"actions": made},
    )
    return {"actions": made}
