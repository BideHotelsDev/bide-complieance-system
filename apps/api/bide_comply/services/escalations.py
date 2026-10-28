"""The escalation ladder, run by the worker every few minutes (§7). Each rung fires once per subject (dedupe keys),
so a rerun never repeats an alert.
"""

from datetime import timedelta

from sqlalchemy import Connection, select

from bide_comply import clock
from bide_comply.schema import action, certificate, person, property_, register_item, role_assignment, task, template
from bide_comply.services import notify, wording
from bide_comply.services.common import fmt_date, fmt_day
from bide_comply.services.register import get_setting


def _days(rule: dict, default: int) -> int:
    """The "after N days" set on the rule in Settings › Alert rules (CMS-08)."""
    try:
        return max(1, int((rule.get("timing") or {}).get("days", default)))
    except (TypeError, ValueError):
        return default


def _first(name: str | None) -> str | None:
    return name.split()[0].strip("[") if name and not name.startswith("[") else name


def _site_lead(conn: Connection, property_id, cache: dict) -> str:
    if property_id not in cache:
        n = conn.execute(
            select(person.c.name)
            .join(role_assignment, role_assignment.c.person_id == person.c.id)
            .where(role_assignment.c.role == "site_lead", role_assignment.c.property_id == property_id)
            .order_by(person.c.name)
            .limit(1)
        ).scalar()
        cache[property_id] = n or "the site lead"
    return cache[property_id]


def _check_values(conn: Connection, it, today, leads: dict) -> dict:
    due = it["next_due_on"]
    late = (today - due).days if due and due < today else 0
    doer = conn.execute(select(person.c.name).where(person.c.id == it["done_by_person_id"])).scalar()
    return {
        "check": it["name"],
        "property": it["property"],
        "due_date": fmt_day(due) if due else "",
        "days_overdue": f"{late} day{'' if late == 1 else 's'}" if late else "",
        "person": _first(doer) if doer else "",
        "site_lead": _site_lead(conn, it["property_id"], leads),
        "class": it["klass"],
        "typical_time": f"{it['typical_minutes']} minutes" if it["typical_minutes"] else "a few minutes",
    }


def run(conn: Connection) -> int:
    today = clock.today()
    fired = 0
    items = (
        conn.execute(
            select(
                register_item.c.id,
                register_item.c.ref,
                register_item.c.property_id,
                register_item.c.status,
                register_item.c.next_due_on,
                register_item.c.status_reason,
                register_item.c.done_by_person_id,
                template.c.name,
                template.c.typical_minutes,
                template.c["class"].label("klass"),
                property_.c.name.label("property"),
            )
            .join(template, template.c.id == register_item.c.template_id)
            .join(property_, property_.c.id == register_item.c.property_id)
            .where(register_item.c.state == "on")
        )
        .mappings()
        .all()
    )
    rules_cache: dict = {}
    leads: dict = {}

    def rule(trigger: str, property_id) -> dict:
        if (trigger, property_id) not in rules_cache:
            rules_cache[(trigger, property_id)] = notify.rule(conn, trigger, property_id)
        return rules_cache[(trigger, property_id)]

    for it in items:
        due = it["next_due_on"]
        if it["status"] in ("amber", "red"):
            values = _check_values(conn, it, today, leads)
        if it["status"] == "amber":
            fired += bool(
                notify.escalate(
                    conn,
                    "amber",
                    property_id=it["property_id"],
                    klass=it["klass"],
                    register_item_id=it["id"],
                    summary=f"{it['name']} at {it['property']} is due {fmt_date(due)}.",
                    dedupe_key=f"amber:{it['id']}:{due}",
                    link=f"/properties/{it['ref'][:2]}?item={it['ref']}",
                    message=wording.message(conn, "check_due_soon", values),
                )
            )
        if it["status"] == "red" and it["status_reason"] in (
            "overdue",
            "missed",
            "no record",
            "no evidence",
            "unsigned",
        ):
            key = due.isoformat() if due else it["status_reason"]
            fired += bool(
                notify.escalate(
                    conn,
                    "red_day1",
                    property_id=it["property_id"],
                    klass=it["klass"],
                    register_item_id=it["id"],
                    summary=f"{it['name']} at {it['property']} is overdue ({it['ref']}).",
                    dedupe_key=f"red1:{it['id']}:{key}",
                    link=f"/properties/{it['ref'][:2]}?item={it['ref']}",
                    message=wording.message(conn, "check_overdue", values),
                )
            )
            after = _days(rule("red_7days", it["property_id"]), 7)
            if it["klass"] == "A" or (due and due <= today - timedelta(days=after)):
                fired += bool(
                    notify.escalate(
                        conn,
                        "red_7days",
                        property_id=it["property_id"],
                        klass=it["klass"],
                        register_item_id=it["id"],
                        level=2,
                        summary=(
                            f"Class A at {it['property']}: {it['name']} is overdue ({it['ref']})."
                            if it["klass"] == "A"
                            else f"{it['name']} at {it['property']} has been overdue for {after} days ({it['ref']})."
                        ),
                        dedupe_key=f"red7:{it['id']}:{key}",
                        link=f"/properties/{it['ref'][:2]}?item={it['ref']}",
                        message=wording.message(conn, "check_overdue", values),
                    )
                )
    for t in conn.execute(
        select(
            task.c.id,
            register_item.c.id.label("item"),
            register_item.c.ref,
            register_item.c.property_id,
            template.c.name,
            template.c["class"].label("klass"),
            property_.c.name.label("property"),
        )
        .join(register_item, register_item.c.id == task.c.register_item_id)
        .join(template, template.c.id == register_item.c.template_id)
        .join(property_, property_.c.id == register_item.c.property_id)
        .where(
            task.c.status == "missed",
            task.c.missed_reason_id.is_(None),
            task.c.due_at >= clock.start_of_day(today - timedelta(days=14)),
        )
    ).mappings():
        fired += bool(
            notify.escalate(
                conn,
                "missed",
                property_id=t["property_id"],
                klass=t["klass"],
                register_item_id=t["item"],
                task_id=t["id"],
                summary=f"{t['name']} at {t['property']} closed as Missed. Give the reason so it can be approved.",
                dedupe_key=f"missed:{t['id']}",
                link="/approvals?tab=missed",
            )
        )
    for a in conn.execute(
        select(
            action.c.id,
            action.c.ref,
            action.c.property_id,
            action.c.description,
            action.c.owner_id,
            action.c.raised_on,
            property_.c.name.label("property"),
        )
        .join(property_, property_.c.id == action.c.property_id)
        .where(action.c.status != "closed", action.c.priority == "high", action.c.raised_on < today - timedelta(days=1))
    ).mappings():
        after = _days(rule("high_action_7days", a["property_id"]), 7)
        if a["raised_on"] >= today - timedelta(days=after):
            continue
        fired += bool(
            notify.escalate(
                conn,
                "high_action_7days",
                property_id=a["property_id"],
                action_id=a["id"],
                extra={"owner_id": a["owner_id"]},
                summary=f"Urgent Action {a['ref']} at {a['property']} has been open more than {after} days.",
                dedupe_key=f"high7:{a['id']}",
                link=f"/actions?sel={a['ref']}",
            )
        )
    steps = get_setting(conn, "expiry_steps", [60, 30, 14, 7])
    for c in conn.execute(
        select(
            certificate.c.id,
            certificate.c.title,
            certificate.c.expires_on,
            certificate.c.property_id,
            certificate.c.provider_text,
            property_.c.name.label("property"),
        )
        .join(property_, property_.c.id == certificate.c.property_id)
        .where(
            certificate.c.filing == "filed", certificate.c.superseded_by.is_(None), certificate.c.expires_on.isnot(None)
        )
    ).mappings():
        left = (c["expires_on"] - today).days
        step = next((s for s in sorted(steps) if left <= s), None)
        if left < 0:
            key = f"cert:{c['id']}:expired:{today}"  # daily once expired (DOC-02)
        elif step is not None:
            key = f"cert:{c['id']}:{step}"
        else:
            continue
        fired += bool(
            notify.escalate(
                conn,
                "certificate_window",
                property_id=c["property_id"],
                klass="B",
                summary=(
                    f"{c['title']} at {c['property']} expired on {fmt_date(c['expires_on'], True)}."
                    if left < 0
                    else f"{c['title']} at {c['property']} expires on {fmt_date(c['expires_on'], True)} ({left} days). Book the contractor now."
                ),
                dedupe_key=key,
                link=f"/certificates?sel={c['id']}",
                message=None
                if left < 0
                else wording.message(
                    conn,
                    "certificate_expiring",
                    {
                        "certificate": c["title"],
                        "property": c["property"],
                        "expiry_date": fmt_date(c["expires_on"], True),
                        "days_left": f"{left} days",
                        "contractor": c["provider_text"] or "the contractor",
                    },
                ),
            )
        )
    return fired
