"""The escalation ladder, run by the worker every few minutes (§7). Each rung fires once per subject (dedupe keys),
so a rerun never repeats an alert.
"""

from datetime import timedelta

from sqlalchemy import Connection, select

from bide_comply import clock
from bide_comply.schema import action, certificate, property_, register_item, task, template
from bide_comply.services import notify
from bide_comply.services.common import fmt_date
from bide_comply.services.register import get_setting


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
                template.c.name,
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
    for it in items:
        due = it["next_due_on"]
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
                )
            )
            if it["klass"] == "A" or (due and due <= today - timedelta(days=7)):
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
                            else f"{it['name']} at {it['property']} has been overdue for 7 days ({it['ref']})."
                        ),
                        dedupe_key=f"red7:{it['id']}:{key}",
                        link=f"/properties/{it['ref'][:2]}?item={it['ref']}",
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
            property_.c.name.label("property"),
        )
        .join(property_, property_.c.id == action.c.property_id)
        .where(action.c.status != "closed", action.c.priority == "high", action.c.raised_on < today - timedelta(days=7))
    ).mappings():
        fired += bool(
            notify.escalate(
                conn,
                "high_action_7days",
                property_id=a["property_id"],
                action_id=a["id"],
                extra={"owner_id": a["owner_id"]},
                summary=f"Urgent Action {a['ref']} at {a['property']} has been open more than 7 days.",
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
            )
        )
    return fired
