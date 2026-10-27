"""Doing a check: submit, verify, amend, back-file (PRD §5.3, §5.4).

A submission is locked the moment it's saved. Corrections are amendments with a reason; the original stays visible.
A failed check or a reading out of range is saved as Failed and raises an Action straight away; it never costs the
person points.
"""

import math
import random
import uuid
from datetime import date, datetime

from sqlalchemy import Connection, func, select, update

from bide_comply import audit, clock
from bide_comply.authz import Principal, not_self
from bide_comply.config import settings
from bide_comply.engine import forms
from bide_comply.schema import (
    amendment,
    approval_request,
    evidence,
    pool_member,
    property_,
    register_item,
    submission,
    submission_evidence,
    task,
    template,
    template_version,
    verification,
)
from bide_comply.services import actions as action_service
from bide_comply.services import notify
from bide_comply.services.common import file_name, problem
from bide_comply.services.register import recompute_item, refresh_item

# Words in a field's key or label that make a failure a Class A failure of the kind §7 lists: alarm or ARC down,
# no keyholder cover, escape route blocked, FRA missing.
CLASS_A_FAILURE_HINTS = ("arc", "alarm", "signal", "escape", "exit", "keyholder", "fra", "panel", "sounder")


def load_task(conn: Connection, task_id: uuid.UUID) -> dict:
    row = (
        conn.execute(
            select(
                task,
                register_item.c.ref,
                register_item.c.property_id,
                register_item.c.done_by_kind,
                register_item.c.done_by_person_id,
                register_item.c.done_by_pool_id,
                register_item.c.accountable_id,
                register_item.c.cover_id,
                register_item.c.verifier_id,
                register_item.c.verifier_mode,
                register_item.c.template_id,
                template.c.name.label("template_name"),
                template.c["class"].label("klass"),
                template.c.kind,
                template.c.verification,
                template.c.late_rule,
                template.c.geofence_required,
                template_version.c.form,
                template_version.c.version,
            )
            .join(register_item, register_item.c.id == task.c.register_item_id)
            .join(template, template.c.id == register_item.c.template_id)
            .join(template_version, template_version.c.id == task.c.template_version_id)
            .where(task.c.id == task_id)
        )
        .mappings()
        .first()
    )
    if not row:
        raise problem(404, "not_found", "Not found.")
    return dict(row)


def may_do(conn: Connection, pr: Principal, t: dict) -> bool:
    if not pr.sees(t["property_id"]):
        return False
    if t["done_by_kind"] == "person" and t["done_by_person_id"] == pr.person_id:
        return True
    if t["done_by_kind"] == "pool" and t["done_by_pool_id"]:
        if conn.execute(
            select(pool_member.c.person_id).where(
                pool_member.c.pool_id == t["done_by_pool_id"], pool_member.c.person_id == pr.person_id
            )
        ).first():
            return True
    if pr.person_id in (t["accountable_id"], t["cover_id"], t["owner_id"]):
        return True
    # Managers at the property can always step in; it's recorded as them.
    return pr.can("assign", t["property_id"]) or pr.has_role("super_admin")


def _distance_m(lat1: float, lng1: float, lat2: float, lng2: float) -> float:
    r = 6371000.0
    p1, p2 = math.radians(lat1), math.radians(lat2)
    dp, dl = math.radians(lat2 - lat1), math.radians(lng2 - lng1)
    a = math.sin(dp / 2) ** 2 + math.cos(p1) * math.cos(p2) * math.sin(dl / 2) ** 2
    return 2 * r * math.asin(math.sqrt(a))


def submit(
    conn: Connection,
    pr: Principal,
    actor: audit.Actor,
    task_id: uuid.UUID,
    *,
    values: dict,
    photos: dict[str, list[uuid.UUID]],
    work_done_on: date | None,
    device_time: datetime | None,
    captured_offline: bool,
    lat: float | None,
    lng: float | None,
    accuracy: float | None,
    notes: str | None,
    signature: str | None,
) -> dict:
    t = load_task(conn, task_id)
    if not may_do(conn, pr, t):
        raise problem(403, "not_yours", "This check is assigned to someone else.")
    now = clock.now()
    if t["status"] in ("passed", "verified", "failed", "submitted"):
        raise problem(409, "done", "This check has already been sent in.")
    if t["status"] in ("missed", "na", "cancelled"):
        raise problem(
            409, "closed", "This check's window has closed, so it can't be recorded now. Tell your site lead."
        )
    # Offline submissions keep their capture time; a time-bound window is judged on that time (EXE-06).
    at = device_time if captured_offline and device_time else now
    if at < t["window_opens_at"]:
        raise problem(409, "not_open", "This check isn't open yet.")
    if t["late_rule"] == "missed" and t["window_closes_at"] and at > t["window_closes_at"]:
        raise problem(
            409, "closed", "This check's window has closed, so it can't be recorded now. Tell your site lead."
        )

    ev_ids = [eid for ids in photos.values() for eid in ids]
    rows = (
        {
            r["id"]: r
            for r in conn.execute(
                select(
                    evidence.c.id,
                    evidence.c.uploaded_by,
                    evidence.c.status,
                    evidence.c.captured_with,
                    evidence.c.kind,
                    evidence.c.sha256,
                ).where(evidence.c.id.in_(ev_ids))
            ).mappings()
        }
        if ev_ids
        else {}
    )
    counts: dict[str, int] = {}
    for key, ids in photos.items():
        for eid in ids:
            r = rows.get(eid)
            if not r or r["uploaded_by"] != pr.person_id or r["status"] != "stored":
                raise problem(422, "evidence", "A photo didn't finish uploading. Take it again.")
            field = next((f for f in t["form"] if f["key"] == key), None)
            if field and field["type"] == "photo" and r["captured_with"] != "camera":
                raise problem(422, "camera", "Evidence photos are taken in the app, not picked from your gallery.")
            counts[key] = counts.get(key, 0) + 1

    try:
        ev = forms.evaluate(t["form"], values, counts)
    except forms.FormError as e:
        raise problem(422, "form", str(e)) from None
    if ev.missing:
        raise problem(422, "missing", "Still to do: " + ", ".join(ev.missing) + ".", missing=ev.missing)

    flags: list[str] = []
    inside = None
    prop = conn.execute(select(property_).where(property_.c.id == t["property_id"])).mappings().one()
    if lat is not None and lng is not None and prop["geofence_lat"] is not None:
        radius = prop["geofence_radius_m"] or settings.geofence_default_radius_m
        inside = _distance_m(lat, lng, prop["geofence_lat"], prop["geofence_lng"]) <= radius + (accuracy or 0)
        if not inside:
            flags.append("outside_geofence")
    elif t["geofence_required"] and prop["geofence_lat"] is not None:
        flags.append("no_location")
    if (
        device_time
        and abs((now - device_time).total_seconds()) > settings.clock_skew_flag_seconds
        and not captured_offline
    ):
        flags.append("clock_skew")
    if captured_offline:
        flags.append("captured_offline")
    # The same photo bytes used before on another submission (EXE-13 exact match; perceptual matching is P2).
    hashes = [r["sha256"] for r in rows.values()]
    if (
        hashes
        and conn.execute(
            select(func.count())
            .select_from(submission_evidence.join(evidence, evidence.c.id == submission_evidence.c.evidence_id))
            .where(evidence.c.sha256.in_(hashes))
        ).scalar()
    ):
        flags.append("duplicate_photo")

    done_on = work_done_on or clock.london(at).date()
    who = pr.name
    sid = uuid.uuid4()
    conn.execute(
        submission.insert().values(
            id=sid,
            task_id=task_id,
            submitter_id=pr.person_id,
            work_done_on=done_on,
            server_time=now,
            device_time=device_time,
            captured_offline=captured_offline,
            lat=lat,
            lng=lng,
            accuracy_m=accuracy,
            inside_geofence=inside,
            device_id=pr.device_id,
            values=values,
            result=ev.result,
            failed_fields=ev.failed_fields,
            flags=flags,
            file_name=file_name(t["template_name"], who, done_on),
            notes=notes,
            signature=signature,
            locked=True,
        )
    )
    for key, ids in photos.items():
        for i, eid in enumerate(ids):
            conn.execute(submission_evidence.insert().values(submission_id=sid, evidence_id=eid, field_key=key, sort=i))
            n = sum(1 for _ in ids)
            label = next((f["label"] for f in t["form"] if f["key"] == key), key)
            conn.execute(
                update(evidence)
                .where(evidence.c.id == eid)
                .values(
                    file_name=file_name(
                        f"{t['ref']} {label}" + (f" {i + 1}" if n > 1 else ""),
                        who,
                        done_on,
                        "jpg" if rows[eid]["kind"] != "pdf" else "pdf",
                    )
                )
            )

    # Verification: always for the template, Class A captured offline (EXE-11), flagged evidence, or the sample.
    needs_ver = (
        t["verification"] == "always"
        or t["verifier_mode"] == "always"
        or (captured_offline and t["klass"] == "A")
        or bool({"outside_geofence", "clock_skew", "duplicate_photo"} & set(flags))
    )
    if ev.result == "failed":
        new_status = "failed"
    elif needs_ver:
        new_status = "submitted"
    else:
        new_status = "passed"
    late = at > t["due_at"]
    conn.execute(
        update(task)
        .where(task.c.id == task_id)
        .values(
            status=new_status,
            completed_by=pr.person_id,
            completed_at=now,
            needs_verification=needs_ver,
        )
    )
    conn.execute(
        update(register_item)
        .where(
            register_item.c.id == t["register_item_id"],
            (register_item.c.last_done_on.is_(None)) | (register_item.c.last_done_on < done_on),
        )
        .values(last_done_on=done_on)
    )
    audit.record(
        conn,
        actor,
        category="check",
        action="submission.create",
        summary=f"Submitted a check as {'Failed' if ev.result == 'failed' else 'Passed'}" + (" (late)" if late else ""),
        entity_type="submission",
        entity_id=sid,
        entity_ref=t["ref"],
        property_id=t["property_id"],
        after={"result": ev.result, "flags": flags, "failed": [f["label"] for f in ev.failed_fields]},
    )

    raised = None
    if ev.result == "failed":
        what = "; ".join(f["text"] for f in ev.failed_fields)
        out_of_range = any(
            f.get("value") is not None and isinstance(f["value"], (int, float)) for f in ev.failed_fields
        )
        hint_hit = any(
            any(h in (f["key"] + " " + f["label"]).lower() for h in CLASS_A_FAILURE_HINTS) for f in ev.failed_fields
        )
        class_a_failure = t["klass"] == "A" and hint_hit
        raised = action_service.raise_action(
            conn,
            actor,
            property_id=t["property_id"],
            description=what,
            source="out_of_range" if out_of_range else "failed_check",
            source_ref=f"Check {t['ref']}",
            klass=t["klass"],
            register_item_id=t["register_item_id"],
            task_id=task_id,
            submission_id=sid,
            class_a_failure=class_a_failure,
        )
        pname = prop["name"]
        notify.escalate(
            conn,
            "failed_check",
            property_id=t["property_id"],
            klass=t["klass"],
            register_item_id=t["register_item_id"],
            task_id=task_id,
            action_id=raised["id"],
            summary=f"{t['template_name']} at {pname} was logged as Failed. Action {raised['ref']} raised.",
            dedupe_key=f"failed:{task_id}",
            link=f"/actions?sel={raised['ref']}",
        )
    item = recompute_item(conn, t["register_item_id"])
    refresh_item(conn, t["register_item_id"])  # the next rolling occurrence, if any

    owner_name = None
    if raised and raised["owner_id"]:
        from bide_comply.services.common import names

        owner_name = names(conn, {raised["owner_id"]}).get(raised["owner_id"])
    return {
        "submission_id": str(sid),
        "result": ev.result,
        "status": new_status,
        "failed_fields": ev.failed_fields,
        "flags": flags,
        "late": late,
        "item_status": item["status"],
        "action": {
            "ref": raised["ref"],
            "priority": raised["priority"],
            "due_on": raised["due_on"],
            "owner": owner_name,
            "class_a": t["klass"] == "A",
        }
        if raised
        else None,
    }


def pick_verifier_ok(pr: Principal, sub: dict) -> None:
    not_self(pr, sub["submitter_id"], "Your own submissions route to another verifier.")


def verify(
    conn: Connection,
    pr: Principal,
    actor: audit.Actor,
    submission_id: uuid.UUID,
    *,
    result: str,
    comment: str | None,
    type_: str = "planned",
) -> dict:
    sub = conn.execute(select(submission).where(submission.c.id == submission_id)).mappings().first()
    if not sub:
        raise problem(404, "not_found", "Not found.")
    t = load_task(conn, sub["task_id"])
    pr.require_property(t["property_id"])
    if not (pr.can("verify", t["property_id"])):
        raise problem(403, "forbidden", "You can't verify checks at this property.")
    pick_verifier_ok(pr, dict(sub))
    if result == "rejected" and not (comment and comment.strip()):
        raise problem(422, "comment", "Say what needs redoing, so the person knows what to fix.")
    conn.execute(
        verification.insert().values(
            id=uuid.uuid4(),
            submission_id=submission_id,
            verifier_id=pr.person_id,
            type=type_,
            result=result,
            comment=comment,
        )
    )
    if result == "approved":
        if t["status"] in ("submitted", "passed"):
            conn.execute(update(task).where(task.c.id == t["id"]).values(status="verified"))
    elif result == "rejected":
        # Back to Open for a redo with the reason (§5). The rejected submission stays in the record.
        conn.execute(
            update(task).where(task.c.id == t["id"]).values(status="open", completed_by=None, completed_at=None)
        )
        notify.notify(
            conn,
            {sub["submitter_id"]},
            kind="check.rejected",
            klass=t["klass"],
            title=f"{t['template_name']}: send again",
            body=f'{pr.name}: "{comment}"',
            link=f"/task/{t['id']}",
        )
    elif result == "needs_action":
        action_service.raise_action(
            conn,
            actor,
            property_id=t["property_id"],
            description=f"{t['template_name']}: {comment or 'raised from evidence review'}",
            source="failed_check",
            source_ref=f"Evidence review {t['ref']}",
            klass=t["klass"],
            register_item_id=t["register_item_id"],
            task_id=t["id"],
            submission_id=submission_id,
        )
    audit.record(
        conn,
        actor,
        category="check",
        action=f"verification.{result}",
        summary={
            "approved": "Approved a check",
            "rejected": "Rejected a check and reopened it",
            "needs_action": "Raised an Action from a check under review",
        }[result],
        entity_type="submission",
        entity_id=submission_id,
        entity_ref=t["ref"],
        property_id=t["property_id"],
        after={"result": result, "comment": comment},
    )
    recompute_item(conn, t["register_item_id"])
    return {"ok": True}


def amend(
    conn: Connection,
    pr: Principal,
    actor: audit.Actor,
    submission_id: uuid.UUID,
    *,
    reason_type: str,
    reason: str,
    changes: dict,
) -> dict:
    pr.require("submission.amend")
    sub = conn.execute(select(submission).where(submission.c.id == submission_id)).mappings().first()
    if not sub:
        raise problem(404, "not_found", "Not found.")
    if not reason.strip():
        raise problem(422, "reason", "Say why you're changing it.")
    t = load_task(conn, sub["task_id"])
    conn.execute(
        amendment.insert().values(
            id=uuid.uuid4(),
            submission_id=submission_id,
            author_id=pr.person_id,
            reason_type=reason_type,
            reason=reason,
            changes=changes,
        )
    )
    audit.record(
        conn,
        actor,
        category="amendment",
        action="submission.amend",
        summary="Added a correction to a locked check",
        entity_type="submission",
        entity_id=submission_id,
        entity_ref=t["ref"],
        property_id=t["property_id"],
        before={k: sub["values"].get(k) for k in changes},
        after=changes,
    )
    return {"ok": True}


def request_exception(
    conn: Connection,
    pr: Principal,
    actor: audit.Actor,
    *,
    kind: str,
    reason: str,
    note: str | None,
    task_id: uuid.UUID | None = None,
    register_item_id: uuid.UUID | None = None,
    payload: dict | None = None,
) -> dict:
    """N/A, Missed reason, switch-off, pause, back-file: someone else must approve (SCH-10..12)."""
    if task_id:
        t = load_task(conn, task_id)
        register_item_id = t["register_item_id"]
        property_id = t["property_id"]
        klass = t["klass"]
    else:
        item = conn.execute(
            select(register_item.c.property_id, template.c["class"])
            .join(template, template.c.id == register_item.c.template_id)
            .where(register_item.c.id == register_item_id)
        ).first()
        if not item:
            raise problem(404, "not_found", "Not found.")
        property_id, klass = item.property_id, item[1]
    pr.require_property(property_id)
    if not reason.strip():
        raise problem(422, "reason", "Give a reason.")
    rid = uuid.uuid4()
    conn.execute(
        approval_request.insert().values(
            id=rid,
            kind=kind,
            property_id=property_id,
            register_item_id=register_item_id,
            task_id=task_id,
            requested_by=pr.person_id,
            reason=reason,
            note=note,
            payload=payload or {},
        )
    )
    audit.record(
        conn,
        actor,
        category="record",
        action=f"approval.request.{kind}",
        summary={
            "na": "Asked to mark a check not applicable",
            "missed": "Gave a reason for a missed check",
            "switch_off": "Asked to switch off a check",
            "pause": "Asked to pause a check",
            "backfile": "Back-filed a paper record for approval",
        }.get(kind, "Made a request"),
        entity_type="approval",
        entity_id=rid,
        property_id=property_id,
        after={"reason": reason, "class": klass},
    )
    owner = action_service.system_owner(conn)
    if owner and owner != pr.person_id:
        notify.notify(
            conn,
            {owner},
            kind="approval.waiting",
            klass=klass,
            title="A request is waiting for you",
            body=reason[:200],
            link="/approvals",
        )
    return {"id": str(rid)}


def spot_check_sample(conn: Connection, since: datetime, rate: int = 10) -> list[uuid.UUID]:
    """The system owner's weekly evidence spot-check: 1 in 10 of last week's passed submissions (VER-02)."""
    ids = list(
        conn.execute(
            select(submission.c.id)
            .join(task, task.c.id == submission.c.task_id)
            .where(submission.c.server_time >= since, task.c.status == "passed")
        ).scalars()
    )
    k = max(1, len(ids) // rate) if ids else 0
    return random.sample(ids, k) if k else []
