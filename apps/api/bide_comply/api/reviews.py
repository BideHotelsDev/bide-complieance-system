"""Evidence review (design: Verification and evidence): the queues, one submission's evidence, verify and amend."""

import uuid
from datetime import timedelta

from fastapi import APIRouter, Request
from pydantic import BaseModel
from sqlalchemy import func, select, update

from bide_comply import clock
from bide_comply.auth import Current, actor_for
from bide_comply.authz import scope_filter
from bide_comply.db import ConnDep
from bide_comply.engine import frequency as freq
from bide_comply.schema import (
    action,
    amendment,
    approval_request,
    device,
    evidence,
    person,
    pool,
    property_,
    register_item,
    submission,
    submission_evidence,
    task,
    template,
    template_version,
    verification,
)
from bide_comply.services import checks
from bide_comply.services import contractor_portal as contractor_uploads
from bide_comply.services import evidence as ev_service
from bide_comply.services.common import fmt_date, fmt_day, problem

router = APIRouter(prefix="/api/reviews", tags=["reviews"])

FLAG_LABEL = {
    "captured_offline": "Captured offline",
    "back_filed": "Back-filed",
    "outside_geofence": "Outside geofence",
    "clock_skew": "Clock skew",
    "duplicate_photo": "Photo used before",
    "no_location": "No location",
}


def _when(dt) -> str:
    d = clock.london(dt).date()
    if d == clock.today():
        return f"today {clock.london(dt):%H:%M}"
    return fmt_day(d)


def _queue_rows(conn, pr, property_id):
    q = (
        select(
            submission.c.id,
            submission.c.server_time,
            submission.c.flags,
            submission.c.result,
            submission.c.submitter_id,
            submission.c.back_filed,
            submission.c["values"],
            submission.c.failed_fields,
            task.c.status,
            task.c.spot_check,
            task.c.id.label("task_id"),
            register_item.c.ref,
            register_item.c.property_id,
            template.c.name,
            template.c["class"].label("klass"),
            template.c.verification,
            person.c.name.label("by"),
            property_.c.name.label("property"),
        )
        .join(task, task.c.id == submission.c.task_id)
        .join(register_item, register_item.c.id == task.c.register_item_id)
        .join(template, template.c.id == register_item.c.template_id)
        .join(person, person.c.id == submission.c.submitter_id)
        .join(property_, property_.c.id == register_item.c.property_id)
        .where(
            scope_filter(pr, register_item.c.property_id),
            # VER-05: your own submissions never appear here; they route to another verifier.
            submission.c.submitter_id != pr.person_id,
            ~select(verification.c.id).where(verification.c.submission_id == submission.c.id).exists(),
        )
    )
    if property_id:
        q = q.where(register_item.c.property_id == property_id)
    return [dict(r) for r in conn.execute(q.order_by(template.c["class"], submission.c.server_time.desc())).mappings()]


@router.get("")
def queue(pr: Current, conn: ConnDep, queue: str = "needs_review", property: uuid.UUID | None = None) -> dict:  # noqa: A002
    pr.require("verify")
    rows = _queue_rows(conn, pr, property)
    week_ago = clock.now() - timedelta(days=7)
    needs = [r for r in rows if r["status"] in ("submitted", "failed") and not r["back_filed"]]
    spot = [r for r in rows if r["status"] == "passed" and r["spot_check"] and r["server_time"] >= week_ago]
    back = [r for r in rows if r["back_filed"]]
    pick = {"needs_review": needs, "spot_check": spot, "back_filed": back}.get(queue, needs)

    def card(r):
        flags = [FLAG_LABEL.get(f, f) for f in r["flags"]]
        detail = f"{r['property']} · {r['by']} · {_when(r['server_time'])}"
        if r["result"] == "failed" and r["failed_fields"]:
            f = r["failed_fields"][0]
            unit = ""
            val = f.get("value")
            detail = (
                f"{r['property']} · {r['values'].get('outlet', '')} {val}{unit} · {_when(r['server_time'])}".replace(
                    "  ", " "
                )
                if isinstance(val, (int, float))
                else detail
            )
        badge = "Failed" if r["result"] == "failed" else (flags[0] if flags else "Submitted")
        return {
            "id": str(r["id"]),
            "ref": r["ref"],
            "class": r["klass"],
            "title": r["name"],
            "detail": detail,
            "badge": badge,
            "badge_tone": "red"
            if r["result"] == "failed"
            else (
                "amber"
                if flags and flags[0] in ("Outside geofence", "Clock skew", "Photo used before")
                else "grey"
                if flags
                else "blue"
            ),
        }

    # Reports and fix photos sent from the contractor portal wait in Needs review too (kind "contractor"); the
    # notification links to them as queue=contractor.
    from_contractors = contractor_uploads.pending_cards(conn, pr, property)
    queues = [
        {"key": "needs_review", "label": "Needs review", "count": len(needs) + len(from_contractors)},
        {"key": "spot_check", "label": "Spot-check", "count": len(spot)},
        {"key": "back_filed", "label": "Back-filed", "count": len(back)},
    ]
    if queue == "contractor":
        return {"queues": queues, "rows": from_contractors}
    rows = [card(r) for r in pick]
    if queue not in ("spot_check", "back_filed"):
        rows += from_contractors
    return {"queues": queues, "rows": rows}


@router.get("/{submission_id}")
def detail(submission_id: uuid.UUID, pr: Current, conn: ConnDep) -> dict:
    s = conn.execute(select(submission).where(submission.c.id == submission_id)).mappings().first()
    if not s:
        raise problem(404, "not_found", "Not found.")
    t = checks.load_task(conn, s["task_id"])
    pr.require_property(t["property_id"])
    tpl = (
        conn.execute(
            select(
                template.c.default_frequency,
                template.c.legal_basis,
                register_item.c.frequency,
                register_item.c.done_by_pool_id,
                property_.c.name.label("property"),
                property_.c.code.label("property_code"),
            )
            .join(register_item, register_item.c.template_id == template.c.id)
            .join(property_, property_.c.id == register_item.c.property_id)
            .where(register_item.c.id == t["register_item_id"])
        )
        .mappings()
        .one()
    )
    sub_by = conn.execute(select(person.c.name).where(person.c.id == s["submitter_id"])).scalar()
    pool_name = (
        conn.execute(select(pool.c.name).where(pool.c.id == tpl["done_by_pool_id"])).scalar()
        if tpl["done_by_pool_id"]
        else None
    )
    files = [
        dict(r)
        for r in conn.execute(
            select(evidence, submission_evidence.c.field_key)
            .join(submission_evidence, submission_evidence.c.evidence_id == evidence.c.id)
            .where(submission_evidence.c.submission_id == submission_id)
            .order_by(submission_evidence.c.sort)
        ).mappings()
    ]
    form = t["form"]
    labels = {f["key"]: f for f in form}
    answers = []
    for f in form:
        if f["type"] in ("photo", "file"):
            continue
        v = s["values"].get(f["key"])
        failed = any(x["key"] == f["key"] for x in s["failed_fields"])
        shown = v
        if f["type"] == "yes_no" and v is not None or f["type"] == "pass_fail" and v is not None:
            shown = str(v).capitalize()
        elif f["type"] == "number" and v is not None:
            shown = f"{v} {f.get('unit') or ''}".strip()
        answers.append({"label": f["label"], "value": shown if shown not in (None, "") else "None", "failed": failed})
    dup = (
        conn.execute(
            select(func.count())
            .select_from(submission_evidence.join(evidence, evidence.c.id == submission_evidence.c.evidence_id))
            .where(
                evidence.c.sha256.in_([f["sha256"] for f in files]),
                submission_evidence.c.submission_id != submission_id,
            )
        ).scalar()
        if files
        else 0
    )
    dev = (
        conn.execute(select(device.c.trusted_at, device.c.label).where(device.c.id == s["device_id"])).first()
        if s["device_id"]
        else None
    )
    skew = int(abs((s["server_time"] - s["device_time"]).total_seconds())) if s["device_time"] else None
    vers = [
        {"result": v.result, "comment": v.comment, "by": v.name, "at": v.created_at}
        for v in conn.execute(
            select(verification.c.result, verification.c.comment, verification.c.created_at, person.c.name)
            .join(person, person.c.id == verification.c.verifier_id)
            .where(verification.c.submission_id == submission_id)
        )
    ]
    amends = [
        {"reason": a.reason, "reason_type": a.reason_type, "changes": a.changes, "by": a.name, "at": a.created_at}
        for a in conn.execute(
            select(amendment, person.c.name)
            .join(person, person.c.id == amendment.c.author_id)
            .where(amendment.c.submission_id == submission_id)
        )
    ]
    f = tpl["frequency"] or tpl["default_frequency"]
    ver_rule = {"always": "Always verify", "sample": "Spot-check 1 in 10", "none": "No verification"}[t["verification"]]
    photos = []
    for e in files:
        v = ev_service.view(e)
        fld = labels.get(e["field_key"]) or {}
        v["required"] = fld.get("label")
        v["stamp"] = (
            f"{t['ref']} · {sub_by.split()[0][0]}. {' '.join(sub_by.split()[1:])}"
            if sub_by and len(sub_by.split()) > 1
            else t["ref"]
        )
        v["taken"] = clock.london(e["captured_at"]).strftime("%-d %b %Y %H:%M %Z") if e["captured_at"] else None
        photos.append(v)
    flags = [FLAG_LABEL.get(x, x) for x in s["flags"]]
    return {
        "id": str(submission_id),
        "ref": t["ref"],
        "class": t["klass"],
        "title": t["template_name"],
        "status": t["status"],
        "result": s["result"],
        "subtitle": f"{tpl['property']} · {freq.label(f)} · Template v{t['version']} · {(tpl['legal_basis'] or '').split(';')[0]}",
        "verification_rule": ver_rule,
        "photos": photos,
        "photo_count": len(photos),
        "original_kept": True,
        "duplicate_found": bool(dup),
        "answers": answers,
        "notes": s["notes"],
        "presence": {
            "submitted_by": f"{sub_by} ({pool_name})" if pool_name else sub_by,
            "work_done": f"{s['work_done_on']:%a} {fmt_date(s['work_done_on'], True)}",
            "server_time": clock.london(s["server_time"]).strftime("%H:%M:%S %Z"),
            "device_time": (
                clock.london(s["device_time"]).strftime("%H:%M:%S") + (f" · {skew} s skew" if skew is not None else "")
            )
            if s["device_time"]
            else None,
            "location": "Inside geofence"
            if s["inside_geofence"]
            else ("Outside geofence" if s["inside_geofence"] is False else "Not recorded"),
            "device": f"Trusted since {fmt_date(clock.london(dev.trusted_at).date())}"
            if dev and dev.trusted_at
            else ("New device" if dev else "Unknown"),
            "photo_hash": f"sha256 · {photos[0]['sha256'][:4]}…{photos[0]['sha256'][-4:]}"
            if photos and photos[0]["sha256"]
            else None,
            "captured_offline": s["captured_offline"],
            "back_filed": s["back_filed"],
        },
        "flags": flags,
        "verifications": vers,
        "amendments": amends,
        "can_verify": pr.can("verify", t["property_id"]) and s["submitter_id"] != pr.person_id,
        "own": s["submitter_id"] == pr.person_id,
        "can_amend": pr.can("submission.amend"),
        "task_id": str(t["id"]),
        "property_code": tpl["property_code"],
        # Actions raised from this submission (a failed check, or "Needs action"), so the review links to the fix.
        "actions": [
            {"ref": a.ref, "status": a.status, "priority": a.priority}
            for a in conn.execute(
                select(action.c.ref, action.c.status, action.c.priority)
                .where((action.c.submission_id == submission_id) | (action.c.task_id == t["id"]))
                .order_by(action.c.ref)
            )
        ],
    }


class VerifyIn(BaseModel):
    result: str  # approved | rejected | needs_action
    comment: str | None = None


@router.post("/{submission_id}/verify")
def verify(submission_id: uuid.UUID, body: VerifyIn, request: Request, pr: Current, conn: ConnDep) -> dict:
    if body.result not in ("approved", "rejected", "needs_action"):
        raise problem(422, "result", "Unknown result.")
    s = conn.execute(
        select(submission.c.back_filed, submission.c.task_id).where(submission.c.id == submission_id)
    ).first()
    typ = (
        "spot_check"
        if s and conn.execute(select(task.c.spot_check).where(task.c.id == s.task_id)).scalar()
        else "planned"
    )
    out = checks.verify(
        conn, pr, actor_for(request, pr), submission_id, result=body.result, comment=body.comment, type_=typ
    )
    if s and s.back_filed and body.result == "approved":
        conn.execute(
            update(submission).where(submission.c.id == submission_id).values(approved_backfile_by=pr.person_id)
        )
        conn.execute(
            update(approval_request)
            .where(approval_request.c.kind == "backfile", approval_request.c.task_id == s.task_id)
            .values(status="approved", decided_by=pr.person_id, decided_at=clock.now())
        )
    return out


class BulkIn(BaseModel):
    ids: list[uuid.UUID]
    # "Approve all N · I've looked at every photo": life-safety ones are approved too only when asked for.
    include_life_safety: bool = False


@router.post("/bulk-approve")
def bulk_approve(body: BulkIn, request: Request, pr: Current, conn: ConnDep) -> dict:
    """Approve many at once; life-safety ones are left to open one by one (design: Approve 7 checks?)."""
    done, skipped = 0, 0
    for sid in body.ids:
        t = conn.execute(
            select(template.c["class"])
            .select_from(
                submission.join(task, task.c.id == submission.c.task_id)
                .join(register_item, register_item.c.id == task.c.register_item_id)
                .join(template, template.c.id == register_item.c.template_id)
            )
            .where(submission.c.id == sid)
        ).scalar()
        if t == "A" and not body.include_life_safety:
            skipped += 1
            continue
        checks.verify(conn, pr, actor_for(request, pr), sid, result="approved", comment=None)
        done += 1
    return {"approved": done, "left_for_review": skipped}


class AmendIn(BaseModel):
    reason_type: str
    reason: str
    changes: dict


@router.post("/{submission_id}/amend")
def amend(submission_id: uuid.UUID, body: AmendIn, request: Request, pr: Current, conn: ConnDep) -> dict:
    return checks.amend(
        conn,
        pr,
        actor_for(request, pr),
        submission_id,
        reason_type=body.reason_type,
        reason=body.reason,
        changes=body.changes,
    )


@router.get("/versions/{template_version_id}")
def version_form(template_version_id: uuid.UUID, pr: Current, conn: ConnDep) -> dict:
    v = conn.execute(
        select(template_version.c.form, template_version.c.version).where(template_version.c.id == template_version_id)
    ).first()
    if not v:
        raise problem(404, "not_found", "Not found.")
    return {"version": v.version, "form": v.form}
