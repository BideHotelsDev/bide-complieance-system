"""A property's register (design: One property) and one register item's detail, assignment and certificates."""

import uuid
from datetime import date, timedelta

from fastapi import APIRouter, Query, Request
from pydantic import BaseModel
from sqlalchemy import Connection, func, select, update

from bide_comply import audit, clock
from bide_comply.api import listing
from bide_comply.auth import Current, actor_for
from bide_comply.authz import Principal
from bide_comply.db import ConnDep
from bide_comply.engine import frequency as freq
from bide_comply.schema import (
    action,
    alarm_event,
    approval_request,
    audit_event,
    certificate,
    contractor,
    domain,
    evidence,
    person,
    pool,
    property_,
    register_item,
    submission,
    submission_evidence,
    task,
    template,
)
from bide_comply.services import actions as action_service
from bide_comply.services import checks
from bide_comply.services import evidence as ev_service
from bide_comply.services.common import check_named, fmt_date, names, problem
from bide_comply.services.register import cancel_future, refresh_item

router = APIRouter(prefix="/api", tags=["register"])

STATUS_LABEL = {"green": "Green", "amber": "Amber", "red": "Red", "grey": "Grey"}
CLASS_LABEL = {"A": "Life safety", "B": "Statutory", "C": "bide standard"}


def resolve_property(conn: Connection, pr: Principal, key: str) -> dict:
    try:
        cond = property_.c.id == uuid.UUID(key)
    except ValueError:
        cond = property_.c.code == key.upper()
    p = conn.execute(select(property_).where(cond)).mappings().first()
    if not p:
        raise problem(404, "not_found", "Not found.")
    pr.require_property(p["id"])
    return dict(p)


def _doer(r: dict, who: dict, pools: dict, cons: dict) -> str | None:
    k = r["done_by_kind"]
    if k == "person":
        return who.get(r["done_by_person_id"])
    if k == "pool":
        return pools.get(r["done_by_pool_id"])
    if k == "contractor":
        return cons.get(r["done_by_contractor_id"])
    return None


def _next_due_label(r: dict, today: date) -> str:
    if r["status"] == "grey":
        return r["state_reason"] or "Not applicable"
    if (
        r["status"] == "red"
        and r["status_reason"] in ("overdue", "missed", "no record", "unsigned")
        and (r["next_due_on"] is None or r["next_due_on"] < today)
    ):
        return "Overdue"
    d = r["next_due_on"]
    if d is None:
        return "—"
    if d == today:
        return "Today"
    return fmt_date(d, True)


def _last_done_label(r: dict) -> str:
    if r["status"] == "grey":
        return "—"
    if r["last_done_on"]:
        return fmt_date(r["last_done_on"], True)
    if r["status_reason"] == "unsigned":
        return "Unsigned"
    if r["kind"] == "certificate":
        return "None found" if "assessment" in r["name"].lower() else "No record"
    return "No record"


def register_rows(conn: Connection, property_id: uuid.UUID) -> list[dict]:
    rows = [
        dict(r)
        for r in conn.execute(
            select(
                register_item,
                template.c.name,
                template.c["class"].label("klass"),
                template.c.kind,
                template.c.default_frequency,
                template.c.frequency_note,
                template.c.legal_basis,
                domain.c.key.label("domain_key"),
                domain.c.name.label("domain"),
                domain.c.sort.label("domain_sort"),
            )
            .join(template, template.c.id == register_item.c.template_id)
            .join(domain, domain.c.id == template.c.domain_id)
            .where(register_item.c.property_id == property_id, register_item.c.state != "draft")
        ).mappings()
    ]
    who = names(
        conn,
        {r["done_by_person_id"] for r in rows} | {r["accountable_id"] for r in rows} | {r["cover_id"] for r in rows},
    )
    pools = {r.id: r.name for r in conn.execute(select(pool.c.id, pool.c.name))}
    cons = {r.id: r.name for r in conn.execute(select(contractor.c.id, contractor.c.name))}
    pending = set(
        conn.execute(
            select(approval_request.c.register_item_id).where(
                approval_request.c.status == "waiting", approval_request.c.kind.in_(("switch_off", "pause"))
            )
        ).scalars()
    )
    latest_files = {}
    for r in conn.execute(
        select(certificate.c.register_item_id, evidence.c.file_name, evidence.c.id)
        .join(evidence, evidence.c.id == certificate.c.evidence_id)
        .where(certificate.c.property_id == property_id, certificate.c.filing == "filed")
        .order_by(certificate.c.issued_on)
    ):
        latest_files[r.register_item_id] = {"id": str(r.id), "name": r.file_name}
    today = clock.today()
    out = []
    for r in rows:
        doer = _doer(r, who, pools, cons)
        f = r["frequency"] or r["default_frequency"]
        status_label = STATUS_LABEL[r["status"]] + (" · fail open" if r["status_reason"] == "fail open" else "")
        out.append(
            {
                "id": str(r["id"]),
                "ref": r["ref"],
                "check": r["name"],
                "class": r["klass"],
                "kind": r["kind"],
                "domain": r["domain"],
                "domain_key": r["domain_key"],
                "domain_sort": r["domain_sort"],
                "status": r["status"],
                "status_reason": r["status_reason"],
                "status_label": status_label,
                "next_due_on": r["next_due_on"],
                "next_due_label": _next_due_label({**r}, today),
                "done_by": doer or ("—" if r["status"] == "grey" else "Needs a name"),
                "done_by_kind": r["done_by_kind"],
                "accountable": who.get(r["accountable_id"]),
                "cover": who.get(r["cover_id"]),
                "frequency": f,
                "frequency_label": r["frequency_note"] if r["frequency_note"] and not r["frequency"] else freq.label(f),
                "frequency_overridden": bool(r["frequency"]),
                "last_done_on": r["last_done_on"],
                "last_done_label": _last_done_label({**r, "name": r["name"]}),
                "evidence": latest_files.get(r["id"]),
                "needs_owner": r["needs_owner"] or not r["accountable_id"],
                "state": r["state"],
                "switch_off_pending": r["id"] in pending,
            }
        )
    return out


@router.get("/properties/{key}/register")
def property_register(
    key: str,
    pr: Current,
    conn: ConnDep,
    q: str | None = None,
    view: str = "attention",
    status: list[str] | None = Query(None),
    area: list[str] | None = Query(None),
    doneby: list[str] | None = Query(None),
    klass: list[str] | None = Query(None, alias="class"),
    sort: str = "next_due",
    group: str = "area",
    page: int = 1,
    page_size: int = 100,
) -> dict:
    p = resolve_property(conn, pr, key)
    rows = register_rows(conn, p["id"])
    today = clock.today()
    week_end = today + timedelta(days=6 - today.weekday())
    views = [
        listing.View("all", "Everything", lambda r: True),
        listing.View(
            "attention",
            "Needs attention",
            lambda r: r["status"] in ("red", "amber"),
            suffix=" that are overdue or due soon",
        ),
        listing.View(
            "week",
            "Due this week",
            lambda r: (
                r["status"] != "grey"
                and (r["next_due_label"] == "Overdue" or (r["next_due_on"] and r["next_due_on"] <= week_end))
            ),
            suffix=" due this week",
        ),
        listing.View("life", "Life safety", lambda r: r["class"] == "A", phrase="life-safety "),
        listing.View("certs", "Certificates", lambda r: r["kind"] == "certificate", phrase="certificate "),
    ]
    domains = sorted({(r["domain_key"], r["domain"], r["domain_sort"]) for r in rows}, key=lambda d: d[2])
    doers = sorted({r["done_by"] for r in rows if r["done_by"] not in ("—",)})
    facets = [
        listing.Facet(
            "status",
            "Status",
            lambda r: r["status"],
            [("red", "Overdue"), ("amber", "Due soon"), ("green", "In date"), ("grey", "Not applicable")],
            hint="Show items that are",
        ),
        listing.Facet("area", "Area", lambda r: r["domain_key"], [(d[0], d[1]) for d in domains], hint="Show items in"),
        listing.Facet("doneby", "Done by", lambda r: r["done_by"], [(d, d) for d in doers], hint="Show items done by"),
        listing.Facet(
            "class",
            "Class",
            lambda r: r["class"],
            [("A", "A · Life safety"), ("B", "B · Statutory"), ("C", "C · bide standard")],
            hint="Show",
        ),
    ]
    sorts = {
        "next_due": (
            lambda r: (r["next_due_label"] != "Overdue", r["next_due_on"] or date.max, r["ref"]),
            False,
            "Soonest due first.",
        ),
        "ref": (lambda r: r["ref"], False, "By ID."),
        "status": (
            lambda r: ({"red": 0, "amber": 1, "green": 2, "grey": 3}[r["status"]], r["ref"]),
            False,
            "Worst first.",
        ),
    }
    sk, rev, phrase = sorts.get(sort, sorts["next_due"])
    if group == "area":
        base = sk
        sk = lambda r: (r["domain_sort"], base(r))  # noqa: E731
        phrase = "Grouped by area. " + phrase
    res = listing.run(
        rows,
        q=q,
        search=lambda r: f"{r['ref']} {r['check']} {r['done_by']} {r['accountable'] or ''}",
        views=views,
        view=view,
        facets=facets,
        selected={
            "status": listing.multi(status),
            "area": listing.multi(area),
            "doneby": listing.multi(doneby),
            "class": listing.multi(klass),
        },
        sort=sk,
        reverse=rev,
        page=page,
        page_size=page_size,
        noun=("check", "checks"),
        where=f"at {p['name']}",
        order_phrase=phrase,
    )
    groups = []
    if group == "area":
        for d in domains:
            in_group = [r for r in res.rows if r["domain_key"] == d[0]]
            if in_group:
                all_in = [r for r in rows if r["domain_key"] == d[0]]
                groups.append(
                    {
                        "key": d[0],
                        "name": d[1],
                        "count": len(all_in),
                        "red": sum(1 for r in all_in if r["status"] == "red"),
                        "rows": in_group,
                    }
                )
    out = res.dump()
    out["groups"] = groups
    out["of_total"] = len(rows)
    return out


@router.get("/register/{ref}")
def register_detail(ref: str, pr: Current, conn: ConnDep) -> dict:
    r = (
        conn.execute(
            select(
                register_item,
                template.c.name,
                template.c["class"].label("klass"),
                template.c.kind,
                template.c.legal_basis,
                template.c.guidance,
                template.c.default_frequency,
                template.c.frequency_note,
                template.c.current_version,
                domain.c.name.label("domain"),
                property_.c.name.label("property"),
                property_.c.code,
            )
            .join(template, template.c.id == register_item.c.template_id)
            .join(domain, domain.c.id == template.c.domain_id)
            .join(property_, property_.c.id == register_item.c.property_id)
            .where(register_item.c.ref == ref.upper())
        )
        .mappings()
        .first()
    )
    if not r:
        raise problem(404, "not_found", "Not found.")
    pr.require_property(r["property_id"])
    row = next(x for x in register_rows(conn, r["property_id"]) if x["ref"] == r["ref"])
    who = names(conn, {r["accountable_id"], r["cover_id"], r["verifier_id"]})
    today = clock.today()
    f = r["frequency"] or r["default_frequency"]
    wd = freq.warning_days(f, r["kind"], None)
    certs = [
        dict(c)
        for c in conn.execute(
            select(certificate, evidence.c.file_name, evidence.c.created_at.label("filed_at"))
            .outerjoin(evidence, evidence.c.id == certificate.c.evidence_id)
            .where(certificate.c.register_item_id == r["id"])
            .order_by(certificate.c.issued_on.desc().nulls_last())
        ).mappings()
    ]
    subs = [
        dict(s)
        for s in conn.execute(
            select(
                submission.c.id,
                submission.c.work_done_on,
                submission.c.result,
                submission.c.server_time,
                submission.c.file_name,
                submission.c.flags,
                person.c.name.label("by"),
                task.c.status,
            )
            .join(task, task.c.id == submission.c.task_id)
            .join(person, person.c.id == submission.c.submitter_id)
            .where(task.c.register_item_id == r["id"])
            .order_by(submission.c.server_time.desc())
            .limit(10)
        ).mappings()
    ]
    evid = []
    for c in certs:
        if c["evidence_id"]:
            evid.append(
                {
                    "id": str(c["evidence_id"]),
                    "name": c["file_name"],
                    "kind": "pdf",
                    "detail": f"Filed {fmt_date(c['issued_on'])}"
                    + (f" · includes {c['fail_count']} fail report" if c["fail_count"] else ""),
                }
            )
    for s in subs[:3]:
        n = conn.execute(select(func.count()).where(submission_evidence.c.submission_id == s["id"])).scalar()
        evid.append(
            {
                "id": str(s["id"]),
                "name": s["file_name"],
                "kind": "submission",
                "detail": f"{s['by']} · {fmt_date(s['work_done_on'])} · {n} photo{'s' if n != 1 else ''} · {s['result'].capitalize()}",
            }
        )
    linked = [
        action_service.view_row(conn, dict(a))
        for a in conn.execute(
            select(action)
            .where(action.c.register_item_id == r["id"])
            .order_by(action.c.status == "closed", action.c.due_on)
        ).mappings()
    ]
    hist = [
        {"at": h.at, "text": h.summary, "who": h.actor_label}
        for h in conn.execute(
            select(audit_event.c.at, audit_event.c.summary, audit_event.c.actor_label)
            .where(audit_event.c.entity_ref == r["ref"])
            .order_by(audit_event.c.seq.desc())
            .limit(20)
        )
    ]
    for a in linked:
        hist.append(
            {
                "at": None,
                "date": a["raised_on"],
                "text": f"Action {a['ref']} raised from {a['source_label'][:1].lower()}{a['source_label'][1:]}",
                "who": None,
            }
        )
    for c in certs:
        if c["issued_on"] and c["filing"] == "filed":
            hist.append({"at": None, "date": c["issued_on"], "text": f"{c['title']} report filed", "who": None})
    if r["import_label"]:
        hist.append({"at": None, "date": None, "text": "Imported from BH-CMP-001 register", "who": "Day one load"})
    blocked = None
    open_fail = [a for a in linked if a["status"] != "closed" and a["type"] != "advisory"]
    if open_fail and r["status"] == "red":
        a = open_fail[0]
        blocked = {
            "text": f"This item cannot go Green until {a['ref']} is closed with evidence.",
            "action_ref": a["ref"],
            "certificate_fail": bool(certs and certs[0]["fail_count"]),
        }
    amber_from = (r["next_due_on"] - timedelta(days=wd)) if r["next_due_on"] else None
    return {
        **row,
        "property": r["property"],
        "property_code": r["code"],
        "property_id": str(r["property_id"]),
        "domain": r["domain"],
        "class_label": CLASS_LABEL[r["klass"]],
        "kind_label": {
            "check": "Check",
            "cleaning": "Cleaning check",
            "certificate": "Certificate",
            "staff": "Staff",
            "contractor_visit": "Contractor visit",
        }[r["kind"]],
        "legal_basis": r["legal_basis"],
        "guidance": r["guidance"],
        "template_id": str(r["template_id"]),
        "template_version": r["current_version"],
        "accountable": who.get(r["accountable_id"]),
        "accountable_id": str(r["accountable_id"]) if r["accountable_id"] else None,
        "cover": who.get(r["cover_id"]),
        "cover_id": str(r["cover_id"]) if r["cover_id"] else None,
        "verifier": who.get(r["verifier_id"]),
        "verifier_mode": r["verifier_mode"],
        "frequency_reason": r["frequency_reason"],
        "next_due_text": (
            f"{fmt_date(r['next_due_on'], True)}"
            + (f" · Amber from {fmt_date(amber_from)}" if amber_from and amber_from > today else "")
        )
        if r["next_due_on"]
        else row["next_due_label"],
        "blocked": blocked,
        "evidence": evid,
        "actions": linked,
        "history": hist,
        "certificates": [
            {
                "id": str(c["id"]),
                "title": c["title"],
                "issued_on": c["issued_on"],
                "expires_on": c["expires_on"],
                "fail_count": c["fail_count"],
                "filing": c["filing"],
            }
            for c in certs
        ],
        "can_assign": pr.can("assign", r["property_id"]),
        "can_toggle": pr.can("register.toggle", r["property_id"]),
        "notes": r["notes"],
    }


@router.get("/register/{ref}/assign-options")
def assign_options(ref: str, pr: Current, conn: ConnDep) -> dict:
    """Named people, pools and contractors for the reassign dialog (golden rule: no generic names)."""
    r = conn.execute(select(register_item).where(register_item.c.ref == ref.upper())).mappings().first()
    if not r:
        raise problem(404, "not_found", "Not found.")
    pr.require_property(r["property_id"])
    pr.require("assign", r["property_id"])
    ppl = conn.execute(
        select(person.c.id, person.c.name, person.c.title)
        .where(person.c.employment_status == "active")
        .order_by(person.c.name)
    ).all()
    pools = conn.execute(
        select(pool.c.id, pool.c.name).where(pool.c.property_id == r["property_id"]).order_by(pool.c.name)
    ).all()
    cons = conn.execute(
        select(contractor.c.id, contractor.c.name, contractor.c.trade)
        .where(contractor.c.active.is_(True))
        .order_by(contractor.c.name)
    ).all()
    return {
        "people": [{"id": str(x.id), "name": x.name, "sub": x.title} for x in ppl],
        "pools": [{"id": str(x.id), "name": x.name, "sub": None} for x in pools],
        "contractors": [{"id": str(x.id), "name": x.name, "sub": x.trade} for x in cons],
    }


class AssignIn(BaseModel):
    done_by_kind: str | None = None  # person | pool | contractor
    done_by_id: uuid.UUID | None = None
    done_by_text: str | None = None  # for validation only: "TBC" typed in is rejected
    accountable_id: uuid.UUID | None = None
    cover_id: uuid.UUID | None = None
    verifier_mode: str | None = None
    verifier_id: uuid.UUID | None = None
    frequency: str | None = None
    frequency_reason: str | None = None
    location_id: uuid.UUID | None = None
    notes: str | None = None
    clear: list[str] = []


@router.patch("/register/{ref}")
def assign(ref: str, body: AssignIn, request: Request, pr: Current, conn: ConnDep) -> dict:
    r = conn.execute(select(register_item).where(register_item.c.ref == ref.upper())).mappings().first()
    if not r:
        raise problem(404, "not_found", "Not found.")
    pr.require_property(r["property_id"])
    pr.require("assign", r["property_id"])
    if body.done_by_text is not None:
        check_named(body.done_by_text)
    vals: dict = {}
    if body.done_by_kind:
        if body.done_by_kind not in ("person", "pool", "contractor") or not body.done_by_id:
            raise problem(422, "generic_name", "Choose a person, pool or contractor for Done by.")
        vals |= {
            "done_by_kind": body.done_by_kind,
            "done_by_person_id": None,
            "done_by_pool_id": None,
            "done_by_contractor_id": None,
            f"done_by_{body.done_by_kind}_id": body.done_by_id,
        }
    for k in ("accountable_id", "cover_id", "verifier_id", "location_id"):
        v = getattr(body, k)
        if v is not None:
            vals[k] = v
    if (
        body.cover_id
        and body.cover_id == pr.person_id
        and r["accountable_id"] != pr.person_id
        and not pr.has_role("system_owner")
    ):
        # Site leads can reassign at their property but can't set themselves as cover (approve own cover).
        if pr.has_role("site_lead", r["property_id"]) and not pr.is_admin:
            raise problem(403, "own_work", "You can't set up your own cover. Ask the system owner.")
    if body.accountable_id and conn.execute(select(pool.c.id).where(pool.c.id == body.accountable_id)).first():
        raise problem(422, "accountable_pool", "Only people can be accountable, not pools.")
    if body.verifier_mode:
        vals["verifier_mode"] = body.verifier_mode
    if body.frequency:
        freq.get(body.frequency)
        if not (body.frequency_reason and body.frequency_reason.strip()):
            raise problem(
                422, "frequency_reason", "A frequency change needs the FRA section or assessor decision that set it."
            )
        vals |= {"frequency": body.frequency, "frequency_reason": body.frequency_reason}
    if body.notes is not None:
        vals["notes"] = body.notes
    for k in body.clear:
        if k in ("cover_id", "verifier_id", "frequency"):
            vals[k] = None
    if not vals:
        return {"ok": True}
    after = {**dict(r), **vals}
    vals["needs_owner"] = not (after["accountable_id"] and after["done_by_kind"])
    conn.execute(update(register_item).where(register_item.c.id == r["id"]).values(**vals))
    before_d, after_d = audit.diff(dict(r), after)
    who = names(conn, {v for v in list(before_d.values()) + list(after_d.values()) if isinstance(v, uuid.UUID)})
    fmt = lambda d: {k: who.get(v, v) if isinstance(v, uuid.UUID) else v for k, v in d.items()}  # noqa: E731
    audit.record(
        conn,
        actor_for(request, pr),
        category="record",
        action="register.assign",
        summary="Changed who does a check"
        if any(k.startswith("done_by") or k in ("accountable_id", "cover_id") for k in after_d)
        else "Changed a check's plan",
        entity_type="register_item",
        entity_id=r["id"],
        entity_ref=r["ref"],
        property_id=r["property_id"],
        before=fmt(before_d),
        after=fmt(after_d),
    )
    if "frequency" in vals or "done_by_kind" in vals:
        cancel_future(conn, r["id"])
    refresh_item(conn, r["id"])
    return {"ok": True}


class RequestIn(BaseModel):
    kind: str  # switch_off | pause | na
    reason: str
    note: str | None = None
    until: date | None = None


@router.post("/register/{ref}/request")
def request_change(ref: str, body: RequestIn, request: Request, pr: Current, conn: ConnDep) -> dict:
    r = conn.execute(select(register_item).where(register_item.c.ref == ref.upper())).mappings().first()
    if not r:
        raise problem(404, "not_found", "Not found.")
    if body.kind not in ("switch_off", "pause"):
        raise problem(422, "kind", "Unknown request.")
    if not (pr.can("register.request_toggle", r["property_id"]) or pr.can("register.toggle", r["property_id"])):
        raise problem(403, "forbidden", "You can't change what is checked here.")
    return checks.request_exception(
        conn,
        pr,
        actor_for(request, pr),
        kind=body.kind,
        reason=body.reason,
        note=body.note,
        register_item_id=r["id"],
        payload={"until": body.until.isoformat()} if body.until else {},
    )


class CertificateIn(BaseModel):
    evidence_id: uuid.UUID
    issued_on: date
    expires_on: date | None = None
    issuer: str | None = None
    fails: list[dict] = []  # [{text, priority}]: each fail becomes an Action (DOC-07)


@router.post("/register/{ref}/certificate")
def file_certificate(ref: str, body: CertificateIn, request: Request, pr: Current, conn: ConnDep) -> dict:
    r = (
        conn.execute(
            select(register_item, template.c.name, template.c["class"].label("klass"))
            .join(template, template.c.id == register_item.c.template_id)
            .where(register_item.c.ref == ref.upper())
        )
        .mappings()
        .first()
    )
    if not r:
        raise problem(404, "not_found", "Not found.")
    pr.require_property(r["property_id"])
    pr.require("assign", r["property_id"])
    ev = ev_service.stored(conn, [body.evidence_id], pr.person_id)
    if not ev:
        raise problem(422, "evidence", "The file didn't finish uploading. Try again.")
    if body.expires_on and body.expires_on <= body.issued_on:
        raise problem(422, "dates", "The expiry date must be after the issue date.")
    old = (
        conn.execute(
            select(certificate.c.id).where(
                certificate.c.register_item_id == r["id"],
                certificate.c.filing == "filed",
                certificate.c.superseded_by.is_(None),
            )
        )
        .scalars()
        .all()
    )
    cid = uuid.uuid4()
    conn.execute(
        certificate.insert().values(
            id=cid,
            property_id=r["property_id"],
            register_item_id=r["id"],
            type="register",
            title=r["name"],
            issuer=body.issuer,
            issued_on=body.issued_on,
            expires_on=body.expires_on,
            evidence_id=body.evidence_id,
            filing="filed",
            fail_count=len(body.fails),
        )
    )
    for o in old:
        conn.execute(update(certificate).where(certificate.c.id == o).values(superseded_by=cid))
    conn.execute(
        update(evidence)
        .where(evidence.c.id == body.evidence_id)
        .values(
            file_name=f"{r['ref']} {r['name'][:60]} - {body.issuer or 'Contractor'} - {body.issued_on.isoformat()}.pdf"
        )
    )
    actor = actor_for(request, pr)
    audit.record(
        conn,
        actor,
        category="check",
        action="certificate.file",
        summary=f"Filed a new certificate for {r['ref']}",
        entity_type="certificate",
        entity_id=cid,
        entity_ref=r["ref"],
        property_id=r["property_id"],
        after={"issued_on": body.issued_on, "expires_on": body.expires_on, "fails": len(body.fails)},
    )
    for f in body.fails:
        action_service.raise_action(
            conn,
            actor,
            property_id=r["property_id"],
            description=f["text"],
            source="certificate_fail",
            source_ref=f"Certificate {r['ref']}",
            priority=f.get("priority") or None,
            klass=r["klass"],
            register_item_id=r["id"],
            certificate_id=cid,
        )
    # Uploading a certificate closes its linked "missing certificate" Action only if it has no fails.
    if not body.fails:
        for req in conn.execute(
            select(certificate).where(certificate.c.register_item_id == r["id"], certificate.c.filing != "filed")
        ).mappings():
            conn.execute(
                update(certificate).where(certificate.c.id == req["id"]).values(filing="filed", superseded_by=cid)
            )
    refresh_item(conn, r["id"])
    return {"id": str(cid)}


@router.get("/properties/{key}/alarm-events")
def alarm_events(key: str, pr: Current, conn: ConnDep) -> dict:
    p = resolve_property(conn, pr, key)
    rows = (
        conn.execute(
            select(alarm_event, action.c.ref.label("action_ref"))
            .outerjoin(action, action.c.id == alarm_event.c.action_id)
            .where(alarm_event.c.property_id == p["id"])
            .order_by(alarm_event.c.occurred_at.desc())
        )
        .mappings()
        .all()
    )
    causes: dict[str, int] = {}
    for r in rows:
        if r["false_alarm"] and r["occurred_at"] >= clock.now() - timedelta(days=90):
            causes[r["cause"] or "Unknown"] = causes.get(r["cause"] or "Unknown", 0) + 1
    return {
        "rows": [
            {
                "id": str(r["id"]),
                "occurred_at": r["occurred_at"],
                "zone": r["zone"],
                "cause": r["cause"],
                "false_alarm": r["false_alarm"],
                "arc_response": r["arc_response"],
                "attended_minutes": r["keyholder_attended_minutes"],
                "action_ref": r["action_ref"],
            }
            for r in rows
        ],
        "causes": [{"cause": k, "count": v, "review": v >= 3} for k, v in sorted(causes.items(), key=lambda x: -x[1])],
    }
