"""Settings › Compliance library and Check form builder (CMS-01..04, CMS-09, CMS-10, §3 Versioning)."""

import uuid

from fastapi import APIRouter, Query, Request
from pydantic import BaseModel
from sqlalchemy import func, select, update

from bide_comply import audit, clock
from bide_comply.api import listing
from bide_comply.auth import Current, actor_for
from bide_comply.db import ConnDep
from bide_comply.engine import forms
from bide_comply.engine import frequency as freq
from bide_comply.schema import class_weight, domain, register_item, task, template, template_version, warning_window
from bide_comply.services.common import fmt_date, names, problem
from bide_comply.services.register import cancel_future, recompute_item, refresh_item, retarget_version

router = APIRouter(prefix="/api/library", tags=["library"])

KIND_LABEL = {
    "check": "Check",
    "cleaning": "Cleaning check",
    "certificate": "Certificate",
    "staff": "Staff",
    "contractor_visit": "Contractor visit",
}
# Rule fields that change when tasks fall due: a change replans future tasks at every property using the template.
SCHEDULE_FIELDS = ("default_frequency", "due_time", "window_hours", "late_rule", "lead_days")
RULE_FIELDS = (
    "name",
    "domain_id",
    "class",
    "kind",
    "default_frequency",
    "warning_days",
    "lead_days",
    "due_time",
    "window_hours",
    "late_rule",
    "verification",
    "sample_rate",
    "legal_basis",
    "legal_link",
    "guidance",
    "applies_to",
    "applies_note",
    "geofence_required",
    "qr_required",
    "typical_minutes",
    "retention_category",
    "frequency_note",
    "done_by_hint",
)


def _used_at(conn) -> dict:
    return dict(
        conn.execute(
            select(register_item.c.template_id, func.count(func.distinct(register_item.c.property_id)))
            .where(register_item.c.state == "on")
            .group_by(register_item.c.template_id)
        ).all()
    )


@router.get("")
def list_templates(
    pr: Current,
    conn: ConnDep,
    q: str | None = None,
    area: str | None = None,
    klass: list[str] | None = Query(None, alias="class"),
    kind: list[str] | None = Query(None),
    how_often: list[str] | None = Query(None),
    page: int = 1,
    page_size: int = 12,
) -> dict:
    pr.require("register.view")
    doms = [dict(r) for r in conn.execute(select(domain).order_by(domain.c.sort)).mappings()]
    dname = {d["id"]: d for d in doms}
    used = _used_at(conn)
    rows = []
    for t in conn.execute(select(template).order_by(template.c.sort)).mappings():
        rows.append(
            {
                "id": str(t["id"]),
                "name": t["name"],
                "legal_basis": (t["legal_basis"] or "").split(";")[0],
                "applies_note": t["applies_note"],
                "class": t["class"],
                "kind": t["kind"],
                "kind_label": KIND_LABEL[t["kind"]],
                "frequency": t["default_frequency"],
                "frequency_label": t["frequency_note"] or freq.label(t["default_frequency"]),
                "version": t["current_version"],
                "draft": t["draft_version"],
                "status": t["status"],
                "domain_key": dname[t["domain_id"]]["key"],
                "domain": dname[t["domain_id"]]["name"],
                "used_at": used.get(t["id"], 0),
                "review_before_use": t["review_before_use"],
                "source_status": t["source_status"],
            }
        )
    live = [r for r in rows if r["status"] == "published"]
    areas = [{"key": "all", "label": "All", "count": len(live)}] + [
        {"key": d["key"], "label": d["name"], "count": sum(1 for r in live if r["domain_key"] == d["key"])}
        for d in doms
        if any(r["domain_key"] == d["key"] for r in live)
    ]
    areas.sort(key=lambda a: (a["key"] != "all", -a["count"]))
    areas += [
        {"key": "proposed", "label": "Proposed additions", "count": sum(1 for r in rows if r["status"] == "proposed")},
        {"key": "archived", "label": "Archived", "count": sum(1 for r in rows if r["status"] == "archived")},
    ]
    sel_area = area or "all"
    if sel_area == "proposed":
        pool = [r for r in rows if r["status"] == "proposed"]
    elif sel_area == "archived":
        pool = [r for r in rows if r["status"] == "archived"]
    elif sel_area == "all":
        pool = live
    else:
        pool = [r for r in live if r["domain_key"] == sel_area]
    freqs = sorted({r["frequency"] for r in rows}, key=lambda f: list(freq.FREQUENCIES).index(f))
    facets = [
        listing.Facet(
            "class",
            "Class",
            lambda r: r["class"],
            [("A", "A · Life safety"), ("B", "B · Statutory"), ("C", "C · bide standard")],
        ),
        listing.Facet("kind", "Type", lambda r: r["kind"], list(KIND_LABEL.items())),
        listing.Facet("how_often", "How often", lambda r: r["frequency"], [(f, freq.label(f)) for f in freqs]),
    ]
    res = listing.run(
        pool,
        q=q,
        search=lambda r: f"{r['name']} {r['legal_basis']}",
        views=[listing.View("all", "All", lambda r: True)],
        view="all",
        facets=facets,
        selected={"class": listing.multi(klass), "kind": listing.multi(kind), "how_often": listing.multi(how_often)},
        page=page,
        page_size=page_size,
        noun=("template", "templates"),
    )
    out = res.dump()
    parts = [
        next((a["label"].lower() for a in areas if a["key"] == sel_area), "all areas")
        if sel_area != "all"
        else "all areas"
    ]
    cls = listing.multi(klass)
    if cls:
        parts.append(
            " and ".join(
                {"A": "life safety (Class A)", "B": "statutory (Class B)", "C": "bide standard (Class C)"}[c]
                for c in cls
            )
            + " only"
        )
    of = len(pool) if sel_area in ("proposed", "archived") else len(live)
    out["summary"] = f"Showing {res.total} of {of} templates: {', '.join(parts)}."
    out["areas"] = areas
    return out


@router.get("/options")
def options(pr: Current, conn: ConnDep) -> dict:
    """Editable lists the builder offers (CMS-04)."""
    return {
        "domains": [
            {"id": str(d.id), "key": d.key, "name": d.name}
            for d in conn.execute(select(domain).order_by(domain.c.sort))
        ],
        "classes": [
            {"key": c.key, "name": c.name, "weight": c.weight}
            for c in conn.execute(select(class_weight).order_by(class_weight.c.key))
        ],
        "frequencies": [{"key": f.key, "label": f.label, "mode": f.mode} for f in freq.FREQUENCIES.values()],
        "windows": {w.frequency: w.days for w in conn.execute(select(warning_window))},
        "kinds": [{"key": k, "label": v} for k, v in KIND_LABEL.items()],
        "field_types": sorted(forms.FIELD_TYPES),
        "features": [
            "has_fire_alarm",
            "has_gas",
            "has_oil",
            "has_hot_tub",
            "has_sauna",
            "has_salto",
            "has_lift",
            "has_food",
            "has_alcohol",
            "has_cctv",
            "unmanned",
            "pre_2000",
            "sponsor_licence",
            "visitor_levy",
        ],
    }


def _tpl(conn, template_id: uuid.UUID) -> dict:
    t = conn.execute(select(template).where(template.c.id == template_id)).mappings().first()
    if not t:
        raise problem(404, "not_found", "Not found.")
    return dict(t)


@router.get("/{template_id}")
def detail(template_id: uuid.UUID, pr: Current, conn: ConnDep) -> dict:
    pr.require("register.view")
    t = _tpl(conn, template_id)
    versions = [
        dict(v)
        for v in conn.execute(
            select(template_version)
            .where(template_version.c.template_id == template_id)
            .order_by(template_version.c.version.desc())
        ).mappings()
    ]
    draft = next((v for v in versions if v["status"] == "draft"), None)
    live = next((v for v in versions if v["version"] == t["current_version"]), versions[0] if versions else None)
    current = draft or live
    who = names(conn, {v["published_by"] for v in versions})
    settings_ = {k: t[k] for k in RULE_FIELDS}
    if draft and draft["settings"]:
        settings_.update(draft["settings"])
    settings_["domain_id"] = str(settings_["domain_id"])
    used = _used_at(conn).get(template_id, 0)
    return {
        "id": str(t["id"]),
        "status": t["status"],
        "current_version": t["current_version"],
        "draft_version": draft["version"] if draft else None,
        "editing_version": current["version"] if current else 1,
        "autosaved_at": draft["updated_at"] if draft else None,
        "settings": settings_,
        "form": current["form"] if current else [],
        "used_at": used,
        "review_before_use": t["review_before_use"],
        "source_status": t["source_status"],
        "versions": [
            {
                "version": v["version"],
                "status": v["status"],
                "published_at": v["published_at"],
                "by": who.get(v["published_by"]),
                "note": v["change_note"],
                "tasks": conn.execute(select(func.count()).where(task.c.template_version_id == v["id"])).scalar(),
            }
            for v in versions
        ],
        "can_edit": pr.can("library.edit"),
    }


def _check_rules(conn, v: dict) -> None:
    """Plain messages for rule values the builder can't produce but a hand-made request could."""
    if "name" in v and not str(v["name"] or "").strip():
        raise problem(422, "name", "Give the template a name.")
    if "kind" in v and v["kind"] not in KIND_LABEL:
        raise problem(422, "kind", "Choose a type.")
    if "late_rule" in v and v["late_rule"] not in ("late", "missed"):
        raise problem(422, "late_rule", "Choose what happens when the window closes.")
    if "verification" in v and v["verification"] not in ("none", "always", "sample"):
        raise problem(422, "verification", "Choose how it is verified.")
    if "sample_rate" in v and not (isinstance(v["sample_rate"], int) and 1 <= v["sample_rate"] <= 100):
        raise problem(422, "sample_rate", "Spot-checks are 1 in 1 to 1 in 100.")
    if (
        "warning_days" in v
        and v["warning_days"] is not None
        and not (isinstance(v["warning_days"], int) and 0 <= v["warning_days"] <= 365)
    ):
        raise problem(422, "warning_days", "The amber window is 0 to 365 days.")
    if "due_time" in v:
        try:
            clock.parse_hhmm(str(v["due_time"]))
        except (TypeError, ValueError):
            raise problem(422, "due_time", "Due times look like 23:59.") from None
    if "domain_id" in v:
        try:
            ok = conn.execute(select(domain.c.id).where(domain.c.id == uuid.UUID(str(v["domain_id"])))).first()
        except ValueError:
            ok = None
        if not ok:
            raise problem(422, "domain", "Choose an area from the list.")


class DraftIn(BaseModel):
    settings: dict = {}
    form: list[dict] | None = None


@router.put("/{template_id}/draft")
def save_draft(template_id: uuid.UUID, body: DraftIn, pr: Current, conn: ConnDep) -> dict:
    """Autosave: edits go to a draft version. Nothing changes for staff until it's published."""
    pr.require("library.edit")
    t = _tpl(conn, template_id)
    if t["status"] == "archived":
        raise problem(409, "archived", "Bring this template back before editing it.")
    clean = {k: v for k, v in body.settings.items() if k in RULE_FIELDS}
    if "class" in clean and clean["class"] not in ("A", "B", "C"):
        raise problem(422, "class", "Class must be A, B or C.")
    if "default_frequency" in clean:
        freq.get(clean["default_frequency"])
    _check_rules(conn, clean)
    form = None
    if body.form is not None:
        try:
            form = forms.validate_schema(body.form)
        except forms.FormError as e:
            raise problem(422, "form", str(e)) from None
    draft = (
        conn.execute(
            select(template_version).where(
                template_version.c.template_id == template_id, template_version.c.status == "draft"
            )
        )
        .mappings()
        .first()
    )
    if draft:
        vals: dict = {"settings": {**(draft["settings"] or {}), **clean}, "updated_at": clock.now()}
        if form is not None:
            vals["form"] = form
        conn.execute(update(template_version).where(template_version.c.id == draft["id"]).values(**vals))
        ver = draft["version"]
    else:
        live = conn.execute(
            select(template_version.c.form).where(
                template_version.c.template_id == template_id, template_version.c.version == t["current_version"]
            )
        ).scalar()
        ver = (
            conn.execute(
                select(func.max(template_version.c.version)).where(template_version.c.template_id == template_id)
            ).scalar()
            or 0
        ) + 1
        conn.execute(
            template_version.insert().values(
                id=uuid.uuid4(),
                template_id=template_id,
                version=ver,
                status="draft",
                form=form if form is not None else live,
                settings=clean,
            )
        )
        conn.execute(update(template).where(template.c.id == template_id).values(draft_version=ver))
    return {"version": ver, "autosaved_at": clock.now()}


class PublishIn(BaseModel):
    note: str | None = None


@router.post("/{template_id}/publish")
def publish(template_id: uuid.UUID, body: PublishIn, request: Request, pr: Current, conn: ConnDep) -> dict:
    """Publishing changes future tasks only. Past submissions keep the form they were completed on."""
    pr.require("library.edit")
    t = _tpl(conn, template_id)
    draft = (
        conn.execute(
            select(template_version).where(
                template_version.c.template_id == template_id, template_version.c.status == "draft"
            )
        )
        .mappings()
        .first()
    )
    if not draft:
        raise problem(409, "no_draft", "There's nothing new to publish.")
    vals = {k: v for k, v in (draft["settings"] or {}).items() if k in RULE_FIELDS}
    if "domain_id" in vals:
        vals["domain_id"] = uuid.UUID(str(vals["domain_id"]))
    conn.execute(
        update(template_version)
        .where(template_version.c.id == draft["id"])
        .values(status="published", published_at=clock.now(), published_by=pr.person_id, change_note=body.note)
    )
    conn.execute(
        update(template)
        .where(template.c.id == template_id)
        .values(
            **vals,
            current_version=draft["version"],
            draft_version=None,
            status="published" if t["status"] == "proposed" else t["status"],
        )
    )
    # Tasks nobody has started pick up the new version (the staff app shows its form); anything already submitted
    # keeps the form it was completed on.
    moved = retarget_version(conn, template_id, draft["id"])
    # The rules travel to every property using the template: a new frequency, due time or window replans the
    # future, and a new Class, warning window or verification rule is reflected in each item's status straight away.
    replan = any(k in vals and vals[k] != t[k] for k in SCHEDULE_FIELDS)
    items = conn.execute(
        select(register_item.c.id, register_item.c.frequency).where(
            register_item.c.template_id == template_id, register_item.c.state == "on"
        )
    ).all()
    for it in items:
        # A property's own frequency (set from its FRA, CMS-12) wins over the template default.
        own_freq_only = it.frequency and {k for k in SCHEDULE_FIELDS if k in vals and vals[k] != t[k]} == {
            "default_frequency"
        }
        if replan and not own_freq_only:
            cancel_future(conn, it.id)
        refresh_item(conn, it.id)
    audit.record(
        conn,
        actor_for(request, pr),
        category="settings",
        action="template.publish",
        summary=f"Published v{draft['version']} of “{t['name']}”",
        entity_type="template",
        entity_id=template_id,
        before={"version": t["current_version"]},
        after={"version": draft["version"], "note": body.note, "tasks_moved": moved, "properties": len(items)},
    )
    return {"version": draft["version"], "tasks_moved": moved, "items": len(items)}


@router.delete("/{template_id}/draft")
def discard(template_id: uuid.UUID, pr: Current, conn: ConnDep) -> dict:
    pr.require("library.edit")
    conn.execute(
        template_version.delete().where(
            template_version.c.template_id == template_id, template_version.c.status == "draft"
        )
    )
    conn.execute(update(template).where(template.c.id == template_id).values(draft_version=None))
    return {"ok": True}


class NewTemplate(BaseModel):
    name: str
    domain_id: uuid.UUID
    klass: str
    kind: str
    default_frequency: str


@router.post("")
def create(body: NewTemplate, request: Request, pr: Current, conn: ConnDep) -> dict:
    pr.require("library.edit")
    if body.kind not in KIND_LABEL or body.klass not in ("A", "B", "C"):
        raise problem(422, "kind", "Choose a type and a Class.")
    freq.get(body.default_frequency)
    if len(body.name.strip()) < 3:
        raise problem(422, "name", "Give the template a name of at least 3 characters.")
    from bide_comply.seed.library import default_form

    tid = uuid.uuid4()
    conn.execute(
        template.insert().values(
            id=tid,
            name=body.name.strip(),
            domain_id=body.domain_id,
            **{"class": body.klass},
            kind=body.kind,
            default_frequency=body.default_frequency,
            status="published",
            current_version=1,
            sort=999,
        )
    )
    conn.execute(
        template_version.insert().values(
            id=uuid.uuid4(),
            template_id=tid,
            version=1,
            status="published",
            form=forms.validate_schema(default_form(body.kind, body.name)),
            published_at=clock.now(),
            published_by=pr.person_id,
            change_note="New template",
        )
    )
    audit.record(
        conn,
        actor_for(request, pr),
        category="settings",
        action="template.create",
        summary=f"Added the template “{body.name}”",
        entity_type="template",
        entity_id=tid,
    )
    return {"id": str(tid)}


class ArchiveIn(BaseModel):
    reason: str


@router.post("/{template_id}/archive")
def archive(template_id: uuid.UUID, body: ArchiveIn, request: Request, pr: Current, conn: ConnDep) -> dict:
    """Nothing with history is deleted. Archiving stops new tasks, keeps every past record, and can be undone."""
    pr.require("library.edit")
    t = _tpl(conn, template_id)
    if not body.reason.strip():
        raise problem(422, "reason", "Give a reason.")
    past = conn.execute(
        select(func.count())
        .select_from(task.join(register_item, register_item.c.id == task.c.register_item_id))
        .where(
            register_item.c.template_id == template_id, task.c.status.in_(("passed", "verified", "failed", "missed"))
        )
    ).scalar()
    conn.execute(
        update(template).where(template.c.id == template_id).values(status="archived", archive_reason=body.reason)
    )
    for iid in conn.execute(
        select(register_item.c.id).where(register_item.c.template_id == template_id, register_item.c.state == "on")
    ).scalars():
        conn.execute(
            update(register_item)
            .where(register_item.c.id == iid)
            .values(state="off", state_reason=f"Template archived: {body.reason}")
        )
        cancel_future(conn, iid)
        recompute_item(conn, iid)
    audit.record(
        conn,
        actor_for(request, pr),
        category="settings",
        action="template.archive",
        summary=f"Archived “{t['name']}” ({past} past records kept)",
        entity_type="template",
        entity_id=template_id,
        after={"reason": body.reason},
    )
    return {"past_records": past}


@router.post("/{template_id}/restore")
def restore(template_id: uuid.UUID, request: Request, pr: Current, conn: ConnDep) -> dict:
    """Bring an archived template back. Properties switch it back on in Property setup; nothing restarts by itself."""
    pr.require("library.edit")
    t = _tpl(conn, template_id)
    if t["status"] != "archived":
        raise problem(409, "not_archived", "This template isn't archived.")
    conn.execute(update(template).where(template.c.id == template_id).values(status="published", archive_reason=None))
    audit.record(
        conn,
        actor_for(request, pr),
        category="settings",
        action="template.restore",
        summary=f"Brought back “{t['name']}”",
        entity_type="template",
        entity_id=template_id,
    )
    return {"ok": True}


@router.get("/{template_id}/archive-check")
def archive_check(template_id: uuid.UUID, pr: Current, conn: ConnDep) -> dict:
    pr.require("library.edit")
    _tpl(conn, template_id)
    past = conn.execute(
        select(func.count())
        .select_from(task.join(register_item, register_item.c.id == task.c.register_item_id))
        .where(
            register_item.c.template_id == template_id, task.c.status.in_(("passed", "verified", "failed", "missed"))
        )
    ).scalar()
    return {"past_records": past, "deletable": past == 0, "last_updated": fmt_date(clock.today())}
