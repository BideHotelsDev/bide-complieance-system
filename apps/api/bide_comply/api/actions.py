"""Actions to fix (design: Actions & Advisories log)."""

import uuid
from datetime import date, timedelta

from fastapi import APIRouter, Query, Request
from pydantic import BaseModel
from sqlalchemy import func, select, update

from bide_comply import audit, clock
from bide_comply.api import listing
from bide_comply.auth import Current, actor_for
from bide_comply.authz import scope_filter
from bide_comply.db import ConnDep
from bide_comply.engine import actions as rules
from bide_comply.schema import action, action_comment, action_evidence, escalation, evidence, person, property_
from bide_comply.services import actions as service
from bide_comply.services import evidence as ev_service
from bide_comply.services.common import names, problem

router = APIRouter(prefix="/api/actions", tags=["actions"])


def _rows(conn, pr, property_id: uuid.UUID | None, include_closed: bool):
    q = select(action, property_.c.name.label("property"), property_.c.code).join(
        property_, property_.c.id == action.c.property_id
    )
    q = q.where(scope_filter(pr, action.c.property_id))
    if property_id:
        q = q.where(action.c.property_id == property_id)
    if not include_closed:
        q = q.where(action.c.status != "closed")
    rows = [dict(r) for r in conn.execute(q).mappings()]
    who = names(conn, {r["owner_id"] for r in rows})
    today = clock.today()
    out = []
    for r in rows:
        v = service.view_row(conn, r, today, who)
        v["property"] = r["property"]
        v["property_code"] = r["code"]
        out.append(v)
    return out


@router.get("")
def list_actions(
    pr: Current,
    conn: ConnDep,
    q: str | None = None,
    view: str = "all",
    prop: list[str] | None = Query(None),
    type: list[str] | None = Query(None),  # noqa: A002
    prio: list[str] | None = Query(None),
    source: list[str] | None = Query(None),
    gate: list[str] | None = Query(None),
    property: uuid.UUID | None = None,  # noqa: A002
    sort: str = "due",
    page: int = 1,
    page_size: int = 25,
    closed: bool = False,
) -> dict:
    rows = _rows(conn, pr, property, closed)
    today = clock.today()
    week_end = today + timedelta(days=6 - today.weekday())
    views = [
        listing.View("all", "All open", lambda r: r["status"] != "closed"),
        listing.View(
            "urgent", "Urgent", lambda r: r["priority"] == "high" and r["status"] != "closed", phrase="urgent "
        ),
        listing.View(
            "week",
            "Due this week",
            lambda r: r["status"] != "closed" and r["due_on"] <= week_end,
            suffix=" due this week",
        ),
        listing.View(
            "adv",
            "Decisions needed",
            lambda r: r["type"] == "advisory" and r["status"] != "closed",
            suffix=" that need a decision (Advisories)",
        ),
        listing.View(
            "mine",
            "Assigned to me",
            lambda r: r["owner_id"] == str(pr.person_id) and r["status"] != "closed",
            suffix=" assigned to you",
        ),
    ]
    if closed:
        views.append(listing.View("closed", "Closed", lambda r: r["status"] == "closed", phrase="closed "))
    props = sorted({(r["property_code"], r["property"]) for r in rows}, key=lambda x: x[1])
    gates = sorted({r["gate_ref"] for r in rows if r["gate_ref"]})
    srcs = sorted({r["source"] for r in rows})
    facets = [
        listing.Facet(
            "prop", "Property", lambda r: r["property_code"], [(c, n) for c, n in props], hint="Show items at"
        ),
        listing.Facet(
            "type",
            "Type",
            lambda r: r["type"],
            [(k, v) for k, v in rules.TYPE_LABEL.items()],
            hint="Show these kinds of item",
        ),
        listing.Facet(
            "prio",
            "Priority",
            lambda r: r["priority"],
            [(k, v) for k, v in rules.PRIORITY_LABEL.items()],
            hint="Show these priorities",
        ),
        listing.Facet(
            "source",
            "Source",
            lambda r: r["source"],
            [(s, rules.SOURCE_LABEL.get(s, s)) for s in srcs],
            hint="Show items raised from",
        ),
        listing.Facet("gate", "Gate ref", lambda r: r["gate_ref"], [(g, g) for g in gates], hint="Show items for"),
    ]
    sorts = {
        "due": (lambda r: (r["due_on"], r["ref"]), False, "Soonest due first."),
        "priority": (
            lambda r: ({"high": 0, "med": 1, "low": 2}[r["priority"]], r["due_on"]),
            False,
            "Most urgent first.",
        ),
        "raised": (lambda r: r["raised_on"], True, "Newest first."),
        "ref": (lambda r: r["ref"], False, "By ID."),
    }
    sk, rev, phrase = sorts.get(sort, sorts["due"])
    res = listing.run(
        rows,
        q=q,
        search=lambda r: f"{r['ref']} {r['description']} {r['owner']} {r['property']}",
        views=views,
        view=view,
        facets=facets,
        selected={
            "prop": listing.multi(prop),
            "type": listing.multi(type),
            "prio": listing.multi(prio),
            "source": listing.multi(source),
            "gate": listing.multi(gate),
        },
        sort=sk,
        reverse=rev,
        page=page,
        page_size=page_size,
        order_phrase=phrase,
    )
    open_rows = [r for r in rows if r["status"] != "closed"]
    by_prop: dict[str, int] = {}
    for r in open_rows:
        by_prop[r["property"]] = by_prop.get(r["property"], 0) + 1
    urgent = [r for r in open_rows if r["priority"] == "high"]
    out = res.dump()
    out["stats"] = {
        "by_urgency": {
            "high": len(urgent),
            "med": sum(1 for r in open_rows if r["priority"] == "med"),
            "low": sum(1 for r in open_rows if r["priority"] == "low"),
        },
        "by_property": sorted([{"property": k, "count": v} for k, v in by_prop.items()], key=lambda x: -x["count"]),
        "urgent_late": sum(1 for r in urgent if r["late"]),
        "urgent_total": len(urgent),
        "open_total": len(open_rows),
    }
    # Board view (§6): the same filtered rows in columns by priority.
    out["board"] = {p: [r for r in res.rows if r["priority"] == p] for p in ("high", "med", "low")}
    return out


def _get(conn, pr, ref: str) -> dict:
    a = (
        conn.execute(
            select(action, property_.c.name.label("property"), property_.c.code)
            .join(property_, property_.c.id == action.c.property_id)
            .where(action.c.ref == ref.upper())
        )
        .mappings()
        .first()
    )
    if not a:
        raise problem(404, "not_found", "Not found.")
    pr.require_property(a["property_id"])
    return dict(a)


@router.get("/{ref}")
def detail(ref: str, pr: Current, conn: ConnDep) -> dict:
    a = _get(conn, pr, ref)
    v = service.view_row(conn, a)
    v["property"] = a["property"]
    v["property_code"] = a["code"]
    ev = [
        dict(r)
        for r in conn.execute(
            select(evidence, action_evidence.c.purpose)
            .join(action_evidence, action_evidence.c.evidence_id == evidence.c.id)
            .where(action_evidence.c.action_id == a["id"])
        ).mappings()
    ]
    v["evidence"] = [{**ev_service.view(e, thumb=True), "purpose": e["purpose"]} for e in ev]
    v["comments"] = [
        {"id": str(c.id), "body": c.body, "author": c.name, "at": c.created_at}
        for c in conn.execute(
            select(action_comment.c.id, action_comment.c.body, action_comment.c.created_at, person.c.name)
            .join(person, person.c.id == action_comment.c.author_id)
            .where(action_comment.c.action_id == a["id"])
            .order_by(action_comment.c.created_at)
        )
    ]
    v["item_ref"] = service.item_ref(conn, a["register_item_id"])
    v["interim_measure"] = a["interim_measure"]
    v["stop_sell_decision"] = a["stop_sell_decision"]
    v["call_made_at"] = a["call_made_at"]
    v["can_close"] = pr.can("action.close", a["property_id"]) or a["owner_id"] == pr.person_id
    v["close_label"] = "Record decision and close" if a["type"] == "advisory" else "Close with evidence"
    v["close_hint"] = (
        "An Advisory closes only when the decision and its reason are recorded."
        if a["type"] == "advisory"
        else "Close stays disabled until closing evidence is filed. No evidence, not done."
    )
    return v


class NewAction(BaseModel):
    property_id: uuid.UUID
    description: str
    type: str = "action"
    priority: str | None = None
    klass: str | None = None
    owner_id: uuid.UUID | None = None
    source: str = "manual"
    source_ref: str | None = None
    gate_ref: str | None = None
    due_on: date | None = None
    evidence_ids: list[uuid.UUID] = []


@router.post("")
def create(body: NewAction, request: Request, pr: Current, conn: ConnDep) -> dict:
    pr.require_property(body.property_id)
    pr.require("action.raise", body.property_id)
    if not body.description.strip():
        raise problem(422, "description", "Say what needs fixing.")
    if body.type not in rules.TYPE_LABEL or (body.priority and body.priority not in rules.PRIORITY_DAYS):
        raise problem(422, "type", "Unknown type or priority.")
    ev = [e["id"] for e in ev_service.stored(conn, body.evidence_ids, pr.person_id)]
    r = service.raise_action(
        conn,
        actor_for(request, pr),
        property_id=body.property_id,
        description=body.description.strip(),
        type_=body.type,
        source=body.source,
        source_ref=body.source_ref,
        gate_ref=body.gate_ref,
        priority=body.priority,
        klass=body.klass,
        owner_id=body.owner_id,
        due_on=body.due_on,
        evidence_ids=ev,
    )
    return {"ref": r["ref"], "id": str(r["id"])}


class CloseIn(BaseModel):
    evidence_ids: list[uuid.UUID] = []
    decision: str | None = None
    decision_reason: str | None = None
    note: str | None = None


@router.post("/{ref}/close")
def close(ref: str, body: CloseIn, request: Request, pr: Current, conn: ConnDep) -> dict:
    a = _get(conn, pr, ref)
    if not (pr.can("action.close", a["property_id"]) or a["owner_id"] == pr.person_id):
        raise problem(403, "forbidden", "You can raise Actions here but not close them.")
    ev = [e["id"] for e in ev_service.stored(conn, body.evidence_ids, pr.person_id)]
    return service.close(
        conn,
        actor_for(request, pr),
        a["id"],
        evidence_ids=ev,
        decision=body.decision,
        decision_reason=body.decision_reason,
        note=body.note,
    )


class EvidenceIn(BaseModel):
    evidence_ids: list[uuid.UUID]


@router.post("/{ref}/evidence")
def add_evidence(ref: str, body: EvidenceIn, request: Request, pr: Current, conn: ConnDep) -> dict:
    a = _get(conn, pr, ref)
    ev = ev_service.stored(conn, body.evidence_ids, pr.person_id)
    for e in ev:
        conn.execute(action_evidence.insert().values(action_id=a["id"], evidence_id=e["id"], purpose="closing"))
    audit.record(
        conn,
        actor_for(request, pr),
        category="record",
        action="action.evidence",
        summary=f"Filed closing evidence on {a['ref']}",
        entity_type="action",
        entity_id=a["id"],
        entity_ref=a["ref"],
        property_id=a["property_id"],
        after={"files": len(ev)},
    )
    n = conn.execute(
        select(func.count()).where(action_evidence.c.action_id == a["id"], action_evidence.c.purpose == "closing")
    ).scalar()
    return {"closing_evidence": n}


class CommentIn(BaseModel):
    body: str


@router.post("/{ref}/comments")
def comment(ref: str, body: CommentIn, pr: Current, conn: ConnDep) -> dict:
    a = _get(conn, pr, ref)
    if not body.body.strip():
        raise problem(422, "body", "Write a comment.")
    conn.execute(
        action_comment.insert().values(
            id=uuid.uuid4(), action_id=a["id"], author_id=pr.person_id, body=body.body.strip()
        )
    )
    return {"ok": True}


class ReassignIn(BaseModel):
    owner_id: uuid.UUID | None = None
    due_on: date | None = None
    priority: str | None = None
    interim_measure: str | None = None


@router.patch("/{ref}")
def reassign(ref: str, body: ReassignIn, request: Request, pr: Current, conn: ConnDep) -> dict:
    a = _get(conn, pr, ref)
    if not (pr.can("action.manage", a["property_id"]) or pr.can("assign", a["property_id"])):
        raise problem(403, "forbidden", "You can't reassign Actions here.")
    vals = {k: v for k, v in body.model_dump().items() if v is not None}
    if body.owner_id:
        vals["owner_text"] = None
    if "priority" in vals and vals["priority"] not in rules.PRIORITY_DAYS:
        raise problem(422, "priority", "Unknown priority.")
    if not vals:
        return {"ok": True}
    conn.execute(update(action).where(action.c.id == a["id"]).values(**vals))
    b, af = audit.diff(a, {**a, **vals})
    who = names(conn, {v for v in list(b.values()) + list(af.values()) if isinstance(v, uuid.UUID)})
    fmt = lambda d: {k: who.get(v, v) if isinstance(v, uuid.UUID) else v for k, v in d.items()}  # noqa: E731
    audit.record(
        conn,
        actor_for(request, pr),
        category="record",
        action="action.update",
        summary=f"Reassigned {a['ref']}" if body.owner_id else f"Changed {a['ref']}",
        entity_type="action",
        entity_id=a["id"],
        entity_ref=a["ref"],
        property_id=a["property_id"],
        before=fmt(b),
        after=fmt(af),
    )
    return {"ok": True}


class CallIn(BaseModel):
    note: str | None = None
    stop_sell_decision: str | None = None


@router.post("/{ref}/call-made")
def call_made(ref: str, body: CallIn, request: Request, pr: Current, conn: ConnDep) -> dict:
    """Class A failure: the system prompts the caller and records that the call was made (§7)."""
    a = _get(conn, pr, ref)
    now = clock.now()
    conn.execute(
        update(action)
        .where(action.c.id == a["id"])
        .values(
            call_made_at=now,
            call_made_by=pr.person_id,
            stop_sell_decision=body.stop_sell_decision or a["stop_sell_decision"],
        )
    )
    conn.execute(
        update(escalation)
        .where(escalation.c.action_id == a["id"], escalation.c.acknowledged_at.is_(None))
        .values(acknowledged_at=now, acknowledged_by=pr.person_id, ack_note=body.note or "Call made")
    )
    audit.record(
        conn,
        actor_for(request, pr),
        category="record",
        action="action.call_made",
        summary=f"Recorded the Class A phone call for {a['ref']}",
        entity_type="action",
        entity_id=a["id"],
        entity_ref=a["ref"],
        property_id=a["property_id"],
        after={"note": body.note, "stop_sell_decision": body.stop_sell_decision},
    )
    return {"ok": True}
