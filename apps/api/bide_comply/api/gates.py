"""Opening checklists (BH-CMP-002) and dutyholder sign-offs (GATE-01..04, SGN-01)."""

import hashlib
import uuid
from datetime import date

from fastapi import APIRouter, Request
from pydantic import BaseModel
from sqlalchemy import func, select, update

from bide_comply import audit, clock
from bide_comply.api.register import resolve_property
from bide_comply.auth import Current, actor_for
from bide_comply.authz import scope_filter
from bide_comply.db import ConnDep
from bide_comply.engine import gate as rules
from bide_comply.schema import (
    action,
    dutyholder,
    dutyholder_director,
    evidence,
    gate,
    gate_item,
    gate_item_evidence,
    property_,
    register_item,
    signature_request,
    signoff,
)
from bide_comply.services import evidence as ev_service
from bide_comply.services import views
from bide_comply.services.common import fmt_date, names, problem
from bide_comply.services.register import recompute_item

router = APIRouter(prefix="/api", tags=["gates"])

STATUS_LABEL = {
    "not_started": "Not started",
    "in_progress": "In progress",
    "to_confirm": "To confirm",
    "done": "Done",
    "na": "N/A",
}
GATE_LABEL = {
    rules.NOT_READY: "Not ready",
    rules.READY: "Ready to open",
    rules.TRADING_A_OPEN: "Open · life-safety items missing",
}


@router.get("/gates")
def list_gates(pr: Current, conn: ConnDep) -> dict:
    out = []
    for p in views.visible_properties(conn, pr):
        gs = views.gate_summary(conn, p["id"], p["stage"] == "trading")
        if not gs:
            continue
        acts = conn.execute(
            select(func.count()).where(action.c.property_id == p["id"], action.c.status != "closed")
        ).scalar()
        out.append(
            {
                "property_id": str(p["id"]),
                "code": p["code"],
                "property": p["name"],
                "status": gs.status,
                "status_label": GATE_LABEL[gs.status],
                "applicable": gs.applicable,
                "done": gs.done,
                "percent": gs.percent,
                "class_a_open": gs.class_a_open,
                "to_confirm": gs.to_confirm,
                "actions_open": acts,
                "opening_date": p["opening_date"],
                "stage": p["stage"],
            }
        )
    return {"rows": out}


@router.get("/gates/{key}")
def gate_detail(key: str, pr: Current, conn: ConnDep, section: str | None = None) -> dict:
    p = resolve_property(conn, pr, key)
    g = conn.execute(select(gate).where(gate.c.property_id == p["id"])).mappings().first()
    if not g:
        raise problem(404, "not_found", "This property has no opening checklist yet.")
    gs = views.gate_summary(conn, p["id"], p["stage"] == "trading")
    items = [
        dict(r)
        for r in conn.execute(
            select(gate_item).where(gate_item.c.gate_id == g["id"]).order_by(gate_item.c.sort)
        ).mappings()
    ]
    ev = {}
    for r in conn.execute(
        select(gate_item_evidence.c.gate_item_id, evidence.c.id, evidence.c.file_name)
        .join(evidence, evidence.c.id == gate_item_evidence.c.evidence_id)
        .join(gate_item, gate_item.c.id == gate_item_evidence.c.gate_item_id)
        .where(gate_item.c.gate_id == g["id"])
    ):
        ev.setdefault(r.gate_item_id, []).append({"id": str(r.id), "name": r.file_name})
    who = names(conn, {i["owner_id"] for i in items})
    acts = conn.execute(
        select(action.c.priority, action.c.type, action.c.due_on, action.c.gate_ref).where(
            action.c.property_id == p["id"], action.c.status != "closed"
        )
    ).all()
    today = clock.today()
    dh = (
        conn.execute(select(dutyholder.c.name).where(dutyholder.c.id == p["dutyholder_id"])).scalar()
        if p["dutyholder_id"]
        else None
    )
    signed = (
        conn.execute(select(signoff).where(signoff.c.id == g["signoff_id"])).mappings().first()
        if g["signoff_id"]
        else None
    )
    rows = []
    for i in items:
        has_ev = bool(i["evidence_link"]) or bool(ev.get(i["id"]))
        rows.append(
            {
                "id": str(i["id"]),
                "ref": i["ref"],
                "section": i["section"],
                "item": i["item"],
                "class": i["class"],
                "legal_basis": i["legal_basis"],
                "evidence_required": i["evidence_required"],
                "applies": i["applies"],
                "na_reason": i["na_reason"],
                "status": i["status"],
                "status_label": STATUS_LABEL[i["status"]],
                "done_without_evidence": i["status"] == "done" and not has_ev,
                "owner": who.get(i["owner_id"]) or i["owner_text"],
                "due_on": i["due_on"],
                "evidence_link": i["evidence_link"],
                "evidence": ev.get(i["id"], []),
                "notes": i["notes"],
                "wording_pending": rules_pending(i["item"]),
                "actions": sum(1 for a in acts if a.gate_ref == i["ref"]),
            }
        )
    sec = section or next((s["key"] for s in gs.sections if s["a_open"]), "A")
    a_items = [r for r in rows if r["class"] == "A" and r["applies"] and r["status"] != "na"]
    return {
        "property_id": str(p["id"]),
        "code": p["code"],
        "property": p["name"],
        "dutyholder": dh,
        "stage": p["stage"],
        "trading_since": p["trading_since"],
        "opening_date": p["opening_date"],
        "subtitle": f"{dh or 'Dutyholder to confirm'} · "
        + (
            f"trading since {fmt_date(p['trading_since'], True)}"
            if p["trading_since"]
            else f"opens {p['opening_date']:%b %Y}"
            if p["opening_date"]
            else "not open yet"
        ),
        "status": gs.status,
        "status_label": GATE_LABEL[gs.status],
        "summary": {
            "applicable": gs.applicable,
            "done": gs.done,
            "percent": gs.percent,
            "class_a_open": gs.class_a_open,
            "class_a_applicable": gs.class_a_applicable,
            "class_a_done": gs.class_a_done,
            "to_confirm": gs.to_confirm,
            "actions_urgent": sum(1 for a in acts if a.priority == "high"),
            "actions_other": sum(1 for a in acts if a.priority != "high"),
            "actions_overdue": sum(1 for a in acts if a.due_on < today),
            "advisories_open": sum(1 for a in acts if a.type == "advisory"),
        },
        "sections": [{**s, "name": rules.SECTIONS[s["key"]]} for s in gs.sections],
        "selected_section": sec,
        "items": rows,
        "signoff": {
            "can_sign": rules.can_sign(gs) and pr.can("sign.dutyholder", p["id"]) and not signed,
            "unlocked": rules.can_sign(gs),
            "signed": {"by": names(conn, {signed["signer_id"]}).get(signed["signer_id"]), "at": signed["signed_at"]}
            if signed
            else None,
            "class_a_done": gs.class_a_done,
            "class_a_applicable": len(a_items),
            "signer": f"{dh} directors" if dh else "The SPV's directors",
        },
        "can_edit": pr.can("register.toggle", p["id"]) or pr.can("assign", p["id"]),
    }


def rules_pending(item: str) -> bool:
    from bide_comply.seed.library import TO_LOAD

    return TO_LOAD in item


class GateItemIn(BaseModel):
    status: str | None = None
    applies: bool | None = None
    na_reason: str | None = None
    owner_id: uuid.UUID | None = None
    due_on: date | None = None
    notes: str | None = None
    evidence_link: str | None = None
    evidence_ids: list[uuid.UUID] = []


@router.patch("/gate-items/{item_id}")
def update_item(item_id: uuid.UUID, body: GateItemIn, request: Request, pr: Current, conn: ConnDep) -> dict:
    it = (
        conn.execute(
            select(gate_item, gate.c.property_id)
            .join(gate, gate.c.id == gate_item.c.gate_id)
            .where(gate_item.c.id == item_id)
        )
        .mappings()
        .first()
    )
    if not it:
        raise problem(404, "not_found", "Not found.")
    pr.require_property(it["property_id"])
    if not (pr.can("register.toggle", it["property_id"]) or pr.can("assign", it["property_id"])):
        raise problem(403, "forbidden", "You can't change this checklist.")
    vals = {k: v for k, v in body.model_dump(exclude={"evidence_ids"}).items() if v is not None}
    if body.status and body.status not in STATUS_LABEL:
        raise problem(422, "status", "Unknown status.")
    if body.applies is False or body.status == "na":
        if not (body.na_reason or it["na_reason"]):
            raise problem(422, "na_reason", "Give a reason why this doesn't apply here.")
        vals |= {"applies": False, "status": "na"}
    if it["ref"] == "H08" and body.status == "done":
        raise problem(409, "signoff", "H08 is done by the dutyholder signing the checklist.")
    for e in ev_service.stored(conn, body.evidence_ids, pr.person_id):
        conn.execute(gate_item_evidence.insert().values(gate_item_id=item_id, evidence_id=e["id"]))
    if body.status == "done":
        has = bool(vals.get("evidence_link") or it["evidence_link"]) or bool(
            conn.execute(
                select(gate_item_evidence.c.evidence_id).where(gate_item_evidence.c.gate_item_id == item_id)
            ).first()
        )
        if not has:
            # No evidence, not done: it stays To confirm until the evidence is attached.
            vals["status"] = "to_confirm"
    if vals:
        conn.execute(update(gate_item).where(gate_item.c.id == item_id).values(**vals))
        b, a = audit.diff(dict(it), {**dict(it), **vals})
        audit.record(
            conn,
            actor_for(request, pr),
            category="record",
            action="gate.update",
            summary=f"Updated opening checklist item {it['ref']}",
            entity_type="gate_item",
            entity_id=item_id,
            entity_ref=it["ref"],
            property_id=it["property_id"],
            before=b,
            after=a,
        )
    if it["ref"] == "H02" and vals.get("status") == "done":
        # H02 "recurring checks loaded": the property's register goes live.
        for iid in conn.execute(
            select(register_item.c.id).where(
                register_item.c.property_id == it["property_id"], register_item.c.state == "draft"
            )
        ).scalars():
            conn.execute(update(register_item).where(register_item.c.id == iid).values(state="on"))
            recompute_item(conn, iid)
    return {"status": vals.get("status", it["status"])}


class SignIn(BaseModel):
    confirm: bool
    full_name: str


@router.post("/gates/{key}/sign")
def sign_gate(key: str, body: SignIn, request: Request, pr: Current, conn: ConnDep) -> dict:
    p = resolve_property(conn, pr, key)
    pr.require("sign.dutyholder", p["id"])
    gs = views.gate_summary(conn, p["id"], p["stage"] == "trading")
    if not gs or not rules.can_sign(gs):
        raise problem(
            409,
            "locked",
            f"You can sign once all {gs.class_a_applicable if gs else 0} life-safety items are "
            f"done. {gs.class_a_done if gs else 0} done so far.",
        )
    if not body.confirm or not body.full_name.strip():
        raise problem(422, "confirm", "Tick the statement and type your full name to sign.")
    g = conn.execute(select(gate).where(gate.c.property_id == p["id"])).mappings().one()
    items = conn.execute(
        select(gate_item.c.ref, gate_item.c.status, gate_item.c.applies)
        .where(gate_item.c.gate_id == g["id"])
        .order_by(gate_item.c.ref)
    ).all()
    content = "|".join(f"{r.ref}:{r.status}:{r.applies}" for r in items)
    statement = (
        f"I confirm every applicable life-safety item on the opening checklist for {p['name']} is done with "
        f"evidence. I sign on behalf of the dutyholder."
    )
    sid = _signoff(
        conn, pr, p, "gate", statement, body.full_name, f"Opening checklist v{g['template_version']}", content
    )
    conn.execute(update(gate).where(gate.c.id == g["id"]).values(signoff_id=sid))
    conn.execute(
        update(gate_item).where(gate_item.c.gate_id == g["id"], gate_item.c.ref == "H08").values(status="done")
    )
    conn.execute(
        update(signature_request)
        .where(signature_request.c.property_id == p["id"], signature_request.c.type == "gate")
        .values(status="signed", signoff_id=sid)
    )
    audit.record(
        conn,
        actor_for(request, pr),
        category="record",
        action="signoff.gate",
        summary=f"Signed the opening checklist for {p['name']}",
        entity_type="signoff",
        entity_id=sid,
        property_id=p["id"],
    )
    return {"id": str(sid)}


def _signoff(conn, pr, p, type_, statement, name, subject, content) -> uuid.UUID:
    sid = uuid.uuid4()
    digest = hashlib.sha256(f"{statement}\n{subject}\n{content}".encode()).hexdigest()
    dh = conn.execute(
        select(dutyholder_director.c.dutyholder_id).where(
            dutyholder_director.c.person_id == pr.person_id, dutyholder_director.c.dutyholder_id == p["dutyholder_id"]
        )
    ).scalar()
    conn.execute(
        signoff.insert().values(
            id=sid,
            type=type_,
            property_id=p["id"],
            signer_id=pr.person_id,
            dutyholder_id=dh,
            statement=statement,
            signed_name=name.strip(),
            subject=subject,
            content_hash=digest,
            signed_at=clock.now(),
        )
    )
    return sid


# ---------------------------------------------------------------------------------------------------------------------
# Dutyholder view: what's awaiting my signature (design: Dutyholder sign-off)
# ---------------------------------------------------------------------------------------------------------------------


@router.get("/signoffs")
def my_signoffs(pr: Current, conn: ConnDep, property: uuid.UUID | None = None) -> dict:  # noqa: A002
    props = views.visible_properties(conn, pr, property)
    out_props = []
    for p in props:
        if not (pr.can("sign.dutyholder", p["id"]) or pr.is_admin or pr.can("sign.countersign", p["id"])):
            continue
        s = views.property_summary(conn, p)
        gs = views.gate_summary(conn, p["id"], p["stage"] == "trading")
        reqs = []
        for r in conn.execute(
            select(signature_request, evidence.c.file_name, action.c.ref.label("action_ref"))
            .outerjoin(evidence, evidence.c.id == signature_request.c.evidence_id)
            .outerjoin(action, action.c.id == signature_request.c.action_id)
            .where(signature_request.c.property_id == p["id"], signature_request.c.status != "signed")
            .order_by(signature_request.c.due_on.nulls_last())
        ).mappings():
            locked = r["type"] == "gate" and not (gs and rules.can_sign(gs))
            if r["type"] == "gate":
                detail = (
                    (
                        f"Locked until all {gs.class_a_applicable} life-safety items are Done with evidence · {gs.class_a_done} done"
                        if locked
                        else "Every life-safety item is done. Ready to sign."
                    )
                    if gs
                    else ""
                )
            elif r["status"] == "scheduled":
                detail = f"Opens {r['opens_on']:%a} {fmt_date(r['opens_on'], True)}" if r["opens_on"] else "Scheduled"
            else:
                detail = " · ".join(
                    x
                    for x in [
                        f"Gate {r['gate_ref']}" if r["gate_ref"] else None,
                        f"Action {r['action_ref']}" if r["action_ref"] else None,
                        "after a site walk" if r["type"] == "fra" else None,
                    ]
                    if x
                )
            reqs.append(
                {
                    "id": str(r["id"]),
                    "type": r["type"],
                    "title": r["title"],
                    "subject": r["subject"],
                    "detail": detail,
                    "due_on": r["due_on"],
                    "status": "locked" if locked else r["status"],
                    "file_name": r["file_name"],
                    "evidence_id": str(r["evidence_id"]) if r["evidence_id"] else None,
                    "preconditions": r["preconditions"],
                }
            )
        # Advisories that need the dutyholder's decision sit beside the signatures.
        for a in conn.execute(
            select(action).where(
                action.c.property_id == p["id"],
                action.c.type == "advisory",
                action.c.status != "closed",
                action.c.priority == "high",
            )
        ).mappings():
            reqs.insert(
                1 if reqs else 0,
                {
                    "id": str(a["id"]),
                    "type": "advisory",
                    "title": _decide_title(a["description"]),
                    "detail": f"Advisory {a['ref']} · {a['description'][:80]}",
                    "due_on": a["due_on"],
                    "status": "open",
                    "action_ref": a["ref"],
                },
            )
        insurer = conn.execute(
            select(action.c.source_ref, action.c.due_on, action.c.description)
            .where(action.c.property_id == p["id"], action.c.source == "insurer", action.c.status != "closed")
            .order_by(action.c.due_on)
            .limit(1)
        ).first()
        dh = (
            conn.execute(select(dutyholder.c.name).where(dutyholder.c.id == p["dutyholder_id"])).scalar()
            if p["dutyholder_id"]
            else None
        )
        out_props.append(
            {
                "property_id": str(p["id"]),
                "code": p["code"],
                "property": p["name"],
                "town": p["town"],
                "dutyholder": dh,
                "status": s["score_status"],
                "red_line": s["red_line"],
                "gate_a_open": gs.class_a_open if gs else None,
                "urgent_open": s["actions"]["urgent"],
                "insurer": {
                    "label": insurer.description.split(":")[0].replace("Insurance condition ", "Insurer condition "),
                    "due_on": insurer.due_on,
                }
                if insurer
                else None,
                "requests": reqs,
                "awaiting": sum(1 for r in reqs if r["status"] == "open"),
            }
        )
    return {"properties": out_props}


def _decide_title(desc: str) -> str:
    if "ARC" in desc and "call" in desc.lower():
        return "Decide the ARC call order and record it in the FRA"
    return "Decide: " + desc.split(".")[0]


class SignRequestIn(BaseModel):
    confirm: bool
    full_name: str


@router.post("/signoffs/{request_id}/sign")
def sign_request(request_id: uuid.UUID, body: SignRequestIn, request: Request, pr: Current, conn: ConnDep) -> dict:
    r = conn.execute(select(signature_request).where(signature_request.c.id == request_id)).mappings().first()
    if not r:
        raise problem(404, "not_found", "Not found.")
    p = conn.execute(select(property_).where(property_.c.id == r["property_id"])).mappings().one()
    pr.require_property(p["id"])
    if r["type"] == "fra_countersign":
        pr.require("sign.countersign", p["id"])
    else:
        pr.require("sign.dutyholder", p["id"])
    if r["status"] != "open":
        raise problem(
            409, "not_open", "This isn't open for signing yet." if r["status"] == "scheduled" else "Already signed."
        )
    if r["type"] == "gate":
        return sign_gate(p["code"], SignIn(confirm=body.confirm, full_name=body.full_name), request, pr, conn)
    if not body.confirm or not body.full_name.strip():
        raise problem(422, "confirm", "Tick the statement and type your full name to sign.")
    content = ""
    if r["evidence_id"]:
        content = conn.execute(select(evidence.c.sha256).where(evidence.c.id == r["evidence_id"])).scalar() or ""
    dh = conn.execute(select(dutyholder.c.name).where(dutyholder.c.id == p["dutyholder_id"])).scalar()
    statement = {
        "fra": f"I confirm I have site-walked {p['name']} and reviewed this Fire Risk Assessment and Fire Plan. I sign it on "
        f"behalf of {dh} as dutyholder.",
        "quarterly": f"I have reviewed the compliance register for {p['name']} for {r['subject']} and sign it off on behalf of {dh}.",
        "fra_countersign": f"As competent assessor I countersign the Fire Risk Assessment for {p['name']}.",
    }.get(r["type"], r["title"])
    sid = _signoff(conn, pr, p, r["type"], statement, body.full_name, r["subject"], content)
    conn.execute(
        update(signature_request).where(signature_request.c.id == request_id).values(status="signed", signoff_id=sid)
    )
    if r["register_item_id"]:
        recompute_item(conn, r["register_item_id"])
    audit.record(
        conn,
        actor_for(request, pr),
        category="record",
        action=f"signoff.{r['type']}",
        summary=f"Signed {r['title']}",
        entity_type="signoff",
        entity_id=sid,
        property_id=p["id"],
        after={"subject": r["subject"], "fingerprint": content[:12]},
    )
    return {"id": str(sid)}


@router.get("/signoffs/history")
def signoff_history(pr: Current, conn: ConnDep) -> dict:
    rows = (
        conn.execute(
            select(signoff, property_.c.name.label("property"))
            .join(property_, property_.c.id == signoff.c.property_id)
            .where(scope_filter(pr, signoff.c.property_id))
            .order_by(signoff.c.signed_at.desc())
        )
        .mappings()
        .all()
    )
    who = names(conn, {r["signer_id"] for r in rows})
    return {
        "rows": [
            {
                "id": str(r["id"]),
                "type": r["type"],
                "property": r["property"],
                "signer": who.get(r["signer_id"]),
                "signed_name": r["signed_name"],
                "subject": r["subject"],
                "signed_at": r["signed_at"],
                "fingerprint": r["content_hash"][:12],
            }
            for r in rows
        ]
    }
