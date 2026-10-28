"""The contractor portal (design: ContractorPortal; PRD §5.5, P2) and the staff side of what contractors send.

Contractors sign in with the emailed magic link (works 7 days, no password). A contact is linked to one contractor
(`contractor_contact`) and sees only the visits and Actions bide has given that contractor. Nothing they send counts
until a site manager checks it in Evidence review: a report makes the visit done (and files the certificate) only when
approved, and a fix photo moves the Action to awaiting verification, never straight to closed.
"""

import uuid
from datetime import timedelta

from sqlalchemy import Connection, select, update

from bide_comply import audit, clock
from bide_comply.authz import Principal, scope_filter
from bide_comply.engine import actions as action_rules
from bide_comply.engine import frequency as freq
from bide_comply.schema import (
    action,
    certificate,
    contractor,
    contractor_contact,
    contractor_upload,
    contractor_visit,
    evidence,
    person,
    property_,
    register_item,
    template,
)
from bide_comply.services import actions as action_service
from bide_comply.services import evidence as ev_service
from bide_comply.services import notify
from bide_comply.services.common import file_name, fmt_date, fmt_day, problem
from bide_comply.services.register import refresh_item

LINK_DAYS = 7
# Done visits and fixed Actions stay on the contractor's list this long, so they can see their work was accepted.
RECENT_DAYS = 14


# ---------------------------------------------------------------------------------------------------------------------
# Who is signed in
# ---------------------------------------------------------------------------------------------------------------------


def contractor_of(conn: Connection, pr: Principal) -> dict:
    """The contractor this person signs in for. Anyone else gets the same answer as a stranger."""
    pr.require("contractor.visits")
    row = (
        conn.execute(
            select(contractor)
            .join(contractor_contact, contractor_contact.c.contractor_id == contractor.c.id)
            .where(contractor_contact.c.person_id == pr.person_id, contractor.c.active.is_(True))
        )
        .mappings()
        .first()
    )
    if not row:
        raise problem(
            403, "no_contractor", "This sign-in isn't linked to a contractor yet. Ask bide to send you a new link."
        )
    return dict(row)


def email_hint(email: str | None) -> str | None:
    """ "jobs@nova…": enough to recognise the address without showing all of it."""
    if not email or "@" not in email:
        return email
    local, domain = email.split("@", 1)
    first = domain.split(".", 1)[0]
    return f"{local}@{first}…" if first != domain else email


def fix_title(description: str) -> str:
    """ "Detector in room 7: replace the head" -> "Fix: detector in room 7" """
    clauses = [c.strip().rstrip(".") for c in description.replace(";", ":").split(":") if c.strip()]
    # "Nova: bedhead sound test…" names who does it first; the work is the next clause.
    head = next((c for c in clauses if " " in c), clauses[0] if clauses else description)
    if len(head) > 1 and not head[:2].isupper():
        head = head[0].lower() + head[1:]
    return f"Fix: {head}"


# ---------------------------------------------------------------------------------------------------------------------
# The contractor's list
# ---------------------------------------------------------------------------------------------------------------------


def _latest_uploads(conn: Connection, contractor_id: uuid.UUID) -> dict[tuple[str, uuid.UUID], dict]:
    out: dict[tuple[str, uuid.UUID], dict] = {}
    for r in conn.execute(
        select(contractor_upload)
        .where(contractor_upload.c.contractor_id == contractor_id)
        .order_by(contractor_upload.c.created_at)
    ).mappings():
        key = ("visit", r["contractor_visit_id"]) if r["kind"] == "report" else ("fix", r["action_id"])
        out[key] = dict(r)  # later rows win: the latest send is what counts
    return out


def portal(conn: Connection, pr: Principal) -> dict:
    c = contractor_of(conn, pr)
    today = clock.today()
    since = today - timedelta(days=RECENT_DAYS)
    ups = _latest_uploads(conn, c["id"])
    items: list[tuple[tuple, dict]] = []

    visits = conn.execute(
        select(contractor_visit, property_.c.name.label("property"))
        .join(property_, property_.c.id == contractor_visit.c.property_id)
        .where(
            contractor_visit.c.contractor_id == c["id"],
            (contractor_visit.c.status == "booked") | (contractor_visit.c.visit_on >= since),
        )
    ).mappings()
    for v in visits:
        up = ups.get(("visit", v["id"]))
        n = (v["visit_on"] - today).days
        done = v["status"] == "done"
        pending = bool(up and up["status"] == "pending")
        sent_back = up["review_comment"] if up and up["status"] == "rejected" and not done else None
        if done:
            badge, tone, detail = "Done", "green", f"{v['property']} · {fmt_day(v['visit_on'])}"
        elif pending:
            badge, tone = "Being checked", "blue"
            detail = f"{v['property']} · report sent {fmt_day(clock.london(up['created_at']).date())}"
        elif sent_back is not None:
            badge, tone, detail = "Sent back", "amber", f"{v['property']} · visit {fmt_day(v['visit_on'])}"
        elif n < 0:
            badge, tone, detail = "Report due", "amber", f"{v['property']} · visited {fmt_day(v['visit_on'])}"
        elif n <= 1:
            badge, tone = ("Today" if n == 0 else "Tomorrow"), "blue"
            detail = f"{v['property']} · visit booked {fmt_day(v['visit_on'])}"
        else:
            badge, tone, detail = "Booked", "grey", f"{v['property']} · {fmt_day(v['visit_on'])}"
        items.append(
            (
                (done, v["visit_on"]),
                {
                    "kind": "visit",
                    "id": str(v["id"]),
                    "title": v["purpose"],
                    "badge": badge,
                    "badge_tone": tone,
                    "detail": detail,
                    "property": v["property"],
                    "when": fmt_day(v["visit_on"]),
                    "description": None,
                    # The report goes in after the visit: from the day before (so it's ready) onwards.
                    "can_upload": not done and not pending and n <= 1,
                    "can_mark_fixed": False,
                    "pending": pending,
                    "sent_back": sent_back,
                },
            )
        )

    acts = conn.execute(
        select(action, property_.c.name.label("property"))
        .join(property_, property_.c.id == action.c.property_id)
        .where(
            action.c.owner_contractor_id == c["id"],
            (action.c.status != "closed") | (action.c.closed_on >= since),
        )
    ).mappings()
    for a in acts:
        up = ups.get(("fix", a["id"]))
        closed = a["status"] == "closed"
        pending = bool(up and up["status"] == "pending")
        sent_back = up["review_comment"] if up and up["status"] == "rejected" and not closed else None
        late = action_rules.is_late(a["status"], a["due_on"], today)
        if closed:
            badge, tone = "Fixed", "green"
        elif pending:
            badge, tone = "Being checked", "blue"
        elif sent_back is not None:
            badge, tone = "Sent back", "amber"
        elif late:
            days = (today - a["due_on"]).days
            badge, tone = f"{days} {'day' if days == 1 else 'days'} late", "red"
        else:
            badge = f"Due {fmt_date(a['due_on'])}"
            tone = {"high": "red", "med": "amber", "low": "grey"}[a["priority"]]
        items.append(
            (
                (closed, a["due_on"]),
                {
                    "kind": "fix",
                    "id": str(a["id"]),
                    "ref": a["ref"],
                    "title": fix_title(a["description"]),
                    "badge": badge,
                    "badge_tone": tone,
                    "detail": f"{a['property']} · {action_rules.PRIORITY_LABEL[a['priority']]} priority",
                    "property": a["property"],
                    "when": f"Due {fmt_date(a['due_on'])}",
                    "description": a["description"],
                    "can_upload": False,
                    "can_mark_fixed": not closed and not pending,
                    "pending": pending,
                    "sent_back": sent_back,
                },
            )
        )

    items.sort(key=lambda x: x[0])
    me = conn.execute(select(person.c.email).where(person.c.id == pr.person_id)).scalar()
    return {
        "contractor": c["name"],
        "email_hint": email_hint(me),
        "link_days": LINK_DAYS,
        "items": [i for _, i in items],
    }


# ---------------------------------------------------------------------------------------------------------------------
# Sending a report or a fix
# ---------------------------------------------------------------------------------------------------------------------


def _verifiers(conn: Connection, property_id: uuid.UUID) -> set[uuid.UUID]:
    who = action_service.site_lead(conn, property_id) or action_service.system_owner(conn)
    return {who} if who else set()


def _send(
    conn: Connection,
    pr: Principal,
    actor: audit.Actor,
    c: dict,
    *,
    kind: str,
    property_id: uuid.UUID,
    what: str,
    evidence_ids: list[uuid.UUID],
    note: str | None,
    visit_id: uuid.UUID | None = None,
    action_id: uuid.UUID | None = None,
    entity_ref: str | None = None,
) -> dict:
    ids = list(dict.fromkeys(evidence_ids))
    evs = ev_service.stored(conn, ids, pr.person_id)
    if not ids or len(evs) != len(ids):
        raise problem(
            422, "evidence", "Add the report first." if kind == "report" else "Add a photo that shows it's fixed."
        )
    if kind == "fix" and any(not e["content_type"].startswith("image/") for e in evs):
        raise problem(422, "evidence", "Add a photo of the fix. Send reports from a visit instead.")
    target = (
        contractor_upload.c.contractor_visit_id == visit_id
        if kind == "report"
        else contractor_upload.c.action_id == action_id
    )
    if conn.execute(select(contractor_upload.c.id).where(target, contractor_upload.c.status == "pending")).first():
        raise problem(409, "pending", "You've already sent this. The site manager is checking it.")
    # Evidence uploaded from the portal has no property until it's attached here; named "What - Who - Date".
    today = clock.today()
    for e in evs:
        ext = e["file_name"].rsplit(".", 1)[-1] if "." in e["file_name"] else None
        conn.execute(
            update(evidence)
            .where(evidence.c.id == e["id"])
            .values(property_id=property_id, file_name=file_name(what, c["name"], today, ext))
        )
    uid = uuid.uuid4()
    conn.execute(
        contractor_upload.insert().values(
            id=uid,
            contractor_id=c["id"],
            person_id=pr.person_id,
            property_id=property_id,
            kind=kind,
            contractor_visit_id=visit_id,
            action_id=action_id,
            evidence_ids=[str(i) for i in ids],
            note=(note or "").strip() or None,
        )
    )
    pname = conn.execute(select(property_.c.name).where(property_.c.id == property_id)).scalar()
    audit.record(
        conn,
        actor,
        category="record",
        action=f"contractor.{kind}",
        summary=(
            f"{c['name']} sent the report for {what} at {pname} (waiting for a check)"
            if kind == "report"
            else f"{c['name']} marked {entity_ref} as fixed (waiting for a check)"
        ),
        entity_type="contractor_visit" if kind == "report" else "action",
        entity_id=visit_id or action_id,
        entity_ref=entity_ref,
        property_id=property_id,
        after={"upload_id": str(uid), "files": len(ids)},
    )
    notify.notify(
        conn,
        _verifiers(conn, property_id),
        kind="contractor.upload",
        title=f"{c['name']} sent {'a report' if kind == 'report' else 'a fix'} to check",
        body=f"{pname} · {what}",
        link=f"/reviews?queue=contractor&sel={uid}",
    )
    return {"id": str(uid), "status": "pending", "message": "Sent. The site manager checks it before it counts."}


def send_report(
    conn: Connection,
    pr: Principal,
    actor: audit.Actor,
    visit_id: uuid.UUID,
    evidence_ids: list[uuid.UUID],
    note: str | None,
) -> dict:
    c = contractor_of(conn, pr)
    v = conn.execute(select(contractor_visit).where(contractor_visit.c.id == visit_id)).mappings().first()
    # Another contractor's visit looks the same as one that doesn't exist.
    if not v or v["contractor_id"] != c["id"]:
        raise problem(404, "not_found", "Not found.")
    if v["status"] == "done":
        raise problem(409, "done", "This visit is already done.")
    return _send(
        conn,
        pr,
        actor,
        c,
        kind="report",
        property_id=v["property_id"],
        what=f"{v['purpose']} report",
        evidence_ids=evidence_ids,
        note=note,
        visit_id=visit_id,
    )


def send_fix(
    conn: Connection,
    pr: Principal,
    actor: audit.Actor,
    action_id: uuid.UUID,
    evidence_ids: list[uuid.UUID],
    note: str | None,
) -> dict:
    c = contractor_of(conn, pr)
    a = conn.execute(select(action).where(action.c.id == action_id)).mappings().first()
    if not a or a["owner_contractor_id"] != c["id"]:
        raise problem(404, "not_found", "Not found.")
    if a["status"] == "closed":
        raise problem(409, "closed", "This is already closed.")
    return _send(
        conn,
        pr,
        actor,
        c,
        kind="fix",
        property_id=a["property_id"],
        what=f"{a['ref']} fix",
        evidence_ids=evidence_ids,
        note=note,
        action_id=action_id,
        entity_ref=a["ref"],
    )


# ---------------------------------------------------------------------------------------------------------------------
# Staff: the "From contractors" queue in Evidence review
# ---------------------------------------------------------------------------------------------------------------------


def _upload_rows(conn: Connection, pr: Principal, property_id: uuid.UUID | None, upload_id: uuid.UUID | None = None):
    q = (
        select(
            contractor_upload,
            contractor.c.name.label("contractor"),
            person.c.name.label("sent_by"),
            property_.c.name.label("property"),
            contractor_visit.c.purpose,
            contractor_visit.c.visit_on,
            contractor_visit.c.register_item_id,
            action.c.ref.label("action_ref"),
            action.c.description,
            action.c.priority,
            action.c.due_on,
            action.c["class"].label("klass"),
        )
        .join(contractor, contractor.c.id == contractor_upload.c.contractor_id)
        .join(person, person.c.id == contractor_upload.c.person_id)
        .join(property_, property_.c.id == contractor_upload.c.property_id)
        .outerjoin(contractor_visit, contractor_visit.c.id == contractor_upload.c.contractor_visit_id)
        .outerjoin(action, action.c.id == contractor_upload.c.action_id)
        .where(scope_filter(pr, contractor_upload.c.property_id))
    )
    if upload_id:
        q = q.where(contractor_upload.c.id == upload_id)
    else:
        q = q.where(contractor_upload.c.status == "pending")
    if property_id:
        q = q.where(contractor_upload.c.property_id == property_id)
    return [dict(r) for r in conn.execute(q.order_by(contractor_upload.c.created_at)).mappings()]


def _item_ref(conn: Connection, register_item_id: uuid.UUID | None) -> str | None:
    return action_service.item_ref(conn, register_item_id)


def _title(r: dict) -> str:
    return f"Report: {r['purpose']}" if r["kind"] == "report" else fix_title(r["description"] or "")


def _when(dt) -> str:
    d = clock.london(dt).date()
    return f"today {clock.london(dt):%H:%M}" if d == clock.today() else fmt_day(d)


def pending_cards(conn: Connection, pr: Principal, property_id: uuid.UUID | None) -> list[dict]:
    """Queue cards in the same shape as the other Evidence review queues."""
    if not pr.can("verify"):
        return []
    out = []
    for r in _upload_rows(conn, pr, property_id):
        if not pr.can("verify", r["property_id"]):
            continue
        out.append(
            {
                "id": str(r["id"]),
                "ref": r["action_ref"] or _item_ref(conn, r["register_item_id"]) or "Visit",
                "class": r["klass"],
                "title": _title(r),
                "detail": f"{r['property']} · {r['contractor']} · {_when(r['created_at'])}",
                "badge": "Report" if r["kind"] == "report" else "Fix to check",
                "badge_tone": "blue",
                "kind": "contractor",
            }
        )
    return out


def detail(conn: Connection, pr: Principal, upload_id: uuid.UUID) -> dict:
    rows = _upload_rows(conn, pr, None, upload_id)
    if not rows:
        raise problem(404, "not_found", "Not found.")
    r = rows[0]
    pr.require("verify", r["property_id"])
    ids = [uuid.UUID(i) for i in r["evidence_ids"]]
    evs = {e["id"]: e for e in conn.execute(select(evidence).where(evidence.c.id.in_(ids))).mappings()} if ids else {}
    files = [ev_service.view(dict(evs[i])) for i in ids if i in evs]
    reviewer = (
        conn.execute(select(person.c.name).where(person.c.id == r["reviewed_by"])).scalar()
        if r["reviewed_by"]
        else None
    )
    if r["kind"] == "report":
        subtitle = f"{r['property']} · visit {fmt_day(r['visit_on'])}"
        what = "Approve to mark the visit done" + (" and file the certificate." if r["register_item_id"] else ".")
    else:
        subtitle = (
            f"{r['property']} · {action_rules.PRIORITY_LABEL[r['priority']]} · due {fmt_date(r['due_on'])}"
            if r["priority"]
            else r["property"]
        )
        what = "Approve to close the Action with this photo as its closing evidence."
    can = r["status"] == "pending" and (r["kind"] == "report" or pr.can("action.close", r["property_id"]))
    return {
        "id": str(r["id"]),
        "kind": r["kind"],
        "status": r["status"],
        "ref": r["action_ref"] or _item_ref(conn, r["register_item_id"]),
        "class": r["klass"],
        "title": _title(r),
        "subtitle": subtitle,
        "description": r["description"],
        "contractor": r["contractor"],
        "sent_by": r["sent_by"],
        "sent_at": r["created_at"],
        "note": r["note"],
        "files": files,
        "on_approve": what,
        "can_decide": can,
        "review": {"by": reviewer, "at": r["reviewed_at"], "comment": r["review_comment"]}
        if r["reviewed_by"]
        else None,
    }


def decide(
    conn: Connection, pr: Principal, actor: audit.Actor, upload_id: uuid.UUID, result: str, comment: str | None
) -> dict:
    if result not in ("approved", "rejected"):
        raise problem(422, "result", "Unknown result.")
    up = conn.execute(select(contractor_upload).where(contractor_upload.c.id == upload_id)).mappings().first()
    if not up:
        raise problem(404, "not_found", "Not found.")
    pr.require_property(up["property_id"])
    pr.require("verify", up["property_id"])
    if up["kind"] == "fix":
        pr.require("action.close", up["property_id"])
    if up["status"] != "pending":
        raise problem(409, "decided", "This has already been checked.")
    comment = (comment or "").strip() or None
    if result == "rejected" and not comment:
        raise problem(422, "comment", "Say what's wrong so the contractor can put it right.")
    cname = conn.execute(select(contractor.c.name).where(contractor.c.id == up["contractor_id"])).scalar()
    ids = [uuid.UUID(i) for i in up["evidence_ids"]]
    cert_id = None
    ref = None
    if result == "approved" and up["kind"] == "report":
        v = (
            conn.execute(select(contractor_visit).where(contractor_visit.c.id == up["contractor_visit_id"]))
            .mappings()
            .one()
        )
        conn.execute(
            update(contractor_visit)
            .where(contractor_visit.c.id == v["id"])
            .values(status="done", evidence_id=ids[0] if ids else None)
        )
        if v["register_item_id"]:
            ri = (
                conn.execute(
                    select(register_item.c.ref, template.c.name, template.c.default_frequency)
                    .join(template, template.c.id == register_item.c.template_id)
                    .where(register_item.c.id == v["register_item_id"])
                )
                .mappings()
                .one()
            )
            ref = ri["ref"]
            f = freq.get(ri["default_frequency"])
            cert_id = uuid.uuid4()
            conn.execute(
                certificate.insert().values(
                    id=cert_id,
                    property_id=v["property_id"],
                    register_item_id=v["register_item_id"],
                    type="visit",
                    title=ri["name"],
                    issuer=cname,
                    contractor_id=up["contractor_id"],
                    issued_on=v["visit_on"],
                    expires_on=(v["visit_on"] + f.interval) if f.interval else None,
                    evidence_id=ids[0] if ids else None,
                    contractor_visit_id=v["id"],
                    filing="filed",
                )
            )
            refresh_item(conn, v["register_item_id"])
    elif result == "approved":
        ref = conn.execute(select(action.c.ref).where(action.c.id == up["action_id"])).scalar()
        action_service.close(
            conn,
            actor,
            up["action_id"],
            evidence_ids=ids,
            decision=None,
            decision_reason=None,
            note=f"Fixed by {cname}; photo checked by {pr.name}",
        )
    conn.execute(
        update(contractor_upload)
        .where(contractor_upload.c.id == upload_id)
        .values(
            status=result,
            reviewed_by=pr.person_id,
            reviewed_at=clock.now(),
            review_comment=comment,
            certificate_id=cert_id,
        )
    )
    what = "report" if up["kind"] == "report" else "fix"
    audit.record(
        conn,
        actor,
        category="verification",
        action=f"contractor.{what}_{result}",
        summary=f"{'Approved' if result == 'approved' else 'Sent back'} {cname}'s {what}"
        + (f" ({ref})" if ref else "")
        + (f": {comment}" if comment and result == "rejected" else ""),
        entity_type="contractor_upload",
        entity_id=upload_id,
        entity_ref=ref,
        property_id=up["property_id"],
        before={"status": "pending"},
        after={"status": result, "comment": comment},
    )
    notify.notify(
        conn,
        {up["person_id"]},
        kind="contractor.checked",
        title=f"Your {what} was {'accepted' if result == 'approved' else 'sent back'}",
        body=comment,
        link="/contractor",
    )
    return {"status": result, "certificate_id": str(cert_id) if cert_id else None}


def fix_status(conn: Connection, action_ids: list[uuid.UUID]) -> dict[uuid.UUID, dict]:
    """The latest contractor fix on each Action, for the Actions list and side sheet (awaiting verification)."""
    if not action_ids:
        return {}
    out: dict[uuid.UUID, dict] = {}
    for r in conn.execute(
        select(contractor_upload, contractor.c.name.label("contractor"))
        .join(contractor, contractor.c.id == contractor_upload.c.contractor_id)
        .where(contractor_upload.c.kind == "fix", contractor_upload.c.action_id.in_(action_ids))
        .order_by(contractor_upload.c.created_at)
    ).mappings():
        out[r["action_id"]] = dict(r)
    return out


def fix_view(r: dict | None) -> dict | None:
    if not r:
        return None
    return {
        "upload_id": str(r["id"]),
        "status": r["status"],
        "contractor": r["contractor"],
        "sent_at": r["created_at"],
        "sent_on": fmt_date(clock.london(r["created_at"]).date()),
        "note": r["note"],
        "review_comment": r["review_comment"],
    }
