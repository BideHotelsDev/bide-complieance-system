"""Notifications and the escalation ladder (PRD §7).

The ladder is data: one escalation_rule row per trigger, per property or for all properties (CMS-08). An escalation
is recorded once per (trigger, subject) and stays open until a manager acknowledges it with a note. Each recipient
gets an in-app notification; Slack, email and push are delivered by the worker. Class B and C pushes are held during
quiet hours; Class A never is, and can't be muted.

Named individual failures go by DM to the person and their manager, never to shared channels (SLK-01).
"""

import uuid
from datetime import datetime, time, timedelta

from sqlalchemy import Connection, select
from sqlalchemy.dialects.postgresql import insert as pg_insert

from bide_comply import clock
from bide_comply.schema import (
    dutyholder_director,
    escalation,
    escalation_rule,
    notification,
    pool_member,
    property_,
    register_item,
    role_assignment,
)
from bide_comply.services.register import get_setting

TRIGGERS = {
    "amber": "When a check is due soon (Amber)",
    "red_day1": "When it goes overdue (Red, day 1)",
    "red_7days": "Still overdue after 7 days, or any Class A item overdue",
    "class_a_failure": "Class A failure",
    "failed_check": "Failed check or reading out of range",
    "missed": "A time-bound check closes as Missed",
    "high_action_7days": "Urgent Action open more than 7 days",
    "certificate_window": "Certificate in its 60-day window",
    "alarm_events": "Three alarm events with the same cause",
}

DEFAULT_RULES = {
    "amber": {
        "recipients": [{"kind": "doer"}, {"kind": "cover"}],
        "channels": ["app", "push", "slack_dm"],
        "timing": {
            "note": "3 days before weekly and monthly checks · 14 days for quarterly · 60 days for certificates"
        },
    },
    "red_day1": {
        "recipients": [{"kind": "site_lead"}, {"kind": "role", "role": "system_owner"}],
        "channels": ["app", "slack_channel"],
        "timing": {"note": "Same-day mention, then listed in the Monday 08:30 digest"},
    },
    "red_7days": {
        "recipients": [{"kind": "role", "role": "super_admin"}, {"kind": "dutyholders"}],
        "channels": ["app", "slack_dm", "email"],
        "timing": {"days": 7, "note": "Also added as an Issue on the Monday L10"},
    },
    "class_a_failure": {
        "recipients": [
            {"kind": "role", "role": "super_admin"},
            {"kind": "role", "role": "system_owner"},
            {"kind": "role", "role": "assessor"},
        ],
        "channels": ["app", "slack_dm", "email", "phone"],
        "timing": {"note": "Straight away, any time of day. Cannot be muted or held overnight."},
    },
    "failed_check": {
        "recipients": [{"kind": "site_lead"}, {"kind": "role", "role": "system_owner"}],
        "channels": ["app", "slack_dm"],
        "timing": {},
    },
    "missed": {
        "recipients": [{"kind": "site_lead"}, {"kind": "role", "role": "system_owner"}],
        "channels": ["app", "slack_dm"],
        "timing": {"note": "The reason must be approved"},
    },
    "high_action_7days": {
        "recipients": [{"kind": "role", "role": "system_owner"}, {"kind": "role", "role": "super_admin"}],
        "channels": ["app", "slack_dm"],
        "timing": {"days": 7},
    },
    "certificate_window": {
        "recipients": [{"kind": "role", "role": "register_keeper"}],
        "channels": ["app", "slack_dm"],
        "timing": {"steps": [60, 30, 14, 7]},
    },
    "alarm_events": {
        "recipients": [{"kind": "role", "role": "register_keeper"}, {"kind": "role", "role": "system_owner"}],
        "channels": ["app", "slack_dm"],
        "timing": {"count": 3},
    },
}


def rule(conn: Connection, trigger: str, property_id: uuid.UUID | None) -> dict:
    rows = (
        conn.execute(
            select(escalation_rule).where(
                escalation_rule.c.trigger == trigger,
                (escalation_rule.c.property_id == property_id) | escalation_rule.c.property_id.is_(None),
            )
        )
        .mappings()
        .all()
    )
    # A property's own rule wins over the all-properties one.
    rows = sorted(rows, key=lambda r: r["property_id"] is None)
    if rows:
        return dict(rows[0])
    d = DEFAULT_RULES[trigger]
    return {"trigger": trigger, "property_id": None, "mutable": trigger != "class_a_failure", **d}


def _role_people(conn: Connection, role: str, property_id: uuid.UUID | None) -> set[uuid.UUID]:
    q = select(role_assignment.c.person_id).where(role_assignment.c.role == role)
    if property_id:
        q = q.where((role_assignment.c.property_id == property_id) | role_assignment.c.property_id.is_(None))
    return set(conn.execute(q).scalars())


def resolve(
    conn: Connection,
    recipients: list[dict],
    property_id: uuid.UUID | None,
    item: dict | None = None,
    extra: dict | None = None,
) -> set[uuid.UUID]:
    out: set[uuid.UUID] = set()
    for r in recipients:
        k = r.get("kind")
        if k == "person" and r.get("id"):
            out.add(uuid.UUID(str(r["id"])))
        elif k == "role":
            out |= _role_people(conn, r["role"], property_id)
        elif k == "site_lead":
            out |= _role_people(conn, "site_lead", property_id) - _role_people(conn, "super_admin", None)
            if not out and property_id:
                out |= _role_people(conn, "system_owner", None)
        elif k == "dutyholders" and property_id:
            out |= set(
                conn.execute(
                    select(dutyholder_director.c.person_id)
                    .join(property_, property_.c.dutyholder_id == dutyholder_director.c.dutyholder_id)
                    .where(property_.c.id == property_id)
                ).scalars()
            )
        elif k == "doer" and item:
            if item.get("done_by_kind") == "person" and item.get("done_by_person_id"):
                out.add(item["done_by_person_id"])
            elif item.get("done_by_kind") == "pool" and item.get("done_by_pool_id"):
                out |= set(
                    conn.execute(
                        select(pool_member.c.person_id).where(pool_member.c.pool_id == item["done_by_pool_id"])
                    ).scalars()
                )
            elif item.get("accountable_id"):
                out.add(item["accountable_id"])
        elif k == "cover" and item and item.get("cover_id"):
            out.add(item["cover_id"])
        elif k == "accountable" and item and item.get("accountable_id"):
            out.add(item["accountable_id"])
        elif k == "owner" and extra and extra.get("owner_id"):
            out.add(extra["owner_id"])
    return out


def _held_until(conn: Connection, klass: str | None) -> datetime | None:
    if klass == "A":
        return None
    q = get_setting(conn, "quiet_hours", {"enabled": True, "from": "21:00", "until": "07:00"})
    if not q.get("enabled"):
        return None
    now = clock.london(clock.now())
    start, end = clock.parse_hhmm(q["from"]), clock.parse_hhmm(q["until"])
    t = now.time()
    in_quiet = (t >= start or t < end) if start > end else (start <= t < end)
    if not in_quiet:
        return None
    day = now.date() if t < end else now.date() + timedelta(days=1)
    return clock.at_london(day, time(end.hour, end.minute))


def notify(
    conn: Connection,
    people: set[uuid.UUID],
    *,
    kind: str,
    title: str,
    body: str | None = None,
    link: str | None = None,
    klass: str | None = None,
    channels: list[str] | None = None,
    escalation_id: uuid.UUID | None = None,
) -> None:
    channels = channels or ["app"]
    hold = _held_until(conn, klass)
    for pid in people:
        conn.execute(
            notification.insert().values(
                id=uuid.uuid4(),
                person_id=pid,
                kind=kind,
                title=title,
                body=body,
                link=link,
                **{"class": klass},
                channels=channels,
                hold_until=hold,
                escalation_id=escalation_id,
            )
        )


def escalate(
    conn: Connection,
    trigger: str,
    *,
    property_id: uuid.UUID | None,
    summary: str,
    dedupe_key: str,
    klass: str | None = None,
    register_item_id: uuid.UUID | None = None,
    task_id: uuid.UUID | None = None,
    action_id: uuid.UUID | None = None,
    link: str | None = None,
    level: int = 1,
    extra: dict | None = None,
) -> uuid.UUID | None:
    """Record an escalation once and tell its recipients. Returns None if it was already raised."""
    r = rule(conn, trigger, property_id)
    item = None
    if register_item_id:
        item = dict(conn.execute(select(register_item).where(register_item.c.id == register_item_id)).mappings().one())
    people = resolve(conn, r["recipients"], property_id, item, extra)
    eid = uuid.uuid4()
    inserted = conn.execute(
        pg_insert(escalation)
        .values(
            id=eid,
            trigger=trigger,
            property_id=property_id,
            register_item_id=register_item_id,
            task_id=task_id,
            action_id=action_id,
            level=level,
            summary=summary,
            dedupe_key=dedupe_key,
            recipients=[str(p) for p in people],
        )
        .on_conflict_do_nothing(index_elements=["dedupe_key"])
        .returning(escalation.c.id)
    ).scalar()
    # Already raised for this subject: say nothing again (rowcount isn't reliable here; RETURNING is).
    if inserted is None:
        return None
    notify(
        conn,
        people,
        kind=f"escalation.{trigger}",
        title=summary,
        link=link,
        klass=klass,
        channels=list(r["channels"]),
        escalation_id=eid,
    )
    return eid
