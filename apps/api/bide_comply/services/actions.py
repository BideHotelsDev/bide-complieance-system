"""Raising and closing Actions & Advisories (PRD §4.3, ACT-01..03)."""

import uuid
from datetime import date

from sqlalchemy import Connection, func, select, update

from bide_comply import audit, clock
from bide_comply.engine import actions as rules
from bide_comply.schema import action, action_evidence, certificate, property_, register_item, role_assignment
from bide_comply.services import notify
from bide_comply.services.common import names, next_ref, problem
from bide_comply.services.register import recompute_item


def site_lead(conn: Connection, property_id: uuid.UUID) -> uuid.UUID | None:
    return conn.execute(
        select(role_assignment.c.person_id)
        .where(role_assignment.c.role == "site_lead", role_assignment.c.property_id == property_id)
        .limit(1)
    ).scalar()


def system_owner(conn: Connection) -> uuid.UUID | None:
    return conn.execute(
        select(role_assignment.c.person_id).where(role_assignment.c.role == "system_owner").limit(1)
    ).scalar()


def raise_action(
    conn: Connection,
    actor: audit.Actor,
    *,
    property_id: uuid.UUID,
    description: str,
    type_: str = "action",
    source: str = "manual",
    source_ref: str | None = None,
    gate_ref: str | None = None,
    priority: str | None = None,
    klass: str | None = None,
    owner_id: uuid.UUID | None = None,
    owner_text: str | None = None,
    register_item_id: uuid.UUID | None = None,
    task_id: uuid.UUID | None = None,
    submission_id: uuid.UUID | None = None,
    gate_item_id: uuid.UUID | None = None,
    certificate_id: uuid.UUID | None = None,
    incident_id: uuid.UUID | None = None,
    evidence_ids: list[uuid.UUID] | None = None,
    raised_on: date | None = None,
    due_on: date | None = None,
    ref: str | None = None,
    status: str = "open",
    class_a_failure: bool = False,
) -> dict:
    priority = priority or rules.default_priority(klass)
    raised_on = raised_on or clock.today()
    due_on = due_on or rules.due_date(priority, raised_on, klass if class_a_failure else None)
    if owner_id is None and not owner_text and type_ != "advisory":
        owner_id = site_lead(conn, property_id) or system_owner(conn)
    aid = uuid.uuid4()
    ref = ref or next_ref(conn, property_id)
    conn.execute(
        action.insert().values(
            id=aid,
            ref=ref,
            property_id=property_id,
            type=type_,
            source=source,
            source_ref=source_ref,
            gate_ref=gate_ref,
            description=description,
            **{"class": klass},
            priority=priority,
            owner_id=owner_id,
            owner_text=owner_text,
            raised_on=raised_on,
            due_on=due_on,
            status=status,
            register_item_id=register_item_id,
            task_id=task_id,
            submission_id=submission_id,
            gate_item_id=gate_item_id,
            certificate_id=certificate_id,
            incident_id=incident_id,
            raised_by=actor.id,
            call_due=class_a_failure,
        )
    )
    for eid in evidence_ids or []:
        conn.execute(action_evidence.insert().values(action_id=aid, evidence_id=eid, purpose="raised"))
    audit.record(
        conn,
        actor,
        category="record",
        action="action.raise",
        summary=f"Raised {rules.TYPE_LABEL[type_]} {ref}: {description[:120]}",
        entity_type="action",
        entity_id=aid,
        entity_ref=ref,
        property_id=property_id,
        after={"priority": priority, "due_on": due_on, "owner_id": owner_id, "source": source},
    )
    pname = conn.execute(select(property_.c.name).where(property_.c.id == property_id)).scalar()
    if owner_id:
        notify.notify(
            conn,
            {owner_id},
            kind="action.assigned",
            klass=klass,
            title=f"{rules.PRIORITY_LABEL[priority]} · {description[:140]}",
            body=f"{pname} · {ref} · due {due_on:%-d %b}",
            link=f"/actions?sel={ref}",
        )
    if class_a_failure:
        notify.escalate(
            conn,
            "class_a_failure",
            property_id=property_id,
            klass="A",
            action_id=aid,
            register_item_id=register_item_id,
            summary=f"Class A at {pname}: {description[:160].rstrip('.')}. Action {ref} is due today.",
            dedupe_key=f"class_a:{aid}",
            link=f"/actions?sel={ref}",
        )
    if register_item_id:
        recompute_item(conn, register_item_id)
    return {"id": aid, "ref": ref, "priority": priority, "due_on": due_on, "owner_id": owner_id}


def close(
    conn: Connection,
    actor: audit.Actor,
    action_id: uuid.UUID,
    *,
    evidence_ids: list[uuid.UUID],
    decision: str | None,
    decision_reason: str | None,
    note: str | None = None,
) -> dict:
    a = conn.execute(select(action).where(action.c.id == action_id)).mappings().first()
    if not a:
        raise problem(404, "not_found", "Not found.")
    if a["status"] == "closed":
        raise problem(409, "closed", "This Action is already closed.")
    for eid in evidence_ids:
        conn.execute(action_evidence.insert().values(action_id=action_id, evidence_id=eid, purpose="closing"))
    count = conn.execute(
        select(func.count()).where(action_evidence.c.action_id == action_id, action_evidence.c.purpose == "closing")
    ).scalar()
    why = rules.close_problem(a["type"], count, decision or a["decision"], decision_reason or a["decision_reason"])
    if why:
        raise problem(422, "needs_evidence", why)
    today = clock.today()
    conn.execute(
        update(action)
        .where(action.c.id == action_id)
        .values(
            status="closed",
            closed_on=today,
            closed_by=actor.id,
            decision=decision or a["decision"],
            decision_reason=decision_reason or a["decision_reason"],
        )
    )
    audit.record(
        conn,
        actor,
        category="record",
        action="action.close",
        summary=f"Closed {a['ref']}" + (" with a recorded decision" if a["type"] == "advisory" else " with evidence"),
        entity_type="action",
        entity_id=action_id,
        entity_ref=a["ref"],
        property_id=a["property_id"],
        before={"status": a["status"]},
        after={"status": "closed", "note": note},
    )
    if a["certificate_id"]:
        # A certificate's fails each have an Action; when the last closes the register item may go Green (DOC-07).
        open_left = conn.execute(
            select(func.count()).where(action.c.certificate_id == a["certificate_id"], action.c.status != "closed")
        ).scalar()
        if not open_left:
            conn.execute(update(certificate).where(certificate.c.id == a["certificate_id"]).values(fail_count=0))
    if a["register_item_id"]:
        recompute_item(conn, a["register_item_id"])
    return {"ok": True}


def view_row(conn: Connection, a: dict, today: date | None = None, who: dict | None = None) -> dict:
    today = today or clock.today()
    who = who if who is not None else names(conn, {a["owner_id"]})
    owner = who.get(a["owner_id"]) if a["owner_id"] else None
    return {
        "id": str(a["id"]),
        "ref": a["ref"],
        "property_id": str(a["property_id"]),
        "type": a["type"],
        "type_label": rules.TYPE_LABEL[a["type"]],
        "source": a["source"],
        "source_label": a["source_ref"] or rules.SOURCE_LABEL.get(a["source"], a["source"]),
        "gate_ref": a["gate_ref"],
        "description": a["description"],
        "class": a["class"],
        "priority": a["priority"],
        "priority_label": rules.PRIORITY_LABEL[a["priority"]],
        "window": {
            "high": "7 days" + (" (life safety: same day)" if a["class"] == "A" else ""),
            "med": "30 days",
            "low": "90 days",
        }[a["priority"]],
        "owner_id": str(a["owner_id"]) if a["owner_id"] else None,
        "owner": owner or a["owner_text"] or "No owner yet",
        "owner_is_role": owner is None and bool(a["owner_text"]),
        "raised_on": a["raised_on"],
        "due_on": a["due_on"],
        "left": rules.days_left_label(a["due_on"], today, a["raised_on"], a["status"]),
        "late": rules.is_late(a["status"], a["due_on"], today),
        "status": a["status"],
        "status_label": {"open": "Open", "to_confirm": "To confirm", "closed": "Closed"}[a["status"]],
        "closed_on": a["closed_on"],
        "decision": a["decision"],
        "decision_reason": a["decision_reason"],
        "call_due": a["call_due"] and not a["call_made_at"],
        "register_item_id": str(a["register_item_id"]) if a["register_item_id"] else None,
    }


def item_ref(conn: Connection, register_item_id: uuid.UUID | None) -> str | None:
    if not register_item_id:
        return None
    return conn.execute(select(register_item.c.ref).where(register_item.c.id == register_item_id)).scalar()
