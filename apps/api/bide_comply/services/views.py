"""Read models for the dashboards: one property's headline numbers, the group overview (DSH-01, DSH-02, DSH-04) and
"what needs me" (My to-do). Every number here drills down to the records behind it (DSH-06).
"""

import uuid
from datetime import date, timedelta

from sqlalchemy import Connection, and_, func, or_, select

from bide_comply import clock
from bide_comply.authz import Principal, scope_filter
from bide_comply.engine import gate as gate_rules
from bide_comply.engine import kpi
from bide_comply.schema import (
    action,
    approval_request,
    certificate,
    contractor,
    contractor_visit,
    domain,
    dutyholder,
    escalation,
    gate,
    gate_item,
    gate_item_evidence,
    property_,
    register_item,
    signature_request,
    submission,
    task,
    template,
    verification,
)
from bide_comply.services.common import fmt_date, fmt_day
from bide_comply.services.register import scores

STAGE_LABEL = {"trading": "Trading", "pre_opening": "Opening soon", "setup": "Not set up yet", "closed": "Closed"}


def visible_properties(conn: Connection, pr: Principal, only: uuid.UUID | None = None) -> list[dict]:
    q = (
        select(property_, dutyholder.c.name.label("dutyholder_name"))
        .outerjoin(dutyholder, dutyholder.c.id == property_.c.dutyholder_id)
        .where(property_.c.active.is_(True), scope_filter(pr, property_.c.id))
        .order_by(property_.c.sort)
    )
    if only:
        q = q.where(property_.c.id == only)
    return [dict(r) for r in conn.execute(q).mappings()]


def gate_summary(conn: Connection, property_id: uuid.UUID, trading: bool) -> gate_rules.GateSummary | None:
    gid = conn.execute(select(gate.c.id).where(gate.c.property_id == property_id)).scalar()
    if not gid:
        return None
    ev_items = set(
        conn.execute(
            select(gate_item_evidence.c.gate_item_id)
            .join(gate_item, gate_item.c.id == gate_item_evidence.c.gate_item_id)
            .where(gate_item.c.gate_id == gid)
        ).scalars()
    )
    facts = [
        gate_rules.GateItemFacts(r.ref, r.section, r[2], r.applies, r.status, bool(r.evidence_link) or r.id in ev_items)
        for r in conn.execute(
            select(
                gate_item.c.ref,
                gate_item.c.section,
                gate_item.c["class"],
                gate_item.c.applies,
                gate_item.c.status,
                gate_item.c.evidence_link,
                gate_item.c.id,
            ).where(gate_item.c.gate_id == gid)
        )
    ]
    return gate_rules.summarise(facts, trading)


def last_alarm_test(conn: Connection, property_id: uuid.UUID) -> date | None:
    return conn.execute(
        select(func.max(submission.c.work_done_on))
        .select_from(
            submission.join(task, task.c.id == submission.c.task_id)
            .join(register_item, register_item.c.id == task.c.register_item_id)
            .join(template, template.c.id == register_item.c.template_id)
        )
        .where(register_item.c.property_id == property_id, template.c.name.ilike("Fire alarm test%"))
    ).scalar()


def property_summary(conn: Connection, p: dict, score=None, today: date | None = None) -> dict:
    today = today or clock.today()
    pid = p["id"]
    score = score if score is not None else scores(conn, [pid]).get(pid)
    counts = dict(
        conn.execute(
            select(register_item.c.status, func.count())
            .where(register_item.c.property_id == pid, register_item.c.state != "draft")
            .group_by(register_item.c.status)
        ).all()
    )
    a_late = conn.execute(
        select(func.count())
        .select_from(register_item.join(template, template.c.id == register_item.c.template_id))
        .where(
            register_item.c.property_id == pid,
            register_item.c.status == "red",
            template.c["class"] == "A",
            register_item.c.state != "draft",
        )
    ).scalar()
    acts = conn.execute(
        select(action.c.priority, action.c.due_on).where(action.c.property_id == pid, action.c.status != "closed")
    ).all()
    trading = p["stage"] == "trading"
    gs = gate_summary(conn, pid, trading)
    due14 = conn.execute(
        select(func.count()).where(
            register_item.c.property_id == pid,
            register_item.c.state == "on",
            register_item.c.next_due_on >= today,
            register_item.c.next_due_on <= today + timedelta(days=14),
        )
    ).scalar()
    certs60 = conn.execute(
        select(func.count()).where(
            certificate.c.property_id == pid,
            certificate.c.filing == "filed",
            certificate.c.superseded_by.is_(None),
            certificate.c.expires_on >= today,
            certificate.c.expires_on <= today + timedelta(days=60),
        )
    ).scalar()
    last_alarm = last_alarm_test(conn, pid)
    nxt = conn.execute(
        select(contractor_visit.c.visit_on, contractor_visit.c.purpose, contractor.c.name)
        .join(contractor, contractor.c.id == contractor_visit.c.contractor_id)
        .where(
            contractor_visit.c.property_id == pid,
            contractor_visit.c.visit_on >= today,
            contractor_visit.c.status == "booked",
        )
        .order_by(contractor_visit.c.visit_on)
        .limit(1)
    ).first()
    loaded = sum(counts.values()) > 0
    if not loaded and p["stage"] == "setup":
        note = p["stage_note"] or "Not set up yet"
    elif not loaded and trading:
        note = "Trading (interim) · no compliance pack found" if p["stage_note"] == "interim" else "Register not loaded"
    elif p["stage"] == "pre_opening":
        feats = p["features"] or {}
        note = (
            "Oil-fired heating: OFTEC service instead of CP12"
            if feats.get("has_oil")
            else (f"Opens {p['opening_date']:%b %Y}" if p["opening_date"] else "Opening soon")
        )
    else:
        since = f"Trading since {fmt_date(p['trading_since'])}" if p["trading_since"] else "Trading"
        if nxt:
            note = f"{since} · next: {nxt.name.split()[0]} visit {fmt_day(nxt.visit_on)}"
        elif not last_alarm:
            note = f"{since} · no alarm test logged since opening"
        else:
            note = since
    status = score.status if score and loaded else "grey"
    if not loaded and trading:
        status = "red"  # trading with no register is a red property
    status_label = {
        "red": "Red",
        "amber": "Amber",
        "green": "Green",
        "grey": "Not set up" if p["stage"] == "setup" else "Not ready",
    }[status]
    if p["stage"] == "pre_opening":
        status_label = "Ready to open" if gs and gs.status == gate_rules.READY else "Not ready"
        status = "green" if gs and gs.status == gate_rules.READY else "grey"
    return {
        "id": str(pid),
        "name": p["name"],
        "code": p["code"],
        "town": p["town"],
        "dutyholder": p.get("dutyholder_name"),
        "jurisdiction": p["jurisdiction"],
        "stage": p["stage"],
        "stage_label": STAGE_LABEL.get(p["stage"], p["stage"]),
        "stage_note": p["stage_note"],
        "trading_since": p["trading_since"],
        "opening_date": p["opening_date"],
        "register_loaded": loaded,
        "score": score.percent if score and loaded else None,
        "score_status": status,
        "status_label": status_label,
        "red_line": bool(score and score.red_line),
        "class_a_late": a_late,
        "checks": {
            "late": counts.get("red", 0),
            "soon": counts.get("amber", 0),
            "ok": counts.get("green", 0),
            "na": counts.get("grey", 0),
            "total": sum(counts.values()),
        },
        "actions": {
            "open": len(acts),
            "urgent": sum(1 for a in acts if a.priority == "high"),
            "soon": sum(1 for a in acts if a.priority == "med"),
            "later": sum(1 for a in acts if a.priority == "low"),
            "late": sum(1 for a in acts if a.due_on < today),
            "urgent_late": sum(1 for a in acts if a.priority == "high" and a.due_on < today),
            "urgent_over_7": sum(1 for a in acts if a.priority == "high" and a.due_on < today - timedelta(days=0)),
        },
        "gate": {
            "status": gs.status,
            "applicable": gs.applicable,
            "done": gs.done,
            "percent": gs.percent,
            "class_a_open": gs.class_a_open,
            "class_a_applicable": gs.class_a_applicable,
            "class_a_done": gs.class_a_done,
            "to_confirm": gs.to_confirm,
        }
        if gs
        else None,
        "due_14": due14,
        "certs_60": certs60,
        "last_alarm_test": last_alarm,
        "days_since_alarm_test": (today - last_alarm).days if last_alarm else None,
        "note": note,
    }


def weekly_on_time(conn: Connection, pr: Principal, property_id: uuid.UUID | None, weeks: int = 8) -> list[dict]:
    """On-time % per week (DSH-04): completed by due ÷ (tasks due − approved N/A)."""
    today = clock.today()
    start = clock.monday_of(today) - timedelta(weeks=weeks - 1)
    q = (
        select(task.c.due_at, task.c.status, task.c.completed_at)
        .join(register_item, register_item.c.id == task.c.register_item_id)
        .where(
            task.c.due_at >= clock.start_of_day(start),
            task.c.due_at <= clock.now(),
            task.c.status.notin_(("cancelled", "scheduled")),
            scope_filter(pr, register_item.c.property_id),
        )
    )
    if property_id:
        q = q.where(register_item.c.property_id == property_id)
    buckets: dict[date, kpi.TaskTally] = {start + timedelta(weeks=i): kpi.TaskTally() for i in range(weeks)}
    for r in conn.execute(q):
        wk = clock.monday_of(clock.london(r.due_at).date())
        t = buckets.get(wk)
        if t is None:
            continue
        t.due += 1
        if r.status == "na":
            t.na += 1
        elif r.status in ("passed", "verified", "failed", "submitted") and r.completed_at:
            if r.completed_at <= r.due_at:
                t.on_time += 1
            else:
                t.late += 1
        elif r.status == "missed":
            t.missed += 1
    return [
        {"week": wk, "label": f"{wk.day} {wk:%b}", "on_time": t.on_time_pct, "due": t.denominator}
        for wk, t in buckets.items()
    ]


def weekly_actions(conn: Connection, pr: Principal, property_id: uuid.UUID | None, weeks: int = 8) -> list[dict]:
    today = clock.today()
    start = clock.monday_of(today) - timedelta(weeks=weeks - 1)
    q = select(action.c.raised_on, action.c.closed_on).where(
        scope_filter(pr, action.c.property_id), or_(action.c.raised_on >= start, action.c.closed_on >= start)
    )
    if property_id:
        q = q.where(action.c.property_id == property_id)
    opened = {start + timedelta(weeks=i): 0 for i in range(weeks)}
    closed = dict.fromkeys(opened, 0)
    for r in conn.execute(q):
        if r.raised_on and r.raised_on >= start:
            opened[clock.monday_of(r.raised_on)] = opened.get(clock.monday_of(r.raised_on), 0) + 1
        if r.closed_on and r.closed_on >= start:
            closed[clock.monday_of(r.closed_on)] = closed.get(clock.monday_of(r.closed_on), 0) + 1
    return [{"week": wk, "label": f"{wk.day} {wk:%b}", "opened": opened[wk], "closed": closed[wk]} for wk in opened]


def heatmap(conn: Connection, pr: Principal, props: list[dict]) -> dict:
    """Property × domain status (DSH-02): the worst RAG in each cell, with counts."""
    doms = [
        dict(r)
        for r in conn.execute(select(domain.c.id, domain.c.key, domain.c.name).order_by(domain.c.sort)).mappings()
    ]
    rows = conn.execute(
        select(register_item.c.property_id, template.c.domain_id, register_item.c.status, func.count())
        .join(template, template.c.id == register_item.c.template_id)
        .where(register_item.c.state != "draft", scope_filter(pr, register_item.c.property_id))
        .group_by(register_item.c.property_id, template.c.domain_id, register_item.c.status)
    ).all()
    cells: dict[tuple, dict] = {}
    for pid, did, st, n in rows:
        c = cells.setdefault((pid, did), {"red": 0, "amber": 0, "green": 0, "grey": 0})
        c[st] += n
    order = ["red", "amber", "green", "grey"]
    out = []
    for p in props:
        row = {"property_id": str(p["id"]), "property": p["name"], "cells": []}
        for d in doms:
            c = cells.get((p["id"], d["id"]))
            worst = next((s for s in order if c and c[s]), None)
            row["cells"].append({"domain": d["key"], "status": worst, "counts": c or {}})
        out.append(row)
    return {"domains": [{"key": d["key"], "name": d["name"]} for d in doms], "rows": out}


def todo(conn: Connection, pr: Principal, property_id: uuid.UUID | None = None) -> dict:
    """Everything waiting for this person: checks, actions, reviews, signatures (design: My to-do)."""
    today = clock.today()
    now_items: list[dict] = []
    pfilter = (lambda col: col == property_id) if property_id else (lambda col: scope_filter(pr, col))

    # Class A calls still to make, and open escalations where I'm a recipient.
    for e in conn.execute(
        select(
            escalation,
            action.c.ref,
            action.c.description,
            action.c.call_due,
            action.c.call_made_at,
            property_.c.name.label("property"),
        )
        .outerjoin(action, action.c.id == escalation.c.action_id)
        .outerjoin(property_, property_.c.id == escalation.c.property_id)
        .where(
            escalation.c.acknowledged_at.is_(None),
            escalation.c.recipients.contains([str(pr.person_id)]),
            pfilter(escalation.c.property_id),
        )
        .order_by(escalation.c.created_at.desc())
    ).mappings():
        if e["trigger"] == "class_a_failure":
            now_items.append(
                {
                    "kind": "call",
                    "id": str(e["id"]),
                    "icon": "phone",
                    "title": f"Phone {e['property']}: {e['description'][0].lower() + e['description'][1:]}"
                    if e["description"]
                    else e["summary"],
                    "detail": f"Life-safety alert · {e['ref']} · call is due today",
                    "action_ref": e["ref"],
                    "call_due": bool(e["call_due"] and not e["call_made_at"]),
                    "class": "A",
                    "link": f"/actions?sel={e['ref']}",
                }
            )
    mine = (
        conn.execute(
            select(action, property_.c.name.label("property"))
            .join(property_, property_.c.id == action.c.property_id)
            .where(action.c.owner_id == pr.person_id, action.c.status != "closed", pfilter(action.c.property_id))
            .order_by(action.c.due_on)
        )
        .mappings()
        .all()
    )
    for a in mine:
        if a["priority"] == "high" or a["due_on"] <= today + timedelta(days=7):
            now_items.append(
                {
                    "kind": "action",
                    "id": str(a["id"]),
                    "icon": "flag",
                    "title": a["description"],
                    "detail": f"Your action · {a['ref']} · {'Urgent' if a['priority'] == 'high' else 'Soon' if a['priority'] == 'med' else 'Later'} · due {fmt_day(a['due_on'])}",
                    "link": f"/actions?sel={a['ref']}",
                    "due_on": a["due_on"],
                    "class": a["class"],
                }
            )
    decisions = 0
    if pr.can("approval.decide"):
        for r in conn.execute(
            select(
                approval_request,
                property_.c.name.label("property"),
                register_item.c.ref,
                template.c.name.label("template"),
                template.c["class"].label("klass"),
            )
            .outerjoin(property_, property_.c.id == approval_request.c.property_id)
            .outerjoin(register_item, register_item.c.id == approval_request.c.register_item_id)
            .outerjoin(template, template.c.id == register_item.c.template_id)
            .where(
                approval_request.c.status == "waiting",
                pfilter(approval_request.c.property_id),
                or_(approval_request.c.requested_by.is_(None), approval_request.c.requested_by != pr.person_id),
            )
            .order_by(approval_request.c.created_at)
        ).mappings():
            if r["kind"] == "cover" and (r["payload"] or {}).get("cover_id") == str(pr.person_id):
                continue  # nobody approves their own cover (§2)
            decisions += 1
            now_items.append(_approval_item(conn, r))

    # Evidence to review (VER-05: never my own).
    pending = (
        conn.execute(
            select(func.count())
            .select_from(
                submission.join(task, task.c.id == submission.c.task_id).join(
                    register_item, register_item.c.id == task.c.register_item_id
                )
            )
            .where(
                task.c.status.in_(("submitted", "failed")),
                submission.c.submitter_id != pr.person_id,
                pfilter(register_item.c.property_id),
                ~select(verification.c.id).where(verification.c.submission_id == submission.c.id).exists(),
            )
        ).scalar()
        if pr.can("verify")
        else 0
    )
    spot = (
        conn.execute(
            select(func.count())
            .select_from(
                submission.join(task, task.c.id == submission.c.task_id).join(
                    register_item, register_item.c.id == task.c.register_item_id
                )
            )
            .where(
                task.c.status == "passed",
                task.c.spot_check.is_(True),
                submission.c.submitter_id != pr.person_id,
                pfilter(register_item.c.property_id),
                submission.c.server_time >= clock.start_of_day(today - timedelta(days=7)),
                ~select(verification.c.id).where(verification.c.submission_id == submission.c.id).exists(),
            )
        ).scalar()
        if pr.can("verify")
        else 0
    )

    signatures = (
        conn.execute(
            select(signature_request, property_.c.name.label("property"))
            .join(property_, property_.c.id == signature_request.c.property_id)
            .where(signature_request.c.status == "open", pfilter(signature_request.c.property_id))
        )
        .mappings()
        .all()
    )
    sign_items = [
        s
        for s in signatures
        if pr.can("sign.dutyholder", s["property_id"])
        or (s["type"] == "fra_countersign" and pr.can("sign.countersign", s["property_id"]))
    ]

    week_end = today + timedelta(days=(6 - today.weekday()) + 7)
    coming: list[dict] = []
    for v in conn.execute(
        select(
            contractor_visit.c.visit_on,
            contractor_visit.c.purpose,
            contractor.c.name,
            property_.c.name.label("property"),
        )
        .join(contractor, contractor.c.id == contractor_visit.c.contractor_id)
        .join(property_, property_.c.id == contractor_visit.c.property_id)
        .where(
            contractor_visit.c.visit_on >= today,
            contractor_visit.c.visit_on <= week_end,
            pfilter(contractor_visit.c.property_id),
        )
    ):
        coming.append(
            {
                "date": v.visit_on,
                "text": f"{v.name.split()[0]} visit, {v.property}: {v.purpose[0].lower() + v.purpose[1:]}",
            }
        )
    due_by_day = conn.execute(
        select(action.c.due_on, func.count())
        .where(
            action.c.status != "closed",
            action.c.priority == "high",
            action.c.due_on >= today,
            action.c.due_on <= week_end,
            pfilter(action.c.property_id),
        )
        .group_by(action.c.due_on)
    ).all()
    for d, n in due_by_day:
        coming.append({"date": d, "text": f"{n} urgent {'action' if n == 1 else 'actions'} due", "strong": True})
    nxt_monday = today + timedelta(days=(7 - today.weekday()) % 7 or 7)
    coming.append({"date": nxt_monday, "text": "Monday digest goes out at 08:30"})
    for a in conn.execute(
        select(action.c.ref, action.c.description, action.c.due_on, action.c.source).where(
            action.c.status != "closed",
            action.c.source == "insurer",
            action.c.due_on > week_end,
            action.c.due_on <= today + timedelta(days=21),
            pfilter(action.c.property_id),
        )
    ):
        coming.append({"date": a.due_on, "text": f"Insurer deadline ({a.ref})"})
    coming.sort(key=lambda c: c["date"])
    for c in coming:
        c["label"] = fmt_day(c["date"])

    return {
        "now": now_items,
        "counts": {
            "everything": len(now_items) + pending + spot + len(sign_items),
            "decisions": decisions + sum(1 for i in now_items if i["kind"] == "call"),
            "reviews": pending + spot,
            "actions": len(mine),
            "today": sum(1 for i in now_items if i["kind"] in ("call",) or (i.get("due_on") and i["due_on"] <= today)),
        },
        "reviews": {"pending": pending, "spot_check": spot},
        "signatures": [
            {"id": str(s["id"]), "title": s["title"], "property": s["property"], "due_on": s["due_on"]}
            for s in sign_items
        ],
        "coming": coming,
    }


def _approval_item(conn: Connection, r) -> dict:
    from bide_comply.services.common import names

    who = names(conn, {r["requested_by"]}).get(r["requested_by"]) if r["requested_by"] else None
    kind = r["kind"]
    if kind == "switch_off":
        title = f"Approve switching off “{_short(r['template'])}” at {r['property']}"
        detail = f"Requested by {who} · reason: “{r['reason']}”"
    elif kind == "cover":
        p = r["payload"] or {}
        names_ = names(conn, {uuid.UUID(p["person_id"]), uuid.UUID(p["cover_id"])}) if p.get("person_id") else {}
        cover = names_.get(uuid.UUID(p["cover_id"])) if p.get("cover_id") else "someone"
        away = names_.get(uuid.UUID(p["person_id"])) if p.get("person_id") else "someone"
        s, e = date.fromisoformat(p["starts_on"]), date.fromisoformat(p["ends_on"])
        title = f"Approve cover: {cover} covers {p.get('what', 'checks')} at {r['property']}"
        detail = f"{away} on leave {fmt_day(s)} – {fmt_day(e)}" + (
            " · from the holiday tracker" if r["source"] == "holiday_tracker" else ""
        )
    elif kind == "missed":
        title = f"Accept a “Missed” reason: {_short(r['template']).lower()}, {r['property']}"
        detail = f"“{r['reason']}” · {who}"
    elif kind == "na":
        title = f"Agree “not applicable”: {_short(r['template']).lower()}, {r['property']}"
        detail = f"“{r['reason']}” · {who}"
    elif kind == "pause":
        title = f"Approve pausing “{_short(r['template'])}” at {r['property']}"
        detail = f"“{r['reason']}” · {who}"
    else:
        title = f"Approve a back-filed record: {_short(r['template'] or '')}, {r['property']}"
        detail = f"{who}"
    return {
        "kind": "approval",
        "approval_kind": kind,
        "id": str(r["id"]),
        "icon": "check",
        "title": title,
        "detail": detail,
        "link": f"/approvals?sel={r['id']}",
        "class": r["klass"],
    }


def _short(name: str | None) -> str:
    if not name:
        return ""
    return {
        "CCTV policy, signage and retention (UK GDPR)": "CCTV policy",
        "Hot and cold outlet temperatures logged": "Water temperatures",
    }.get(name, name.split(" (")[0])


def nav_counts(conn: Connection, pr: Principal, property_id: uuid.UUID | None) -> dict:
    pfilter = (lambda col: col == property_id) if property_id else (lambda col: scope_filter(pr, col))
    t = todo(conn, pr, property_id)
    actions_open = conn.execute(
        select(func.count()).where(action.c.status != "closed", pfilter(action.c.property_id))
    ).scalar()
    sign = conn.execute(
        select(func.count()).where(signature_request.c.status == "open", pfilter(signature_request.c.property_id))
    ).scalar()
    approvals = conn.execute(
        select(func.count()).where(approval_request.c.status == "waiting", pfilter(approval_request.c.property_id))
    ).scalar()
    return {
        "todo": len(t["now"]),
        "actions": actions_open,
        "reviews": t["reviews"]["pending"] + t["reviews"]["spot_check"],
        "signoffs": len(t["signatures"]) if not pr.is_admin else sign + (approvals if pr.can("approval.decide") else 0),
    }


def expiring_certificates(conn: Connection, pr: Principal, property_id: uuid.UUID | None, limit: int = 3) -> list[dict]:
    today = clock.today()
    pfilter = (lambda col: col == property_id) if property_id else (lambda col: scope_filter(pr, col))
    rows = conn.execute(
        select(certificate.c.id, certificate.c.title, certificate.c.expires_on, property_.c.name.label("property"))
        .join(property_, property_.c.id == certificate.c.property_id)
        .where(
            certificate.c.filing == "filed",
            certificate.c.expires_on >= today,
            certificate.c.superseded_by.is_(None),
            pfilter(certificate.c.property_id),
        )
        .order_by(certificate.c.expires_on)
        .limit(limit)
    ).mappings()
    return [
        {
            "id": str(r["id"]),
            "title": r["title"],
            "property": r["property"],
            "expires_on": r["expires_on"],
            "days": (r["expires_on"] - today).days,
        }
        for r in rows
    ]


def l10(conn: Connection, pr: Principal, property_id: uuid.UUID | None) -> dict:
    """The three L10 scorecard measurables (BH-CMP-001 §6.3)."""
    today = clock.today()
    pfilter = (lambda col: col == property_id) if property_id else (lambda col: scope_filter(pr, col))
    class_a = conn.execute(
        select(func.count())
        .select_from(register_item.join(template, template.c.id == register_item.c.template_id))
        .where(
            register_item.c.status == "red",
            template.c["class"] == "A",
            register_item.c.state != "draft",
            pfilter(register_item.c.property_id),
        )
    ).scalar()
    weeks = weekly_on_time(conn, pr, property_id, weeks=2)
    high_over_7 = conn.execute(
        select(func.count()).where(
            action.c.status != "closed",
            action.c.priority == "high",
            action.c.raised_on < today - timedelta(days=7),
            pfilter(action.c.property_id),
        )
    ).scalar()
    urgent_total = conn.execute(
        select(func.count()).where(
            action.c.status != "closed", action.c.priority == "high", pfilter(action.c.property_id)
        )
    ).scalar()
    urgent_late = conn.execute(
        select(func.count()).where(
            action.c.status != "closed",
            action.c.priority == "high",
            action.c.due_on < today,
            pfilter(action.c.property_id),
        )
    ).scalar()
    return {
        "class_a_overdue": class_a,
        "on_time_last_7": weeks[-1]["on_time"] if weeks else None,
        "on_time_prev": weeks[0]["on_time"] if len(weeks) > 1 else None,
        "high_over_7": high_over_7,
        "urgent_total": urgent_total,
        "urgent_late": urgent_late,
    }


def gate_open_by_property(conn: Connection, props: list[dict]) -> list[dict]:
    out = []
    for p in props:
        gs = gate_summary(conn, p["id"], p["stage"] == "trading")
        if gs:
            out.append(
                {
                    "property_id": str(p["id"]),
                    "property": p["name"],
                    "class_a_open": gs.class_a_open,
                    "opened": p["stage"] in ("trading",),
                }
            )
    return sorted(out, key=lambda r: -r["class_a_open"])


def due_soon_filter(today: date):
    return and_(register_item.c.next_due_on >= today, register_item.c.next_due_on <= today + timedelta(days=14))
