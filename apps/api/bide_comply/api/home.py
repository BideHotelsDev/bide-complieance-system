"""Who am I, the sidebar counts, Home, My to-do, Properties, global search and the in-app inbox."""

import uuid
from datetime import timedelta

from fastapi import APIRouter, Query
from sqlalchemy import func, or_, select, update

from bide_comply import clock
from bide_comply.auth import Current
from bide_comply.authz import ROLES, scope_filter
from bide_comply.db import ConnDep
from bide_comply.engine import kpi
from bide_comply.schema import (
    action,
    alarm_event,
    approval_request,
    certificate,
    contractor,
    dutyholder,
    dutyholder_director,
    notification,
    person,
    property_,
    register_item,
    signature_request,
    template,
    theme_version,
)
from bide_comply.services import views
from bide_comply.services.common import fmt_day, initials, problem
from bide_comply.services.register import scores

router = APIRouter(prefix="/api", tags=["home"])


@router.get("/me")
def me(pr: Current, conn: ConnDep) -> dict:
    p = conn.execute(select(person).where(person.c.id == pr.person_id)).mappings().one()
    props = views.visible_properties(conn, pr)
    spvs = [
        r.name
        for r in conn.execute(
            select(dutyholder.c.name)
            .join(dutyholder_director, dutyholder_director.c.dutyholder_id == dutyholder.c.id)
            .where(dutyholder_director.c.person_id == pr.person_id)
        )
    ]
    role = pr.headline_role
    return {
        "id": str(pr.person_id),
        "name": pr.name,
        "first_name": pr.name.split()[0].strip("["),
        "initials": initials(pr.name),
        "email": pr.email,
        "title": p["title"] or ROLES.get(role, role),
        "kind": pr.kind,
        "roles": sorted(pr.role_names),
        "role": role,
        "role_label": ROLES.get(role, role),
        "is_admin": pr.is_admin,
        "spvs": spvs,
        "all_properties": pr.scope is None,
        "properties": [
            {"id": str(x["id"]), "name": x["name"], "code": x["code"], "town": x["town"], "stage": x["stage"]}
            for x in props
        ],
        "can": {
            cap: pr.can(cap)
            for cap in (
                "library.edit",
                "register.toggle",
                "approval.decide",
                "people.manage",
                "people.view",
                "assign",
                "verify",
                "action.raise",
                "action.close",
                "action.manage",
                "sign.dutyholder",
                "sign.countersign",
                "dashboard.view",
                "scorecard.view",
                "export.pack",
                "audit.view",
                "submission.amend",
                "theme.publish",
                "content.edit",
                "settings.view",
                "import.run",
                "policy.escalation",
                "assessor.walk",
                "task.complete",
            )
        },
        "preferences": p["preferences"] or {},
        "privacy_notice_seen": bool(p["privacy_notice_seen_at"]),
        "session_ends_hours": 8 if pr.kind == "external" else None,
    }


@router.post("/me/preferences")
def set_prefs(body: dict, pr: Current, conn: ConnDep) -> dict:
    allowed = {
        k: v
        for k, v in body.items()
        if k in {"density", "theme", "push", "reminder", "quiet_days_off", "muted", "sidebar_collapsed", "tour_done"}
    }
    cur = conn.execute(select(person.c.preferences).where(person.c.id == pr.person_id)).scalar() or {}
    muted = allowed.get("muted")
    if muted:
        # Class A alerts can't be muted (§7).
        allowed["muted"] = [m for m in muted if not str(m).startswith("A")]
    conn.execute(update(person).where(person.c.id == pr.person_id).values(preferences={**cur, **allowed}))
    return {"ok": True}


@router.post("/me/privacy-notice")
def privacy_seen(pr: Current, conn: ConnDep) -> dict:
    conn.execute(update(person).where(person.c.id == pr.person_id).values(privacy_notice_seen_at=clock.now()))
    return {"ok": True}


@router.get("/nav")
def nav(pr: Current, conn: ConnDep, property: uuid.UUID | None = None) -> dict:  # noqa: A002
    return views.nav_counts(conn, pr, property)


@router.get("/overview")
def overview(pr: Current, conn: ConnDep, property: uuid.UUID | None = None, period: str = "week") -> dict:  # noqa: A002
    pr.require("dashboard.view")
    if property:
        pr.require_property(property)
    props = views.visible_properties(conn, pr, property)
    sc = scores(conn, [p["id"] for p in props])
    summaries = [views.property_summary(conn, p, sc.get(p["id"])) for p in props]
    weeks = {"week": 8, "month": 13, "quarter": 26}.get(period, 8)
    l10 = views.l10(conn, pr, property)
    today = clock.today()
    pfilter = (lambda col: col == property) if property else (lambda col: scope_filter(pr, col))
    acts = conn.execute(
        select(action.c.priority, func.count())
        .where(action.c.status != "closed", pfilter(action.c.property_id))
        .group_by(action.c.priority)
    ).all()
    by_prio = dict(acts)
    adv_open = conn.execute(
        select(func.count()).where(
            action.c.status != "closed", action.c.type == "advisory", pfilter(action.c.property_id)
        )
    ).scalar()
    sign_open = conn.execute(
        select(func.count()).where(signature_request.c.status == "open", pfilter(signature_request.c.property_id))
    ).scalar()
    red = [s for s in summaries if s["score_status"] == "red"]
    insurer = conn.execute(
        select(action.c.ref, action.c.due_on, property_.c.name)
        .join(property_, property_.c.id == action.c.property_id)
        .where(action.c.status != "closed", action.c.source == "insurer", pfilter(action.c.property_id))
        .order_by(action.c.due_on)
        .limit(1)
    ).first()
    banner = None
    if red:
        banner = {
            "text": f"{len(red)} {'property is' if len(red) == 1 else 'properties are'} red.",
            "extra": f"Insurance proof for {insurer.name} is due {fmt_day(insurer.due_on)}." if insurer else None,
            "link": "/actions?view=urgent",
        }
    ls_open = sum((s["gate"] or {}).get("class_a_open", 0) for s in summaries if s["gate"])
    ls_props = sum(1 for s in summaries if s["gate"] and s["gate"]["class_a_open"])
    t = views.todo(conn, pr, property)
    certs = views.expiring_certificates(conn, pr, property)
    return {
        "updated_at": clock.now(),
        "banner": banner,
        "kpis": {
            "life_safety_open": {"value": ls_open, "properties": ls_props, "goal": 0},
            "class_a_overdue": {
                "value": l10["class_a_overdue"],
                "goal": 0,
                "definition": kpi.DEFINITIONS["class_a_overdue"],
            },
            "urgent_late": {"value": l10["urgent_late"], "of": l10["urgent_total"], "goal": 0},
            "high_over_7": {"value": l10["high_over_7"], "goal": 0, "definition": kpi.DEFINITIONS["high_over_7"]},
            "on_time": {
                "value": l10["on_time_last_7"],
                "prev": l10["on_time_prev"],
                "goal": 95,
                "definition": kpi.DEFINITIONS["on_time"],
            },
            "decisions": {"value": adv_open + sign_open, "advisories": adv_open, "signoffs": sign_open},
        },
        "properties": summaries,
        "group": {
            "score": round(
                sum(s["score"] for s in summaries if s["score"] is not None)
                / max(1, sum(1 for s in summaries if s["score"] is not None))
            )
            if any(s["score"] is not None for s in summaries)
            else None,
            "class_a_late": sum(s["class_a_late"] for s in summaries),
            "overdue": sum(s["checks"]["late"] for s in summaries),
            "due_14": sum(s["due_14"] for s in summaries),
            "urgent_open": sum(s["actions"]["urgent"] for s in summaries),
            "certs_60": sum(s["certs_60"] for s in summaries),
        },
        "needs_you": t["now"][:4],
        "actions_by_urgency": {
            "high": by_prio.get("high", 0),
            "med": by_prio.get("med", 0),
            "low": by_prio.get("low", 0),
        },
        "on_time_trend": views.weekly_on_time(conn, pr, property, weeks),
        "actions_trend": views.weekly_actions(conn, pr, property, weeks),
        "gate_open": views.gate_open_by_property(conn, props),
        "next_certificates": certs,
        "heatmap": views.heatmap(conn, pr, props),
        "definitions": kpi.DEFINITIONS,
        "today": today,
    }


@router.get("/todo")
def my_todo(pr: Current, conn: ConnDep, property: uuid.UUID | None = None) -> dict:  # noqa: A002
    if property:
        pr.require_property(property)
    return views.todo(conn, pr, property)


@router.get("/properties")
def properties(pr: Current, conn: ConnDep) -> dict:
    props = views.visible_properties(conn, pr)
    sc = scores(conn, [p["id"] for p in props])
    rows = [views.property_summary(conn, p, sc.get(p["id"])) for p in props]

    def worst(r):
        order = {"red": 0, "amber": 1, "grey": 2, "green": 3}
        return (order.get(r["score_status"], 4), r["score"] if r["score"] is not None else 101)

    rows.sort(key=worst)
    views_ = [
        {"key": "all", "label": "All", "count": len(rows)},
        {"key": "trading", "label": "Trading", "count": sum(1 for r in rows if r["stage"] == "trading")},
        {"key": "opening", "label": "Opening soon", "count": sum(1 for r in rows if r["stage"] == "pre_opening")},
        {"key": "setup", "label": "Not set up yet", "count": sum(1 for r in rows if r["stage"] == "setup")},
    ]
    return {"rows": rows, "views": views_}


@router.get("/properties/{key}")
def property_detail(key: str, pr: Current, conn: ConnDep) -> dict:
    from bide_comply.api.register import resolve_property

    property_id = resolve_property(conn, pr, key)["id"]
    props = views.visible_properties(conn, pr, property_id)
    if not props:
        raise problem(404, "not_found", "Not found.")
    p = props[0]
    s = views.property_summary(conn, p)
    s["features"] = p["features"]
    s["geofence"] = {"lat": p["geofence_lat"], "lng": p["geofence_lng"], "radius_m": p["geofence_radius_m"]}
    s["licence_regime"] = p["licence_regime"]
    s["local_authority"] = p["local_authority"]
    s["legal_hold"] = p["legal_hold"]
    s["certificates_count"] = conn.execute(
        select(func.count()).where(certificate.c.property_id == property_id)
    ).scalar()
    s["alarm_events_count"] = conn.execute(
        select(func.count()).where(alarm_event.c.property_id == property_id)
    ).scalar()
    return s


@router.get("/search")
def search(
    pr: Current, conn: ConnDep, q: str = Query(min_length=0, max_length=100), property: uuid.UUID | None = None
) -> dict:  # noqa: A002
    """⌘K palette: register items, Actions, templates, properties, people, contractors, certificates (§10.3)."""
    term = q.strip()
    if len(term) < 2:
        return {"groups": [], "scope": "all" if pr.scope is None else "yours"}
    like = f"%{term}%"
    pfilter = (lambda col: col == property) if property else (lambda col: scope_filter(pr, col))
    groups = []
    items = (
        conn.execute(
            select(
                register_item.c.id,
                register_item.c.ref,
                register_item.c.status,
                template.c.name,
                template.c["class"],
                property_.c.name.label("property"),
            )
            .join(template, template.c.id == register_item.c.template_id)
            .join(property_, property_.c.id == register_item.c.property_id)
            .where(
                or_(template.c.name.ilike(like), register_item.c.ref.ilike(like)), pfilter(register_item.c.property_id)
            )
            .limit(6)
        )
        .mappings()
        .all()
    )
    if items:
        groups.append(
            {
                "type": "register",
                "label": "Register items",
                "items": [
                    {
                        "id": str(r["id"]),
                        "ref": r["ref"],
                        "title": r["name"],
                        "sub": r["property"],
                        "class": r["class"],
                        "status": r["status"],
                        "link": f"/properties/{r['ref'][:2]}?item={r['ref']}",
                    }
                    for r in items
                ],
            }
        )
    acts = (
        conn.execute(
            select(
                action.c.id,
                action.c.ref,
                action.c.description,
                action.c.priority,
                action.c.status,
                property_.c.name.label("property"),
            )
            .join(property_, property_.c.id == action.c.property_id)
            .where(or_(action.c.description.ilike(like), action.c.ref.ilike(like)), pfilter(action.c.property_id))
            .order_by(action.c.status == "closed", action.c.due_on)
            .limit(6)
        )
        .mappings()
        .all()
    )
    if acts:
        groups.append(
            {
                "type": "action",
                "label": "Actions",
                "items": [
                    {
                        "id": str(r["id"]),
                        "ref": r["ref"],
                        "title": r["description"],
                        "sub": r["property"],
                        "priority": r["priority"],
                        "status": r["status"],
                        "link": f"/actions?sel={r['ref']}",
                    }
                    for r in acts
                ],
            }
        )
    if pr.can("register.view"):
        tpls = (
            conn.execute(
                select(
                    template.c.id,
                    template.c.name,
                    template.c["class"],
                    template.c.legal_basis,
                    template.c.current_version,
                )
                .where(or_(template.c.name.ilike(like), template.c.legal_basis.ilike(like)))
                .limit(4)
            )
            .mappings()
            .all()
        )
        if tpls:
            groups.append(
                {
                    "type": "template",
                    "label": "Templates",
                    "items": [
                        {
                            "id": str(r["id"]),
                            "title": r["name"],
                            "sub": f"{(r['legal_basis'] or '').split(';')[0]} · v{r['current_version']}",
                            "class": r["class"],
                            "link": f"/settings/library/{r['id']}",
                        }
                        for r in tpls
                    ],
                }
            )
    props = [
        p for p in views.visible_properties(conn, pr) if term.lower() in (p["name"] + " " + (p["town"] or "")).lower()
    ]
    if props:
        groups.append(
            {
                "type": "property",
                "label": "Properties",
                "items": [
                    {"id": str(p["id"]), "title": p["name"], "sub": p["town"], "link": f"/properties/{p['code']}"}
                    for p in props[:4]
                ],
            }
        )
    if pr.can("people.view"):
        ppl = (
            conn.execute(
                select(person.c.id, person.c.name, person.c.title)
                .where(person.c.name.ilike(like), person.c.employment_status == "active")
                .limit(4)
            )
            .mappings()
            .all()
        )
        if ppl:
            groups.append(
                {
                    "type": "person",
                    "label": "People",
                    "items": [
                        {
                            "id": str(r["id"]),
                            "title": r["name"],
                            "sub": r["title"],
                            "link": f"/settings/people?sel={r['id']}",
                        }
                        for r in ppl
                    ],
                }
            )
        cons = (
            conn.execute(
                select(contractor.c.id, contractor.c.name, contractor.c.trade)
                .where(contractor.c.name.ilike(like))
                .limit(3)
            )
            .mappings()
            .all()
        )
        if cons:
            groups.append(
                {
                    "type": "contractor",
                    "label": "Contractors",
                    "items": [
                        {
                            "id": str(r["id"]),
                            "title": r["name"],
                            "sub": r["trade"],
                            "link": f"/settings/people?tab=contractors&sel={r['id']}",
                        }
                        for r in cons
                    ],
                }
            )
    certs = (
        conn.execute(
            select(
                certificate.c.id,
                certificate.c.title,
                certificate.c.expires_on,
                certificate.c.filing,
                property_.c.name.label("property"),
            )
            .join(property_, property_.c.id == certificate.c.property_id)
            .where(
                or_(certificate.c.title.ilike(like), certificate.c.issuer.ilike(like), certificate.c.type.ilike(like)),
                pfilter(certificate.c.property_id),
            )
            .limit(4)
        )
        .mappings()
        .all()
    )
    if certs:
        groups.append(
            {
                "type": "certificate",
                "label": "Certificates",
                "items": [
                    {
                        "id": str(r["id"]),
                        "title": r["title"],
                        "sub": r["property"],
                        "status": "missing"
                        if r["filing"] != "filed"
                        else ("expired" if r["expires_on"] and r["expires_on"] < clock.today() else "valid"),
                        "link": f"/certificates?sel={r['id']}",
                    }
                    for r in certs
                ],
            }
        )
    n_props = len(views.visible_properties(conn, pr)) if not property else 1
    return {
        "groups": groups,
        "scope_label": f"Searching {'all ' if pr.scope is None and not property else ''}{n_props} "
        f"{'property' if n_props == 1 else 'properties'}",
    }


@router.get("/notifications")
def notifications(pr: Current, conn: ConnDep) -> dict:
    rows = (
        conn.execute(
            select(notification)
            .where(notification.c.person_id == pr.person_id)
            .order_by(notification.c.created_at.desc())
            .limit(50)
        )
        .mappings()
        .all()
    )
    return {
        "rows": [
            {
                "id": str(r["id"]),
                "kind": r["kind"],
                "class": r["class"],
                "title": r["title"],
                "body": r["body"],
                "link": r["link"],
                "read": bool(r["read_at"]),
                "created_at": r["created_at"],
            }
            for r in rows
        ],
        "unread": sum(1 for r in rows if not r["read_at"]),
    }


@router.post("/notifications/read")
def read_notifications(pr: Current, conn: ConnDep) -> dict:
    conn.execute(
        update(notification)
        .where(notification.c.person_id == pr.person_id, notification.c.read_at.is_(None))
        .values(read_at=clock.now())
    )
    return {"ok": True}


@router.get("/theme")
def theme(conn: ConnDep) -> dict:
    """Public: the live theme, applied before first paint and cached by the client (CMS-13, §11)."""
    t = (
        conn.execute(
            select(theme_version)
            .where(theme_version.c.status == "live")
            .order_by(theme_version.c.version.desc())
            .limit(1)
        )
        .mappings()
        .first()
    )
    if not t:
        from bide_comply.seed.reference import DEFAULT_BRANDING, DEFAULT_THEME

        return {"version": 0, "tokens": DEFAULT_THEME, "branding": DEFAULT_BRANDING}
    return {"version": t["version"], "tokens": t["tokens"], "branding": t["branding"]}


@router.get("/approvals/count")
def approvals_count(pr: Current, conn: ConnDep) -> dict:
    n = conn.execute(
        select(func.count()).where(
            approval_request.c.status == "waiting", scope_filter(pr, approval_request.c.property_id)
        )
    ).scalar()
    return {"waiting": n}


@router.get("/mobile-home")
def mobile_home(pr: Current, conn: ConnDep) -> dict:
    """David on the go: what needs him, and life-safety checks late by property (design: Manager on phone)."""
    t = views.todo(conn, pr)
    props = views.visible_properties(conn, pr)
    sc = scores(conn, [p["id"] for p in props])
    rows = [views.property_summary(conn, p, sc.get(p["id"])) for p in props if p["stage"] != "setup"]
    return {
        "first_name": pr.name.split()[0],
        "needs": t["now"][:6],
        "total": len(t["now"]) + len(t["signatures"]),
        "signatures": t["signatures"],
        "properties": rows,
        "since": clock.today() - timedelta(days=1),
    }
