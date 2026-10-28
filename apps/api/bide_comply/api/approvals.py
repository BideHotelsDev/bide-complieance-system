"""Approvals (design: Approvals): switch-offs, N/A, Missed reasons, leave cover, pauses. Someone other than the
person who asked must decide (§2 separation of duties, SCH-07, SCH-10..12).
"""

import uuid
from datetime import date, timedelta

from fastapi import APIRouter, Request
from pydantic import BaseModel
from sqlalchemy import select, update

from bide_comply import audit, clock
from bide_comply.auth import Current, actor_for
from bide_comply.authz import not_self, scope_filter
from bide_comply.db import ConnDep
from bide_comply.schema import (
    approval_request,
    gate,
    gate_item,
    leave,
    property_,
    register_item,
    task,
    template,
)
from bide_comply.services import notify
from bide_comply.services.common import names, problem
from bide_comply.services.register import cancel_future, recompute_item, refresh_item
from bide_comply.services.views import _approval_item

router = APIRouter(prefix="/api/approvals", tags=["approvals"])

KINDS = [
    ("switch_off", "Switch off a check"),
    ("na", "Not applicable"),
    ("missed", "Missed reasons"),
    ("cover", "Leave cover"),
    ("pause", "Pauses"),
    ("backfile", "Back-filed records"),
]
CLASS_WEIGHT = {"A": 3, "B": 2, "C": 1}


def _rows(conn, pr, status: str | None = "waiting"):
    q = (
        select(
            approval_request,
            property_.c.name.label("property"),
            property_.c.code.label("property_code"),
            register_item.c.ref,
            template.c.name.label("template"),
            template.c["class"].label("klass"),
            template.c.default_frequency,
        )
        .outerjoin(property_, property_.c.id == approval_request.c.property_id)
        .outerjoin(register_item, register_item.c.id == approval_request.c.register_item_id)
        .outerjoin(template, template.c.id == register_item.c.template_id)
        .where(scope_filter(pr, approval_request.c.property_id))
    )
    if status:
        q = q.where(approval_request.c.status == status)
    else:
        q = q.where(approval_request.c.status != "waiting")
    return [dict(r) for r in conn.execute(q.order_by(approval_request.c.created_at.desc())).mappings()]


def _ago(dt) -> str:
    days = (clock.today() - clock.london(dt).date()).days
    return "today" if days == 0 else "yesterday" if days == 1 else f"{days} days ago"


@router.get("")
def list_approvals(pr: Current, conn: ConnDep, kind: str = "switch_off") -> dict:
    waiting = _rows(conn, pr)
    hist = _rows(conn, pr, None)
    who = names(conn, {r["requested_by"] for r in waiting + hist} | {r["decided_by"] for r in hist})
    tabs = [{"key": k, "label": label, "count": sum(1 for r in waiting if r["kind"] == k)} for k, label in KINDS]
    tabs.append({"key": "history", "label": "History", "count": None})

    def card(r):
        it = _approval_item(conn, r)
        sub = (
            f"{r['property']} · "
            + (f"Class {r['klass']} · " if r["klass"] else "")
            + (
                who.get(r["requested_by"])
                or ("from the holiday tracker" if r["source"] == "holiday_tracker" else "System")
            )
            + f" · {_ago(r['created_at'])}"
        )
        title = {
            "switch_off": r["template"],
            "missed": f"Missed: {(r['template'] or '').lower()}",
            "na": f"N/A: {r['template']}",
            "pause": f"Pause: {r['template']}",
            "backfile": f"Back-filed: {r['template']}",
        }.get(r["kind"])
        if r["kind"] == "cover":
            p = r["payload"]
            s, e = date.fromisoformat(p["starts_on"]), date.fromisoformat(p["ends_on"])
            title = f"Cover: {p.get('what', 'checks')}, {s.day}–{e.day} {e:%b}"
            sub = f"{r['property']} · from the holiday tracker" if r["source"] == "holiday_tracker" else sub
        return {
            "id": str(r["id"]),
            "kind": r["kind"],
            "title": title or it["title"],
            "sub": sub,
            "status": r["status"],
            "decided_by": who.get(r["decided_by"]),
            "decision_note": r["decision_note"],
        }

    pool = hist if kind == "history" else [r for r in waiting if r["kind"] == kind] if kind != "all" else waiting
    return {"tabs": tabs, "rows": [card(r) for r in pool], "all_waiting": [card(r) for r in waiting]}


@router.get("/{approval_id}")
def detail(approval_id: uuid.UUID, pr: Current, conn: ConnDep) -> dict:
    rows = [r for r in _rows(conn, pr) + _rows(conn, pr, None) if r["id"] == approval_id]
    if not rows:
        raise problem(404, "not_found", "Not found.")
    r = rows[0]
    who = names(conn, {r["requested_by"], r["decided_by"]})
    out = {
        "id": str(r["id"]),
        "kind": r["kind"],
        "status": r["status"],
        "class": r["klass"],
        "property": r["property"],
        "reason": r["reason"],
        "note": r["note"],
        "requested_by": who.get(r["requested_by"]),
        "decided_by": who.get(r["decided_by"]),
        "decision_note": r["decision_note"],
        "ref": r["ref"],
        "property_code": r["property_code"],
        "can_decide": pr.can("approval.decide", r["property_id"])
        and r["requested_by"] != pr.person_id
        and r["status"] == "waiting",
        "own": r["requested_by"] == pr.person_id,
        "checks": [],
    }
    weight = CLASS_WEIGHT.get(r["klass"] or "C", 1)
    if r["kind"] == "switch_off":
        out["title"] = f"Switch off “{r['template']}” at {r['property']}?"
        out["facts"] = [
            ("Requested by", f"{who.get(r['requested_by'])}"),
            ("Their reason", f"“{r['reason']}”"),
            (
                "What changes",
                f"The check stops being scheduled at {r['property']} and shows Grey (not applicable) on the register.",
            ),
            (
                "Effect on score",
                f"Class {r['klass']} items carry weight {weight}. Removed from points available, so the score is unaffected."
                if r["klass"] != "A"
                else "Class A items carry weight 3. Life-safety checks can be switched off only with the assessor's written agreement.",
            ),
            ("Review", "Comes back for review every year, or straight away if things change."),
        ]
        # Point the approver at anything on the opening checklist that mentions the same thing.
        g = conn.execute(select(gate.c.id).where(gate.c.property_id == r["property_id"])).scalar()
        if g and r["template"]:
            key = r["template"].split()[0]
            hit = conn.execute(
                select(gate_item.c.ref, gate_item.c.item, gate_item.c.notes).where(
                    gate_item.c.gate_id == g, gate_item.c.item.ilike(f"%{key}%")
                )
            ).first()
            if hit:
                out["checks"].append(
                    f"Check before approving: gate item {hit.ref} asks “{hit.item}”. "
                    + ("The notes say nothing about it yet." if not hit.notes else f"Notes: {hit.notes}")
                )
    elif r["kind"] == "missed":
        out["title"] = f"Accept the reason a check was missed: {(r['template'] or '').lower()}, {r['property']}?"
        out["facts"] = [
            ("Given by", who.get(r["requested_by"])),
            ("Their reason", f"“{r['reason']}”"),
            (
                "What changes",
                "The missed check is kept on the record as Missed with this reason. It still counts against on-time.",
            ),
            ("Next", "The next check is scheduled as normal."),
        ]
    elif r["kind"] == "na":
        out["title"] = f"Agree that “{r['template']}” doesn't apply this time?"
        out["facts"] = [
            ("Requested by", who.get(r["requested_by"])),
            ("Their reason", f"“{r['reason']}”"),
            ("Note", r["note"] or "—"),
            (
                "What changes",
                "This one check is marked N/A (approved). It is reported separately and left out of on-time.",
            ),
        ]
    elif r["kind"] == "cover":
        p = r["payload"]
        pn = names(conn, {uuid.UUID(p["person_id"]), uuid.UUID(p["cover_id"])})
        s, e = date.fromisoformat(p["starts_on"]), date.fromisoformat(p["ends_on"])
        n = conn.execute(
            select(register_item.c.id).where(
                register_item.c.property_id == r["property_id"],
                (register_item.c.accountable_id == uuid.UUID(p["person_id"]))
                | (register_item.c.done_by_person_id == uuid.UUID(p["person_id"])),
            )
        ).all()
        out["title"] = f"{pn.get(uuid.UUID(p['cover_id']))} covers {p.get('what', 'checks')} at {r['property']}?"
        out["facts"] = [
            ("On leave", f"{pn.get(uuid.UUID(p['person_id']))}, {s:%a %-d %b} – {e:%a %-d %b}"),
            ("Cover", pn.get(uuid.UUID(p["cover_id"]))),
            ("Checks", f"{len(n)} named on them, plus their pool checks"),
            (
                "What changes",
                "Checks go back automatically when the leave ends. The cover is shown on the scorecard so nobody loses points.",
            ),
        ]
        if uuid.UUID(p["cover_id"]) == pr.person_id:
            out["can_decide"] = False
            out["checks"].append("You're the cover person, so someone else must approve this.")
    elif r["kind"] == "pause":
        out["title"] = f"Pause “{r['template']}” at {r['property']}?"
        out["facts"] = [
            ("Requested by", who.get(r["requested_by"])),
            ("Their reason", f"“{r['reason']}”"),
            ("Until", (r["payload"] or {}).get("until") or "—"),
            ("What changes", "No checks are scheduled until then. The pause shows on the dashboard."),
        ]
    else:
        out["title"] = "Accept a back-filed paper record?"
        out["facts"] = [("Filed by", who.get(r["requested_by"])), ("Note", r["reason"])]
    out["facts"] = [{"label": k, "value": v} for k, v in out["facts"]]
    return out


class DecideIn(BaseModel):
    decision: str  # approve | decline | question
    note: str | None = None


@router.post("/{approval_id}/decide")
def decide(approval_id: uuid.UUID, body: DecideIn, request: Request, pr: Current, conn: ConnDep) -> dict:
    r = conn.execute(select(approval_request).where(approval_request.c.id == approval_id)).mappings().first()
    if not r:
        raise problem(404, "not_found", "Not found.")
    pr.require_property(r["property_id"])
    pr.require("approval.decide", r["property_id"])
    not_self(pr, r["requested_by"], "You asked for this, so someone else must approve it.")
    if r["kind"] == "cover":
        not_self(pr, uuid.UUID(r["payload"]["cover_id"]), "You're the cover person, so someone else must approve this.")
    if r["status"] != "waiting":
        raise problem(409, "decided", "This has already been decided.")
    if body.decision == "decline" and not (body.note and body.note.strip()):
        raise problem(422, "note", "Say why you're declining, so they know what to do next.")
    actor = actor_for(request, pr)
    if body.decision == "question":
        if r["requested_by"]:
            notify.notify(
                conn,
                {r["requested_by"]},
                kind="approval.question",
                title="A question about your request",
                body=body.note,
                link="/approvals",
            )
        return {"ok": True}
    status = "approved" if body.decision == "approve" else "declined"
    today = clock.today()
    conn.execute(
        update(approval_request)
        .where(approval_request.c.id == approval_id)
        .values(
            status=status,
            decided_by=pr.person_id,
            decided_at=clock.now(),
            decision_note=body.note,
            review_on=today + timedelta(days=365)
            if r["kind"] in ("switch_off", "na") and status == "approved"
            else None,
        )
    )
    if status == "approved":
        if r["kind"] == "switch_off":
            conn.execute(
                update(register_item)
                .where(register_item.c.id == r["register_item_id"])
                .values(state="off", state_reason=r["reason"], na_review_on=today + timedelta(days=365))
            )
            cancel_future(conn, r["register_item_id"])
        elif r["kind"] == "pause":
            until = (r["payload"] or {}).get("until")
            conn.execute(
                update(register_item)
                .where(register_item.c.id == r["register_item_id"])
                .values(
                    state="paused", state_reason=r["reason"], paused_until=date.fromisoformat(until) if until else None
                )
            )
            cancel_future(conn, r["register_item_id"])
        elif r["kind"] == "na" and r["task_id"]:
            conn.execute(update(task).where(task.c.id == r["task_id"]).values(status="na"))
        elif r["kind"] == "missed" and r["task_id"]:
            conn.execute(update(task).where(task.c.id == r["task_id"]).values(missed_reason_id=approval_id))
        elif r["kind"] == "cover":
            conn.execute(update(leave).where(leave.c.approval_id == approval_id).values(approved_by=pr.person_id))
            # From the moment of reassignment, late or missed checks count to the cover (SCH-13).
            p = r["payload"]
            away, cover = uuid.UUID(p["person_id"]), uuid.UUID(p["cover_id"])
            s, e = date.fromisoformat(p["starts_on"]), date.fromisoformat(p["ends_on"])
            conn.execute(
                update(task)
                .where(
                    task.c.owner_id == away,
                    task.c.status.in_(("scheduled", "open")),
                    task.c.due_at >= clock.start_of_day(s),
                    task.c.due_at <= clock.end_of_day(e),
                )
                .values(owner_id=cover)
            )
            notify.notify(
                conn,
                {cover},
                kind="cover.approved",
                title=f"You're covering {p.get('what', 'checks')}",
                body=f"{s:%a %-d %b} – {e:%a %-d %b}",
                link="/todo",
            )
    if r["register_item_id"]:
        if status == "approved" and r["kind"] in ("switch_off", "pause"):
            recompute_item(conn, r["register_item_id"])
        else:
            refresh_item(conn, r["register_item_id"])
    audit.record(
        conn,
        actor,
        category="record",
        action=f"approval.{status}",
        summary=f"{'Approved' if status == 'approved' else 'Declined'} a request ({dict(KINDS).get(r['kind'], r['kind']).lower()})",
        entity_type="approval",
        entity_id=approval_id,
        property_id=r["property_id"],
        after={"note": body.note, "reason": r["reason"]},
    )
    if r["requested_by"]:
        notify.notify(
            conn,
            {r["requested_by"]},
            kind=f"approval.{status}",
            title=f"Your request was {'approved' if status == 'approved' else 'declined'}",
            body=body.note,
            link="/approvals?tab=history",
        )
    return {"status": status}


class CoverIn(BaseModel):
    person_id: uuid.UUID
    cover_id: uuid.UUID
    starts_on: date
    ends_on: date
    property_id: uuid.UUID


@router.post("/cover")
def request_cover(body: CoverIn, request: Request, pr: Current, conn: ConnDep) -> dict:
    """Manual leave entry (SCH-07): reassigns to the cover person once approved; the site lead and system owner are told."""
    pr.require_property(body.property_id)
    pr.require("assign", body.property_id)
    if body.ends_on < body.starts_on:
        raise problem(422, "dates", "The end date is before the start date.")
    if body.cover_id == body.person_id:
        raise problem(422, "cover", "Choose someone else to cover.")
    rid = uuid.uuid4()
    conn.execute(
        approval_request.insert().values(
            id=rid,
            kind="cover",
            property_id=body.property_id,
            requested_by=pr.person_id,
            reason="On leave",
            payload={
                "person_id": str(body.person_id),
                "cover_id": str(body.cover_id),
                "starts_on": body.starts_on.isoformat(),
                "ends_on": body.ends_on.isoformat(),
                "what": "checks",
            },
        )
    )
    conn.execute(
        leave.insert().values(
            id=uuid.uuid4(),
            person_id=body.person_id,
            starts_on=body.starts_on,
            ends_on=body.ends_on,
            source="manual",
            cover_id=body.cover_id,
            approval_id=rid,
        )
    )
    audit.record(
        conn,
        actor_for(request, pr),
        category="record",
        action="cover.request",
        summary="Set up leave cover",
        entity_type="approval",
        entity_id=rid,
        property_id=body.property_id,
        after={"from": body.starts_on, "until": body.ends_on},
    )
    return {"id": str(rid)}
