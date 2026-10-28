"""The staff app (PWA): Today, a check, report something, a contractor visit, History, My documents, Me (§6, §10.8)."""

import uuid
from datetime import date, datetime, timedelta

from fastapi import APIRouter, Request
from pydantic import BaseModel
from sqlalchemy import Connection, and_, func, or_, select

from bide_comply import audit, clock
from bide_comply.auth import Current, actor_for
from bide_comply.authz import Principal
from bide_comply.config import settings
from bide_comply.db import ConnDep
from bide_comply.engine import actions as action_rules
from bide_comply.engine import frequency as freq
from bide_comply.schema import (
    action,
    action_comment,
    action_evidence,
    alarm_event,
    approval_request,
    certificate,
    contractor,
    contractor_visit,
    device,
    escalation,
    incident,
    incident_evidence,
    leave,
    location,
    person,
    pool_member,
    property_,
    register_item,
    role_assignment,
    staff_requirement,
    staff_requirement_type,
    submission,
    task,
    template,
    verification,
)
from bide_comply.services import actions as action_service
from bide_comply.services import checks, notify, wording
from bide_comply.services import evidence as ev_service
from bide_comply.services.common import fmt_day, names, overdue_label, problem
from bide_comply.services.register import refresh_item

router = APIRouter(prefix="/api/field", tags=["staff app"])
CLASS_LABEL = {"A": "Life safety", "B": "Statutory", "C": "bide standard"}


def _my_tasks_query(conn: Connection, pr: Principal, property_id: uuid.UUID | None):
    pools = select(pool_member.c.pool_id).where(pool_member.c.person_id == pr.person_id)
    mine = or_(
        and_(register_item.c.done_by_kind == "person", register_item.c.done_by_person_id == pr.person_id),
        and_(register_item.c.done_by_kind == "pool", register_item.c.done_by_pool_id.in_(pools)),
        task.c.owner_id == pr.person_id,
    )
    q = (
        select(
            task,
            register_item.c.ref,
            register_item.c.property_id,
            register_item.c.location_id,
            template.c.name,
            template.c["class"].label("klass"),
            template.c.kind,
            template.c.default_frequency,
            template.c.frequency_note,
            template.c.typical_minutes,
            register_item.c.frequency,
            property_.c.name.label("property"),
        )
        .join(register_item, register_item.c.id == task.c.register_item_id)
        .join(template, template.c.id == register_item.c.template_id)
        .join(property_, property_.c.id == register_item.c.property_id)
        .where(mine, template.c.kind.in_(("check", "cleaning")), register_item.c.state == "on")
    )
    if property_id:
        q = q.where(register_item.c.property_id == property_id)
    return q


def _subtitle(r: dict, form: list[dict]) -> str:
    # The first useful hint about what to do, like "Rotate call point · next is CP3".
    f = freq.label(r["frequency"] or r["default_frequency"])
    if "call point" in r["name"].lower():
        return "Rotate call point"
    if r["frequency_note"] and "Each visit" in r["frequency_note"]:
        return "Each visit · " + (r["name"].split(",")[1].strip() if "," in r["name"] else "")
    return f


@router.get("/today")
def today(pr: Current, conn: ConnDep, property: uuid.UUID | None = None) -> dict:  # noqa: A002
    now = clock.now()
    t0 = clock.today()
    rows = [
        dict(r)
        for r in conn.execute(
            _my_tasks_query(conn, pr, property)
            .where(
                task.c.status.in_(("open", "overdue", "scheduled")),
                task.c.window_opens_at <= clock.end_of_day(t0 + timedelta(days=14)),
            )
            .order_by(task.c.due_at)
        ).mappings()
    ]
    # One card per register item: its earliest open occurrence.
    seen: set = set()
    overdue, todays, upcoming = [], [], []
    for r in rows:
        if r["register_item_id"] in seen:
            continue
        seen.add(r["register_item_id"])
        card = {
            "task_id": str(r["id"]),
            "ref": r["ref"],
            "title": _short_name(r["name"]),
            "full_title": r["name"],
            "class": r["klass"],
            "life_safety": r["klass"] == "A",
            "property": r["property"],
            "subtitle": _subtitle(r, []),
            "property_id": str(r["property_id"]),
            "due_at": r["due_at"],
            "minutes": r["typical_minutes"],
        }
        if card["subtitle"] == "Rotate call point":
            nxt = _next_call_point(conn, r["register_item_id"], r["property_id"])
            if nxt:
                card["subtitle"] += f" · next is {nxt.split(' · ')[0]}"
        if r["status"] == "overdue":
            card["badge"] = overdue_label(r["due_at"], now)
            overdue.append(card)
        elif r["status"] == "open":
            card["badge"] = "Due " + (
                "today" if clock.london(r["due_at"]).date() == t0 else fmt_day(clock.london(r["due_at"]).date())
            )
            todays.append(card)
        else:
            card["badge"] = (
                f"{fmt_day(clock.london(r['window_opens_at']).date())} · {freq.label(r['frequency'] or r['default_frequency']).lower()}"
            )
            upcoming.append(card)
    # Checks the person has asked to mark not applicable stay on the list, saying so, until a manager answers.
    waiting = set(
        conn.execute(
            select(approval_request.c.task_id).where(
                approval_request.c.kind == "na",
                approval_request.c.status == "waiting",
                approval_request.c.task_id.in_([uuid.UUID(c["task_id"]) for c in overdue + todays] or [uuid.uuid4()]),
            )
        ).scalars()
    )
    for c in overdue + todays:
        c["na_pending"] = uuid.UUID(c["task_id"]) in waiting
    streak = _streak_weeks(conn, pr.person_id)
    props = conn.execute(
        select(property_.c.id, property_.c.name)
        .where(property_.c.id.in_(pr.scope) if pr.scope is not None else property_.c.active.is_(True))
        .order_by(property_.c.sort)
    ).all()
    return {
        "first_name": pr.name.split()[0],
        "date_label": f"{t0:%a} {t0.day} {t0:%b}",
        "to_do_today": len(overdue) + len(todays),
        "overdue": overdue,
        "today": todays,
        "upcoming": upcoming[:5],
        "streak_weeks": streak,
        "properties": [{"id": str(p.id), "name": p.name} for p in props],
    }


def _call_points(conn: Connection, property_id: uuid.UUID) -> list[str]:
    return list(
        conn.execute(
            select(location.c.name)
            .where(location.c.property_id == property_id, location.c.active.is_(True), location.c.type == "call_point")
            .order_by(location.c.sort)
        ).scalars()
    )


def _rotate(conn: Connection, register_item_id: uuid.UUID, key: str | None, opts: list[str]) -> str:
    """The next call point in rotation after the last one recorded (any field holding a call point if no key)."""
    last = conn.execute(
        select(submission.c["values"])
        .join(task, task.c.id == submission.c.task_id)
        .where(task.c.register_item_id == register_item_id)
        .order_by(submission.c.server_time.desc())
        .limit(1)
    ).scalar()
    vals = last or {}
    prev = vals.get(key) if key else next((v for v in vals.values() if v in opts), None)
    idx = (opts.index(prev) + 1) % len(opts) if prev in opts else 0
    return opts[idx]


def _next_call_point(conn: Connection, register_item_id: uuid.UUID, property_id: uuid.UUID) -> str | None:
    opts = _call_points(conn, property_id)
    return _rotate(conn, register_item_id, None, opts) if opts else None


def _short_name(name: str) -> str:
    short = {
        "Fire alarm test, rotate call point, ARC signal confirmed": "Fire alarm test",
        "Escape routes, final exits and assembly point clear": "Escape routes clear",
        "Sauna: heater clear, guard, timer cut-off, rules sign": "Sauna safety check",
        "Fire door walk-check (closing, seals, no wedges)": "Fire door walk-check",
    }
    return short.get(name, name.split(" (")[0])


def _streak_weeks(conn: Connection, person_id: uuid.UUID) -> int:
    from bide_comply.api.scorecard import person_week

    start = clock.monday_of(clock.today())
    n = 0
    for i in range(1, 27):
        ws = start - timedelta(weeks=i)
        wk = person_week(conn, person_id, ws, ws + timedelta(days=6))
        if wk["checks"] and wk["on_time"] == 100:
            n += 1
        else:
            break
    return n


@router.get("/tasks/{task_id}")
def task_detail(task_id: uuid.UUID, pr: Current, conn: ConnDep) -> dict:
    t = checks.load_task(conn, task_id)
    if not checks.may_do(conn, pr, t):
        raise problem(404, "not_found", "Not found.")
    tpl = (
        conn.execute(
            select(
                template.c.guidance,
                template.c.example_photo_id,
                template.c.default_frequency,
                template.c.typical_minutes,
                register_item.c.frequency,
                property_.c.name.label("property"),
                property_.c.geofence_lat,
                property_.c.geofence_lng,
                property_.c.geofence_radius_m,
            )
            .join(register_item, register_item.c.template_id == template.c.id)
            .join(property_, property_.c.id == register_item.c.property_id)
            .where(register_item.c.id == t["register_item_id"])
        )
        .mappings()
        .one()
    )
    form = []
    locs = [
        dict(r)
        for r in conn.execute(
            select(location.c.id, location.c.name, location.c.type)
            .where(location.c.property_id == t["property_id"], location.c.active.is_(True))
            .order_by(location.c.sort)
        ).mappings()
    ]
    for f in t["form"]:
        f = dict(f)
        if f["type"] == "location":
            src = f.get("source")
            opts = [loc["name"] for loc in locs if not src or loc["type"] == src]
            f["options"] = opts
            if src == "call_point" and opts:
                # Suggest the next call point in rotation after the last one recorded.
                f["suggested"] = _rotate(conn, t["register_item_id"], f["key"], opts)
        form.append(f)
    now = clock.now()
    status = t["status"]
    note = None
    if status == "overdue":
        note = (
            f"{overdue_label(t['due_at'], now)} · still counts when done"
            if t["late_rule"] == "late"
            else overdue_label(t["due_at"], now)
        )
    last_rejection = conn.execute(
        select(verification.c.comment, verification.c.created_at)
        .join(submission, submission.c.id == verification.c.submission_id)
        .where(submission.c.task_id == task_id, verification.c.result == "rejected")
        .order_by(verification.c.created_at.desc())
        .limit(1)
    ).first()
    na_pending = bool(
        conn.execute(
            select(approval_request.c.id).where(
                approval_request.c.task_id == task_id,
                approval_request.c.kind == "na",
                approval_request.c.status == "waiting",
            )
        ).first()
    )
    return {
        "task_id": str(task_id),
        "ref": t["ref"],
        "title": _short_name(t["template_name"]),
        "full_title": t["template_name"],
        "property": tpl["property"],
        "frequency": freq.label(tpl["frequency"] or tpl["default_frequency"]),
        "class": t["klass"],
        "class_label": CLASS_LABEL[t["klass"]],
        "status": status,
        "status_note": note,
        "guidance": tpl["guidance"],
        "example_photo_id": str(tpl["example_photo_id"]) if tpl["example_photo_id"] else None,
        "property_id": str(t["property_id"]),
        "form": form,
        "version": t["version"],
        "due_at": t["due_at"],
        "window_opens_at": t["window_opens_at"],
        "window_closes_at": t["window_closes_at"],
        "late_rule": t["late_rule"],
        "geofence_required": t["geofence_required"],
        "can_submit": status in ("open", "overdue"),
        "rejected": {"comment": last_rejection.comment} if last_rejection and status == "open" else None,
        # For the camera's "On site" pill (design: AppCamera); compared on the phone, recorded only at submission.
        "geofence": {
            "lat": tpl["geofence_lat"],
            "lng": tpl["geofence_lng"],
            "radius_m": tpl["geofence_radius_m"] or settings.geofence_default_radius_m,
        }
        if tpl["geofence_lat"] is not None
        else None,
        "can_request_na": not na_pending,
        "na_pending": na_pending,
    }


class SubmitIn(BaseModel):
    values: dict
    photos: dict[str, list[uuid.UUID]] = {}
    work_done_on: date | None = None
    device_time: datetime | None = None
    captured_offline: bool = False
    lat: float | None = None
    lng: float | None = None
    accuracy: float | None = None
    notes: str | None = None
    signature: str | None = None


@router.post("/tasks/{task_id}/submit")
def submit(task_id: uuid.UUID, body: SubmitIn, request: Request, pr: Current, conn: ConnDep) -> dict:
    pr.require("task.complete")
    out = checks.submit(
        conn,
        pr,
        actor_for(request, pr),
        task_id,
        values=body.values,
        photos=body.photos,
        work_done_on=body.work_done_on,
        device_time=body.device_time,
        captured_offline=body.captured_offline,
        lat=body.lat,
        lng=body.lng,
        accuracy=body.accuracy,
        notes=body.notes,
        signature=body.signature,
    )
    if out["action"]:
        a = out["action"]
        # What the person sees next (design: Problem found): who's fixing it, who has been told, and their streak.
        out["result_screen"] = {
            "title": wording.text(conn, "failed_result", "Logged as Failed. Thank you for reporting it."),
            "priority_label": action_rules.PRIORITY_LABEL[a["priority"]],
            "due_label": "due today" if a["due_on"] == clock.today() else f"due {fmt_day(a['due_on'])}",
            "owner": a["owner"],
            "class_a": a["class_a"],
            "alerted": _alerted(conn, task_id, a["ref"], pr.person_id),
        }
    return out


def _alerted(conn: Connection, task_id: uuid.UUID, ref: str, me: uuid.UUID) -> list[str]:
    """First names of the people told about a failed check, for the result screen: the failed-check escalation and, for
    a Class A failure, the §7 Class A alert (David, Samantha and the assessor, by role)."""
    aid = conn.execute(select(action.c.id).where(action.c.ref == ref)).scalar()
    recs = conn.execute(
        select(escalation.c.recipients).where(escalation.c.dedupe_key.in_((f"failed:{task_id}", f"class_a:{aid}")))
    ).scalars()
    ids = {uuid.UUID(x) for rec in recs for x in (rec or [])} - {me}
    if not ids:
        return []
    rows = conn.execute(select(person.c.id, person.c.name, person.c.kind).where(person.c.id.in_(ids))).all()
    assessors = set(
        conn.execute(
            select(role_assignment.c.person_id).where(
                role_assignment.c.person_id.in_(ids), role_assignment.c.role == "assessor"
            )
        ).scalars()
    )
    # Placeholder people from the register ("[Site lead, The View]") keep their whole name.
    named = sorted(r.name if r.name.startswith("[") else r.name.split()[0] for r in rows if r.id not in assessors)
    return named + (["the assessor"] if assessors else [])


class ActionAddIn(BaseModel):
    note: str | None = None
    photos: list[uuid.UUID] = []


@router.post("/actions/{ref}/add")
def add_to_action(ref: str, body: ActionAddIn, request: Request, pr: Current, conn: ConnDep) -> dict:
    """Add a note or photo to an Action raised from your own check or report (design: Problem found › Add a note or
    photo). The photos are filed as evidence of the problem, never as proof that it's fixed."""
    a = conn.execute(select(action).where(action.c.ref == ref.upper())).mappings().first()
    if not a:
        raise problem(404, "not_found", "Not found.")
    pr.require_property(a["property_id"])
    mine = a["raised_by"] == pr.person_id or (
        a["submission_id"] is not None
        and conn.execute(select(submission.c.submitter_id).where(submission.c.id == a["submission_id"])).scalar()
        == pr.person_id
    )
    if not mine:
        raise problem(403, "not_yours", "You can add to problems you reported.")
    note = (body.note or "").strip()
    if not note and not body.photos:
        raise problem(422, "empty", "Add a note or a photo.")
    ev = ev_service.stored(conn, body.photos, pr.person_id)
    if len(ev) != len(body.photos):
        raise problem(422, "evidence", "A photo didn't finish uploading. Take it again.")
    if note:
        conn.execute(
            action_comment.insert().values(id=uuid.uuid4(), action_id=a["id"], author_id=pr.person_id, body=note)
        )
    for e in ev:
        conn.execute(action_evidence.insert().values(action_id=a["id"], evidence_id=e["id"], purpose="raised"))
    audit.record(
        conn,
        actor_for(request, pr),
        category="record",
        action="action.add",
        summary=f"Added to {a['ref']} from the staff app",
        entity_type="action",
        entity_id=a["id"],
        entity_ref=a["ref"],
        property_id=a["property_id"],
        after={"note": bool(note), "photos": len(ev)},
    )
    if a["owner_id"] and a["owner_id"] != pr.person_id:
        notify.notify(
            conn,
            {a["owner_id"]},
            kind="action.note",
            klass=a["class"],
            title=f"{pr.name.split()[0]} added to {a['ref']}",
            body=note[:200] or None,
            link=f"/actions?sel={a['ref']}",
        )
    return {"ok": True, "ref": a["ref"]}


class NaIn(BaseModel):
    reason: str
    note: str


@router.post("/tasks/{task_id}/na")
def request_na(task_id: uuid.UUID, body: NaIn, request: Request, pr: Current, conn: ConnDep) -> dict:
    t = checks.load_task(conn, task_id)
    if not checks.may_do(conn, pr, t):
        raise problem(404, "not_found", "Not found.")
    if not body.note.strip():
        raise problem(422, "note", "Add a note so your manager can agree.")
    if t["status"] not in ("open", "overdue", "scheduled"):
        raise problem(409, "closed", "This check has already been sent in or closed.")
    if conn.execute(
        select(approval_request.c.id).where(
            approval_request.c.task_id == task_id,
            approval_request.c.kind == "na",
            approval_request.c.status == "waiting",
        )
    ).first():
        raise problem(409, "waiting", "You've already asked. Your manager hasn't answered yet.")
    return checks.request_exception(
        conn, pr, actor_for(request, pr), kind="na", reason=body.reason, note=body.note, task_id=task_id
    )


class ReportIn(BaseModel):
    kind: str  # hazard | accident | near_miss | alarm
    property_id: uuid.UUID
    location_id: uuid.UUID | None = None
    location_text: str | None = None
    description: str
    photos: list[uuid.UUID] = []
    riddor: bool = False
    people_involved: str | None = None
    # alarm events
    zone: str | None = None
    cause: str | None = None
    false_alarm: bool = True
    arc_response: str | None = None
    attended_minutes: int | None = None


LIFE_SAFETY_WORDS = (
    "fire door",
    "door doesn't close",
    "exit",
    "escape",
    "alarm",
    "smoke",
    "emergency light",
    "extinguisher",
)


@router.post("/reports")
def report(body: ReportIn, request: Request, pr: Current, conn: ConnDep) -> dict:
    """Report something: a hazard becomes an Action (EXE-09); an accident or near miss is an incident (EXE-12); an alarm
    going off is an alarm event (EXE-15), and three with the same cause raise an engineering-review Action."""
    pr.require_property(body.property_id)
    pr.require("action.raise", body.property_id)
    actor = actor_for(request, pr)
    photos = [e["id"] for e in ev_service.stored(conn, body.photos, pr.person_id)]
    loc = (
        conn.execute(select(location.c.name).where(location.c.id == body.location_id)).scalar()
        if body.location_id
        else body.location_text
    )
    if body.kind == "alarm":
        pr.require("alarm.log", body.property_id)
        aid = uuid.uuid4()
        conn.execute(
            alarm_event.insert().values(
                id=aid,
                property_id=body.property_id,
                occurred_at=clock.now(),
                zone=body.zone or loc,
                cause=body.cause,
                false_alarm=body.false_alarm,
                arc_response=body.arc_response,
                keyholder_attended_minutes=body.attended_minutes,
                notes=body.description,
                logged_by=pr.person_id,
            )
        )
        audit.record(
            conn,
            actor,
            category="record",
            action="alarm.log",
            summary="Logged a fire alarm activation",
            entity_type="alarm_event",
            entity_id=aid,
            property_id=body.property_id,
            after={"cause": body.cause, "false_alarm": body.false_alarm},
        )
        raised = None
        if body.false_alarm and body.cause:
            n = conn.execute(
                select(func.count()).where(
                    alarm_event.c.property_id == body.property_id,
                    alarm_event.c.cause == body.cause,
                    alarm_event.c.false_alarm.is_(True),
                    alarm_event.c.action_id.is_(None),
                    alarm_event.c.occurred_at >= clock.now() - timedelta(days=90),
                )
            ).scalar()
            if n >= 3:
                raised = action_service.raise_action(
                    conn,
                    actor,
                    property_id=body.property_id,
                    source="alarm_events",
                    priority="high",
                    klass="B",
                    description=f"{n} false alarms with the same cause ({body.cause}): engineering review needed",
                    owner_id=None,
                )
                conn.execute(
                    alarm_event.update()
                    .where(
                        alarm_event.c.property_id == body.property_id,
                        alarm_event.c.cause == body.cause,
                        alarm_event.c.action_id.is_(None),
                    )
                    .values(action_id=raised["id"])
                )
                notify.escalate(
                    conn,
                    "alarm_events",
                    property_id=body.property_id,
                    summary=f"Three false alarms with the same cause ({body.cause}). Action {raised['ref']} raised.",
                    dedupe_key=f"alarm:{raised['id']}",
                    action_id=raised["id"],
                )
        return {
            "kind": "alarm",
            "action": raised["ref"] if raised else None,
            "message": "Logged. Thank you."
            + (
                f" Three with the same cause, so {raised['ref']} was raised for an engineering review."
                if raised
                else ""
            ),
        }
    if not body.description.strip():
        raise problem(422, "description", "Say what's wrong.")
    text = f"{loc}: {body.description.strip()}" if loc else body.description.strip()
    life = any(w in text.lower() for w in LIFE_SAFETY_WORDS)
    if body.kind in ("accident", "near_miss", "dangerous_occurrence"):
        iid = uuid.uuid4()
        conn.execute(
            incident.insert().values(
                id=iid,
                property_id=body.property_id,
                kind=body.kind,
                occurred_at=clock.now(),
                location_id=body.location_id,
                location_text=body.location_text,
                description=body.description,
                people_involved=body.people_involved,
                riddor_reportable=body.riddor,
                reported_by=pr.person_id,
            )
        )
        for e in photos:
            conn.execute(incident_evidence.insert().values(incident_id=iid, evidence_id=e))
        audit.record(
            conn,
            actor,
            category="record",
            action="incident.report",
            summary=f"Reported {'an accident' if body.kind == 'accident' else 'a near miss'}",
            entity_type="incident",
            entity_id=iid,
            property_id=body.property_id,
            after={"riddor": body.riddor},
        )
        r = action_service.raise_action(
            conn,
            actor,
            property_id=body.property_id,
            source="incident",
            description=text,
            priority="high" if body.riddor else "med",
            klass="B",
            incident_id=iid,
            evidence_ids=photos,
        )
    else:
        r = action_service.raise_action(
            conn,
            actor,
            property_id=body.property_id,
            source="hazard",
            description=text,
            priority="high" if life else "med",
            klass="A" if life else "B",
            evidence_ids=photos,
        )
    told: set[uuid.UUID] = {r["owner_id"]} if r["owner_id"] else set()
    if life or body.riddor:
        # Life safety, or possibly reportable to the HSE: the system owner hears straight away as well as the Action's
        # owner (design: "Samantha will be told straight away"). Class A, so never held overnight or muted.
        so = action_service.system_owner(conn)
        extra = {so} - told - {pr.person_id} if so else set()
        if extra:
            pname = conn.execute(select(property_.c.name).where(property_.c.id == body.property_id)).scalar()
            notify.notify(
                conn,
                extra,
                kind="report.urgent",
                klass="A" if life else "B",
                title=f"{'Life safety' if life else 'Possible RIDDOR'} at {pname}: {text[:120]}",
                body=f"Reported by {pr.name} · {r['ref']}",
                link=f"/actions?sel={r['ref']}",
                channels=["app", "push", "slack_dm"],
            )
            told |= extra
    told.discard(pr.person_id)
    told_names = names(conn, told) if told else {}
    first = sorted(n if n.startswith("[") else n.split()[0] for n in told_names.values())
    owner = told_names.get(r["owner_id"]) if r["owner_id"] else None
    return {
        "kind": body.kind,
        "action": r["ref"],
        "life_safety": life,
        "owner": owner,
        "told": first,
        "message": "Sent. Thank you for reporting it."
        + (
            f" {' and '.join(first) if len(first) <= 2 else ', '.join(first[:-1]) + ' and ' + first[-1]}"
            f" {'has' if len(first) == 1 else 'have'} been told straight away."
            if (life or body.riddor) and first
            else ""
        ),
    }


class VisitIn(BaseModel):
    contractor_id: uuid.UUID | None = None
    new_contractor: str | None = None
    property_id: uuid.UUID
    purpose: str
    register_item_id: uuid.UUID | None = None
    evidence_id: uuid.UUID | None = None
    photo_id: uuid.UUID | None = None
    fails: list[dict] = []  # [{text, priority}]


@router.get("/contractor-visit")
def visit_form(pr: Current, conn: ConnDep, property: uuid.UUID) -> dict:  # noqa: A002
    pr.require_property(property)
    cons = (
        conn.execute(
            select(contractor.c.id, contractor.c.name, contractor.c.trade)
            .where(contractor.c.active.is_(True))
            .order_by(contractor.c.name)
        )
        .mappings()
        .all()
    )
    certs = (
        conn.execute(
            select(register_item.c.id, register_item.c.ref, template.c.name, template.c.default_frequency)
            .join(template, template.c.id == register_item.c.template_id)
            .where(
                register_item.c.property_id == property,
                register_item.c.state == "on",
                template.c.kind.in_(("certificate", "contractor_visit")),
            )
        )
        .mappings()
        .all()
    )
    purposes = [
        ("Fire alarm service", "Fire alarm service"),
        ("Emergency lighting", "Emergency lighting"),
        ("Gas safety", "Gas Safe"),
        ("Electrical (EICR)", "EICR"),
        ("Other", None),
    ]
    out = []
    for label, key in purposes:
        hit = next((c for c in certs if key and key.lower() in c["name"].lower()), None)
        out.append(
            {
                "label": label,
                "register_item_id": str(hit["id"]) if hit else None,
                "links_to": f"{freq.label(hit['default_frequency']).lower()} {hit['name'].split(' (')[0].lower()}"
                if hit
                else None,
            }
        )
    return {"contractors": [dict(c) | {"id": str(c["id"])} for c in cons], "purposes": out}


@router.post("/contractor-visits")
def log_visit(body: VisitIn, request: Request, pr: Current, conn: ConnDep) -> dict:
    """Staff log a contractor visit on the contractor's behalf (DOC-05). Each fail becomes an Action (DOC-07)."""
    pr.require_property(body.property_id)
    pr.require("task.complete", body.property_id)
    actor = actor_for(request, pr)
    fails = [{"text": str(f.get("text") or "").strip(), "priority": f.get("priority") or "med"} for f in body.fails]
    if any(not f["text"] for f in fails):
        raise problem(422, "fails", "Say what needs fixing for each one.")
    if any(f["priority"] not in action_rules.PRIORITY_DAYS for f in fails):
        raise problem(422, "fails", "Choose Urgent, Soon or Later for each one.")
    if (
        body.register_item_id
        and conn.execute(
            select(register_item.c.property_id).where(register_item.c.id == body.register_item_id)
        ).scalar()
        != body.property_id
    ):
        raise problem(422, "register_item", "That check isn't at this property.")
    if body.evidence_id and not ev_service.stored(conn, [body.evidence_id], pr.person_id):
        raise problem(422, "evidence", "The certificate didn't finish uploading. Try again.")
    cid = body.contractor_id
    if not cid:
        if not (body.new_contractor and body.new_contractor.strip()):
            raise problem(422, "contractor", "Choose who came, or add a new contractor.")
        cid = uuid.uuid4()
        conn.execute(contractor.insert().values(id=cid, name=body.new_contractor.strip()))
    vid = uuid.uuid4()
    conn.execute(
        contractor_visit.insert().values(
            id=vid,
            contractor_id=cid,
            property_id=body.property_id,
            register_item_id=body.register_item_id,
            visit_on=clock.today(),
            status="done",
            purpose=body.purpose,
            fails_found=fails,
            logged_by=pr.person_id,
            evidence_id=body.evidence_id,
            photo_id=body.photo_id,
        )
    )
    cname = conn.execute(select(contractor.c.name).where(contractor.c.id == cid)).scalar()
    cert_id = None
    if body.register_item_id and body.evidence_id:
        ri = (
            conn.execute(
                select(
                    register_item.c.ref,
                    template.c.name,
                    template.c["class"].label("klass"),
                    template.c.default_frequency,
                )
                .join(template, template.c.id == register_item.c.template_id)
                .where(register_item.c.id == body.register_item_id)
            )
            .mappings()
            .one()
        )
        f = freq.get(ri["default_frequency"])
        expires = (clock.today() + f.interval) if f.interval else None
        cert_id = uuid.uuid4()
        conn.execute(
            certificate.insert().values(
                id=cert_id,
                property_id=body.property_id,
                register_item_id=body.register_item_id,
                type="visit",
                title=ri["name"],
                issuer=cname,
                contractor_id=cid,
                issued_on=clock.today(),
                expires_on=expires,
                evidence_id=body.evidence_id,
                contractor_visit_id=vid,
                filing="filed",
                fail_count=len(fails),
            )
        )
    refs = []
    for f in fails:
        r = action_service.raise_action(
            conn,
            actor,
            property_id=body.property_id,
            source="contractor_visit",
            source_ref=f"{cname} visit {clock.today():%-d %b}",
            description=f["text"],
            priority=f["priority"],
            register_item_id=body.register_item_id,
            certificate_id=cert_id,
        )
        refs.append(r["ref"])
    audit.record(
        conn,
        actor,
        category="check",
        action="contractor.visit",
        summary=f"Logged a {cname} visit",
        entity_type="contractor_visit",
        entity_id=vid,
        property_id=body.property_id,
        after={"purpose": body.purpose, "fails": len(fails)},
    )
    done_task = None
    if body.register_item_id:
        done_task = checks.complete_from_visit(
            conn,
            actor,
            register_item_id=body.register_item_id,
            logged_by=pr.person_id,
            contractor_name=cname,
            purpose=body.purpose,
            evidence_id=body.evidence_id,
            visit_id=vid,
            fails=[f["text"] for f in fails],
        )
        refresh_item(conn, body.register_item_id)
    return {"id": str(vid), "actions": refs, "task_done": str(done_task) if done_task else None}


@router.get("/history")
def history(pr: Current, conn: ConnDep) -> dict:
    rows = (
        conn.execute(
            select(
                submission.c.id,
                submission.c.server_time,
                submission.c.result,
                submission.c.flags,
                submission.c.failed_fields,
                task.c.id.label("task_id"),
                task.c.status,
                template.c.name,
            )
            .join(task, task.c.id == submission.c.task_id)
            .join(register_item, register_item.c.id == task.c.register_item_id)
            .join(template, template.c.id == register_item.c.template_id)
            .where(submission.c.submitter_id == pr.person_id)
            .order_by(submission.c.server_time.desc())
            .limit(60)
        )
        .mappings()
        .all()
    )
    checked = (
        list(
            conn.execute(
                select(
                    verification.c.submission_id,
                    verification.c.result,
                    verification.c.comment,
                    verification.c.verifier_id,
                )
                .where(verification.c.submission_id.in_([r["id"] for r in rows]))
                .order_by(verification.c.created_at)
            )
        )
        if rows
        else []
    )
    rejections = {v.submission_id: v for v in checked if v.result == "rejected"}
    approved = {v.submission_id for v in checked if v.result == "approved"}
    vnames = names(conn, {r.verifier_id for r in rejections.values()})
    send_again = []
    groups: dict[str, list] = {}
    t0 = clock.today()
    for r in rows:
        d = clock.london(r["server_time"]).date()
        if r["id"] in rejections and r["status"] == "open":
            rej = rejections[r["id"]]
            send_again.append(
                {
                    "task_id": str(r["task_id"]),
                    "title": _short_name(r["name"]),
                    "comment": rej.comment,
                    "by": vnames.get(rej.verifier_id, "").split()[0],
                }
            )
            continue
        label = (
            "Today"
            if d == t0
            else "Yesterday"
            if d == t0 - timedelta(days=1)
            else "This week"
            if d >= clock.monday_of(t0)
            else "Last week"
            if d >= clock.monday_of(t0) - timedelta(weeks=1)
            else d.strftime("%B")
        )
        detail = clock.london(r["server_time"]).strftime("%H:%M") if d == t0 else fmt_day(d)
        if r["result"] == "failed" and r["failed_fields"]:
            detail += " · " + (r["failed_fields"][0].get("text") or r["failed_fields"][0]["why"]).lower()
        if "captured_offline" in r["flags"]:
            detail += " · captured offline"
        # Each row says what happened to that submission, not where the task is now.
        if r["id"] in rejections:
            status = "Sent back"
        elif r["result"] == "failed":
            status = "Failed"
        elif r["id"] in approved or r["status"] == "verified":
            status = "Verified"
        elif r["status"] == "submitted":
            status = "Sent"
        else:
            status = "Passed"
        groups.setdefault(label, []).append(
            {"id": str(r["id"]), "title": _short_name(r["name"]), "detail": detail, "status": status}
        )
    return {"send_again": send_again, "groups": [{"label": k, "rows": v} for k, v in groups.items()]}


@router.get("/documents")
def documents(pr: Current, conn: ConnDep) -> dict:
    rows = (
        conn.execute(
            select(
                staff_requirement,
                staff_requirement_type.c.name.label("requirement"),
                staff_requirement_type.c.key,
                property_.c.name.label("property"),
            )
            .join(staff_requirement_type, staff_requirement_type.c.id == staff_requirement.c.type_id)
            .outerjoin(property_, property_.c.id == staff_requirement.c.property_id)
            .where(staff_requirement.c.person_id == pr.person_id)
        )
        .mappings()
        .all()
    )
    t0 = clock.today()
    out = []
    for r in rows:
        if r["status"] == "done" and r["expires_on"] and r["expires_on"] < t0:
            st, label = "expired", "Expired"
        elif r["status"] == "done" and r["expires_on"] and r["expires_on"] <= t0 + timedelta(days=60):
            st, label = "expiring", f"Expires in {(r['expires_on'] - t0).days} days"
        elif r["status"] == "done":
            st, label = (
                "ok",
                {"manual_signed": "Signed", "right_to_work": "On file", "keyholder_drill": "Done"}.get(
                    r["key"], "Valid"
                ),
            )
        elif r["status"] == "pending":
            st, label = "pending", "Being checked"
        else:
            st, label = "missing", "Missing"
        out.append(
            {
                "id": str(r["id"]),
                "title": r["requirement"],
                "detail": r["detail"] or r["property"] or "",
                "status": st,
                "label": label,
                "key": r["key"],
            }
        )
    all_set = all(o["status"] == "ok" for o in out) and bool(out)
    types = conn.execute(
        select(staff_requirement_type.c.key, staff_requirement_type.c.name, staff_requirement_type.c.renew_months)
        .where(staff_requirement_type.c.restricted.is_(False))
        .order_by(staff_requirement_type.c.name)
    ).mappings()
    keeper = conn.execute(
        select(person.c.name)
        .join(role_assignment, role_assignment.c.person_id == person.c.id)
        .where(role_assignment.c.role == "register_keeper", person.c.employment_status == "active")
        .limit(1)
    ).scalar()
    return {
        "all_set": all_set,
        "rows": out,
        "types": [dict(t) for t in types],
        # Who checks an uploaded certificate ("Lynne will check it").
        "checker": (keeper if keeper.startswith("[") else keeper.split()[0]) if keeper else None,
    }


@router.get("/locations")
def locations(pr: Current, conn: ConnDep, property: uuid.UUID) -> list[dict]:  # noqa: A002
    """Where something happened, for Report something."""
    pr.require_property(property)
    rows = conn.execute(
        select(location.c.id, location.c.name, location.c.type)
        .where(location.c.property_id == property, location.c.active.is_(True))
        .order_by(location.c.sort)
    ).mappings()
    return [dict(r) | {"id": str(r["id"])} for r in rows]


class DocUploadIn(BaseModel):
    type_key: str
    evidence_id: uuid.UUID
    expires_on: date | None = None


@router.post("/documents")
def upload_document(body: DocUploadIn, request: Request, pr: Current, conn: ConnDep) -> dict:
    """Staff upload a course certificate; the register keeper checks it (status Being checked until then)."""
    if not ev_service.stored(conn, [body.evidence_id], pr.person_id):
        raise problem(422, "evidence", "The file didn't finish uploading. Try again.")
    tid = conn.execute(
        select(staff_requirement_type.c.id).where(staff_requirement_type.c.key == body.type_key)
    ).scalar()
    if not tid:
        raise problem(422, "type", "Unknown document type.")
    existing = conn.execute(
        select(staff_requirement.c.id).where(
            staff_requirement.c.person_id == pr.person_id, staff_requirement.c.type_id == tid
        )
    ).scalar()
    vals = {"status": "pending", "evidence_id": body.evidence_id, "expires_on": body.expires_on}
    if existing:
        conn.execute(staff_requirement.update().where(staff_requirement.c.id == existing).values(**vals))
    else:
        existing = uuid.uuid4()
        conn.execute(staff_requirement.insert().values(id=existing, person_id=pr.person_id, type_id=tid, **vals))
    keeper = (
        conn.execute(select(role_assignment.c.person_id).where(role_assignment.c.role == "register_keeper"))
        .scalars()
        .all()
    )
    tname = conn.execute(select(staff_requirement_type.c.name).where(staff_requirement_type.c.id == tid)).scalar()
    notify.notify(
        conn,
        set(keeper),
        kind="document.uploaded",
        title=f"{pr.name} uploaded a certificate to check",
        body=tname,
        link=f"/settings/people?sel={pr.person_id}",
    )
    audit.record(
        conn,
        actor_for(request, pr),
        category="record",
        action="document.upload",
        summary="Uploaded a training certificate",
        entity_type="staff_requirement",
        entity_id=existing,
        after={"type": body.type_key},
    )
    return {"ok": True}


@router.get("/me")
def me(pr: Current, conn: ConnDep) -> dict:
    from bide_comply.api.scorecard import person_week

    t0 = clock.today()
    month_start = t0.replace(day=1)
    wk = person_week(conn, pr.person_id, month_start, t0)
    done = conn.execute(
        select(func.count()).where(
            task.c.completed_by == pr.person_id, task.c.completed_at >= clock.start_of_day(month_start)
        )
    ).scalar()
    problems = conn.execute(
        select(func.count())
        .select_from(submission)
        .where(
            submission.c.submitter_id == pr.person_id,
            submission.c.result == "failed",
            submission.c.server_time >= clock.start_of_day(month_start),
        )
    ).scalar()
    # Consecutive days with every check on time, counted the scorecard's way (SCH-13): a check done late breaks it
    # for whoever did it; one left overdue or missed breaks it for its owner. Reporting a fail never does.
    since = t0 - timedelta(days=365)
    late_days = {
        clock.london(d).date()
        for d in conn.execute(
            select(task.c.due_at).where(
                task.c.due_at >= clock.start_of_day(since),
                task.c.due_at <= clock.now(),
                or_(
                    and_(task.c.owner_id == pr.person_id, task.c.status.in_(("overdue", "missed"))),
                    and_(task.c.completed_by == pr.person_id, task.c.completed_at > task.c.due_at),
                ),
            )
        ).scalars()
    }
    first_day = conn.execute(
        select(func.min(task.c.due_at)).where(or_(task.c.owner_id == pr.person_id, task.c.completed_by == pr.person_id))
    ).scalar()
    start = max(since, clock.london(first_day).date()) if first_day else t0
    days = 0
    d = t0
    while d >= start and d not in late_days:
        days += 1
        d -= timedelta(days=1)
    dev = (
        conn.execute(select(device.c.trusted_until, device.c.label).where(device.c.id == pr.device_id)).first()
        if pr.device_id
        else None
    )
    p = conn.execute(select(person.c.title, person.c.preferences).where(person.c.id == pr.person_id)).one()
    # Leave now or coming up, and who covers it (Dialogs › Cover Pamela's checks): the person sees it on their phone.
    away = (
        conn.execute(
            select(leave.c.starts_on, leave.c.ends_on, leave.c.approved_by, person.c.name.label("cover"))
            .outerjoin(person, person.c.id == leave.c.cover_id)
            .where(leave.c.person_id == pr.person_id, leave.c.ends_on >= t0, leave.c.ended_at.is_(None))
            .order_by(leave.c.starts_on)
            .limit(1)
        )
        .mappings()
        .first()
    )
    # And anyone they're covering for at the moment.
    covering = [
        r.name
        for r in conn.execute(
            select(person.c.name)
            .join(leave, leave.c.person_id == person.c.id)
            .where(
                leave.c.cover_id == pr.person_id,
                leave.c.approved_by.isnot(None),
                leave.c.starts_on <= t0 + timedelta(days=14),
                leave.c.ends_on >= t0,
                leave.c.ended_at.is_(None),
            )
        )
    ]
    return {
        "name": pr.name,
        "title": p.title,
        "month": {"on_time": wk["on_time"], "done": done, "problems": problems},
        "streak_days": days,
        "trusted_until": dev.trusted_until if dev else None,
        "preferences": p.preferences or {},
        "away": {
            "starts_on": away["starts_on"],
            "ends_on": away["ends_on"],
            "cover": away["cover"],
            "approved": away["approved_by"] is not None,
        }
        if away
        else None,
        "covering": covering,
    }
