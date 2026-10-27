"""Keeping register items current: tasks generated in the horizon, task statuses moved with the clock, and each
item's last done, next due and RAG status recomputed from its tasks, certificates and open Actions.
"""

import random
import uuid
from datetime import date, timedelta

from sqlalchemy import Connection, and_, func, or_, select, update

from bide_comply import clock
from bide_comply.config import settings
from bide_comply.engine import frequency as freq
from bide_comply.engine import schedule
from bide_comply.engine.status import ItemFacts, ScoreInput, item_status, property_score
from bide_comply.schema import (
    action,
    certificate,
    class_weight,
    leave,
    register_item,
    setting,
    signature_request,
    submission,
    submission_evidence,
    task,
    template,
    template_version,
    warning_window,
)

ACTIVE_TASK = ("scheduled", "open", "overdue")
DONE_TASK = ("passed", "verified", "failed", "submitted")


def weights(conn: Connection) -> dict[str, int]:
    return {r.key: r.weight for r in conn.execute(select(class_weight))}


def windows(conn: Connection) -> dict[str, int]:
    return {r.frequency: r.days for r in conn.execute(select(warning_window))}


def get_setting(conn: Connection, key: str, default=None):
    v = conn.execute(select(setting.c.value).where(setting.c.key == key)).scalar()
    return default if v is None else v


def _plan(item: dict, tpl: dict, expires_on: date | None) -> schedule.Plan:
    return schedule.Plan(
        frequency=item["frequency"] or tpl["default_frequency"],
        kind=tpl["kind"],
        due_time=clock.parse_hhmm(item["due_time"] or tpl["due_time"]),
        late_rule=tpl["late_rule"],
        window_hours=tpl["window_hours"],
        anchor_date=item["anchor_date"],
        last_done_on=item["last_done_on"],
        expires_on=expires_on,
        lead_days=tpl["lead_days"],
        rrule=item["rrule"] or tpl["rrule"],
    )


def _current_certificate(conn: Connection, item_id: uuid.UUID) -> dict | None:
    row = (
        conn.execute(
            select(certificate)
            .where(
                certificate.c.register_item_id == item_id,
                certificate.c.filing == "filed",
                certificate.c.superseded_by.is_(None),
            )
            .order_by(certificate.c.expires_on.desc().nulls_last())
            .limit(1)
        )
        .mappings()
        .first()
    )
    return dict(row) if row else None


def _owner_now(conn: Connection, item: dict, on: date) -> uuid.UUID | None:
    """Accountable person, or their approved cover while they're on leave (SCH-07, SCH-13)."""
    acc = item["accountable_id"]
    if not acc:
        return None
    lv = conn.execute(
        select(leave.c.cover_id).where(
            leave.c.person_id == acc,
            leave.c.starts_on <= on,
            leave.c.ends_on >= on,
            leave.c.approved_by.isnot(None),
            leave.c.ended_at.is_(None),
        )
    ).first()
    return lv.cover_id if lv and lv.cover_id else acc


def generate_tasks(conn: Connection, item_id: uuid.UUID, today: date | None = None) -> int:
    """Insert the occurrences this item should have and doesn't. Returns how many were added."""
    today = today or clock.today()
    item = dict(conn.execute(select(register_item).where(register_item.c.id == item_id)).mappings().one())
    if item["state"] != "on":
        return 0
    tpl = dict(conn.execute(select(template).where(template.c.id == item["template_id"])).mappings().one())
    ver_id = conn.execute(
        select(template_version.c.id).where(
            template_version.c.template_id == tpl["id"], template_version.c.version == tpl["current_version"]
        )
    ).scalar_one()
    cert = _current_certificate(conn, item_id) if tpl["kind"] == "certificate" else None
    plan = _plan(
        item, tpl, cert["expires_on"] if cert else item["next_due_on"] if tpl["kind"] == "certificate" else None
    )
    f = freq.get(plan.frequency)

    if f.mode == "calendar":
        # From when the item went live, looking back at most five weeks so a long gap shows as overdue weeks
        # without flooding anyone's list.
        activated = clock.london(item["created_at"]).date() if item["created_at"] else today
        start = max(activated, today - timedelta(days=35))
    else:
        start = today
    occs = schedule.occurrences(plan, start, today + timedelta(days=settings.schedule_horizon_days))
    if f.mode in ("rolling", "expiry") and plan.frequency != "custom":
        # One open task at a time: only add it if there isn't an unfinished one already.
        open_ = conn.execute(
            select(task.c.id).where(task.c.register_item_id == item_id, task.c.status.in_(ACTIVE_TASK))
        ).first()
        if open_:
            return 0
    existing = set(conn.execute(select(task.c.period_key).where(task.c.register_item_id == item_id)).scalars())
    now = clock.now()
    added = 0
    for o in occs:
        if o.period_key in existing:
            continue
        status = schedule.time_status("scheduled", now, o.window_opens_at, o.due_at, o.window_closes_at, plan.late_rule)
        conn.execute(
            task.insert().values(
                id=uuid.uuid4(),
                register_item_id=item_id,
                template_version_id=ver_id,
                period_key=o.period_key,
                due_at=o.due_at,
                window_opens_at=o.window_opens_at,
                window_closes_at=o.window_closes_at,
                status=status,
                owner_id=_owner_now(conn, item, clock.london(o.due_at).date()),
                doer_kind=item["done_by_kind"],
                doer_id=item["done_by_person_id"] or item["done_by_pool_id"] or item["done_by_contractor_id"],
                needs_verification=tpl["verification"] == "always",
                spot_check=tpl["verification"] == "sample" and random.randrange(max(tpl["sample_rate"], 1)) == 0,
            )
        )
        added += 1
    return added


def cancel_future(conn: Connection, item_id: uuid.UUID) -> None:
    """When a plan changes or is switched off: future tasks nobody has touched are cancelled, past ones kept."""
    conn.execute(
        update(task)
        .where(task.c.register_item_id == item_id, task.c.status == "scheduled", task.c.window_opens_at > clock.now())
        .values(status="cancelled")
    )


def advance_tasks(conn: Connection, item_id: uuid.UUID | None = None) -> list[dict]:
    """Move open tasks along with the clock. Returns the tasks that changed status, for escalation."""
    now = clock.now()
    q = (
        select(
            task.c.id,
            task.c.status,
            task.c.window_opens_at,
            task.c.due_at,
            task.c.window_closes_at,
            task.c.register_item_id,
            template.c.late_rule,
        )
        .join(register_item, register_item.c.id == task.c.register_item_id)
        .join(template, template.c.id == register_item.c.template_id)
        .where(task.c.status.in_(ACTIVE_TASK))
    )
    if item_id:
        q = q.where(task.c.register_item_id == item_id)
    changed = []
    for t in conn.execute(q).mappings():
        new = schedule.time_status(
            t["status"], now, t["window_opens_at"], t["due_at"], t["window_closes_at"], t["late_rule"]
        )
        if new != t["status"]:
            conn.execute(update(task).where(task.c.id == t["id"]).values(status=new))
            changed.append({**t, "old": t["status"], "status": new})
    return changed


def recompute_item(conn: Connection, item_id: uuid.UUID, today: date | None = None) -> dict:
    """Recalculate last done, next due and RAG status, and save them on the register row."""
    today = today or clock.today()
    item = dict(conn.execute(select(register_item).where(register_item.c.id == item_id)).mappings().one())
    tpl = dict(conn.execute(select(template).where(template.c.id == item["template_id"])).mappings().one())
    frequency = item["frequency"] or tpl["default_frequency"]
    f = freq.get(frequency)
    mode = "expiry" if tpl["kind"] == "certificate" and f.mode != "calendar" else f.mode

    last_done = item["last_done_on"]
    last_sub = conn.execute(
        select(func.max(submission.c.work_done_on))
        .select_from(submission.join(task, task.c.id == submission.c.task_id))
        .where(task.c.register_item_id == item_id, task.c.status.in_(("passed", "verified", "failed", "submitted")))
    ).scalar()
    if last_sub and (last_done is None or last_sub > last_done):
        last_done = last_sub

    cert = _current_certificate(conn, item_id) if tpl["kind"] == "certificate" else None
    if cert and cert["issued_on"] and (last_done is None or cert["issued_on"] > last_done):
        last_done = cert["issued_on"]

    plan = _plan({**item, "last_done_on": last_done}, tpl, cert["expires_on"] if cert else None)
    if mode == "calendar":
        nxt = conn.execute(
            select(task.c.due_at)
            .where(task.c.register_item_id == item_id, task.c.status.in_(ACTIVE_TASK))
            .order_by(task.c.due_at)
            .limit(1)
        ).scalar()
        next_due = clock.london(nxt).date() if nxt else schedule.next_due(plan, today)
    elif mode == "expiry":
        next_due = cert["expires_on"] if cert else item["next_due_on"]
    else:
        next_due = schedule.next_due(plan, today)

    latest_due = conn.execute(
        select(task.c.id, task.c.status)
        .where(
            task.c.register_item_id == item_id, task.c.due_at <= clock.now(), task.c.status.notin_(("cancelled", "na"))
        )
        .order_by(task.c.due_at.desc())
        .limit(1)
    ).first()
    has_ev = True
    if latest_due and latest_due.status in DONE_TASK:
        has_ev = bool(
            conn.execute(
                select(func.count())
                .select_from(
                    submission_evidence.join(submission, submission.c.id == submission_evidence.c.submission_id)
                )
                .where(submission.c.task_id == latest_due.id)
            ).scalar()
        )
    current_done = bool(
        conn.execute(
            select(task.c.id).where(
                task.c.register_item_id == item_id,
                task.c.status.in_(("passed", "verified", "submitted")),
                task.c.window_opens_at <= clock.now(),
                task.c.due_at >= clock.now(),
            )
        ).first()
    )
    open_fails = conn.execute(
        select(func.count()).where(
            action.c.register_item_id == item_id, action.c.status != "closed", action.c.type != "advisory"
        )
    ).scalar()
    unsigned = bool(
        conn.execute(
            select(signature_request.c.id).where(
                signature_request.c.register_item_id == item_id, signature_request.c.status == "open"
            )
        ).first()
    )
    wd = freq.warning_days(frequency, tpl["kind"], tpl["warning_days"], windows(conn))
    state = item["state"]
    if state == "on" and item["paused_until"] and item["paused_until"] >= today:
        state = "paused"
    st = item_status(
        ItemFacts(
            klass=tpl["class"],
            state=state,
            next_due_on=next_due,
            last_done_on=last_done,
            warning_days=wd,
            mode=mode,
            latest_due_task_status=latest_due.status if latest_due else None,
            latest_due_task_has_evidence=has_ev,
            open_fail_actions=open_fails,
            unsigned=unsigned,
            current_task_done=current_done,
        ),
        today,
    )
    if state == "draft":
        st.status, st.reason = "red", "not activated"
    vals = {"last_done_on": last_done, "next_due_on": next_due, "status": st.status, "status_reason": st.reason}
    conn.execute(update(register_item).where(register_item.c.id == item_id).values(**vals))
    return {**item, **vals}


def refresh_item(conn: Connection, item_id: uuid.UUID) -> dict:
    generate_tasks(conn, item_id)
    advance_tasks(conn, item_id)
    return recompute_item(conn, item_id)


def refresh_property(conn: Connection, property_id: uuid.UUID | None = None) -> None:
    q = select(register_item.c.id).where(register_item.c.state != "draft")
    if property_id:
        q = q.where(register_item.c.property_id == property_id)
    for iid in conn.execute(q).scalars().all():
        refresh_item(conn, iid)


def scores(conn: Connection, property_ids: list[uuid.UUID] | None = None) -> dict[uuid.UUID, object]:
    """Weighted score per property (§4.2)."""
    q = (
        select(register_item.c.property_id, template.c["class"], register_item.c.status)
        .join(template, template.c.id == register_item.c.template_id)
        .where(register_item.c.state != "draft")
    )
    if property_ids is not None:
        q = q.where(register_item.c.property_id.in_(property_ids))
    by: dict[uuid.UUID, list[ScoreInput]] = {}
    for r in conn.execute(q):
        by.setdefault(r.property_id, []).append(ScoreInput(r[1], r.status))
    w = weights(conn)
    return {pid: property_score(items, w) for pid, items in by.items()}


def items_due_filter(today: date, days: int):
    return and_(
        register_item.c.next_due_on.isnot(None),
        register_item.c.next_due_on <= today + timedelta(days=days),
        register_item.c.next_due_on >= today,
    )


def overdue_filter():
    return or_(register_item.c.status == "red")
