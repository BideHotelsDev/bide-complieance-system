"""Settings › Property setup (design: Register setup per property): which templates apply here and who does each one.
Activation is blocked while any row still has no real name (golden rule 2). Adding a property proposes the
templates whose applies-to rules match it (CMS-10); copying another property's setup clones its plan (CMS-05).
"""

import uuid

from fastapi import APIRouter, Query, Request
from pydantic import BaseModel
from sqlalchemy import select, update

from bide_comply import audit, clock
from bide_comply.api import listing
from bide_comply.api.register import resolve_property
from bide_comply.auth import Current, actor_for
from bide_comply.db import ConnDep
from bide_comply.engine import frequency as freq
from bide_comply.schema import (
    approval_request,
    contractor,
    domain,
    gate,
    gate_item,
    gate_template_item,
    pool,
    property_,
    register_item,
    template,
)
from bide_comply.services.common import names, next_ref, problem
from bide_comply.services.register import recompute_item, refresh_item

router = APIRouter(prefix="/api/setup", tags=["setup"])


def applies(rule: dict, p: dict) -> bool:
    """Does a template's applies-to rule match this property? {"all": [...]} or {"any": [...]} of conditions."""
    feats = p["features"] or {}

    def ok(c: dict) -> bool:
        if "feature" in c:
            return bool(feats.get(c["feature"]))
        if "licence_regime" in c:
            return p["licence_regime"] == c["licence_regime"]
        if "jurisdiction" in c:
            return p["jurisdiction"] in c["jurisdiction"]
        return True

    if not rule:
        return True
    if "all" in rule:
        return all(ok(c) for c in rule["all"])
    if "any" in rule:
        return any(ok(c) for c in rule["any"])
    return True


@router.get("/{key}")
def setup(
    key: str, pr: Current, conn: ConnDep, q: str | None = None, view: str = "all", area: list[str] | None = Query(None)
) -> dict:
    pr.require("settings.view")
    p = resolve_property(conn, pr, key)
    tpls = [
        dict(t)
        for t in conn.execute(
            select(template, domain.c.key.label("domain_key"), domain.c.name.label("domain"))
            .join(domain, domain.c.id == template.c.domain_id)
            .where(template.c.status == "published")
            .order_by(template.c.sort)
        ).mappings()
    ]
    items = {
        r["template_id"]: dict(r)
        for r in conn.execute(select(register_item).where(register_item.c.property_id == p["id"])).mappings()
    }
    who = names(
        conn,
        {i["accountable_id"] for i in items.values()}
        | {i["cover_id"] for i in items.values()}
        | {i["done_by_person_id"] for i in items.values()}
        | {i["verifier_id"] for i in items.values()},
    )
    pools = {r.id: r.name for r in conn.execute(select(pool.c.id, pool.c.name))}
    cons = {r.id: r.name for r in conn.execute(select(contractor.c.id, contractor.c.name))}
    pending = {
        r.register_item_id: r
        for r in conn.execute(
            select(approval_request).where(
                approval_request.c.status == "waiting",
                approval_request.c.kind == "switch_off",
                approval_request.c.property_id == p["id"],
            )
        )
    }
    pnames = names(conn, {r.requested_by for r in pending.values()})
    rows = []
    for t in tpls:
        it = items.get(t["id"])
        proposed = applies(t["applies_to"], p)
        if it:
            on = it["state"] in ("on", "draft", "paused")
            k = it["done_by_kind"]
            doer = (
                who.get(it["done_by_person_id"])
                if k == "person"
                else pools.get(it["done_by_pool_id"])
                if k == "pool"
                else cons.get(it["done_by_contractor_id"])
                if k == "contractor"
                else None
            )
            ready = bool(doer and it["accountable_id"])
            pend = pending.get(it["id"])
            rows.append(
                {
                    "template_id": str(t["id"]),
                    "item_id": str(it["id"]),
                    "ref": it["ref"],
                    "template": t["name"],
                    "class": t["class"],
                    "domain_key": t["domain_key"],
                    "domain": t["domain"],
                    "applies": on,
                    "frequency": it["frequency"] or t["default_frequency"],
                    "frequency_label": freq.label(it["frequency"] or t["default_frequency"]),
                    "frequency_default": freq.label(t["default_frequency"]) if it["frequency"] else None,
                    "frequency_reason": it["frequency_reason"],
                    "done_by": doer or "TBC",
                    "done_by_kind": k,
                    "done_by_contractor": k == "contractor",
                    "accountable": who.get(it["accountable_id"]) or "TBC",
                    "cover": who.get(it["cover_id"]),
                    "verifier": who.get(it["verifier_id"])
                    or {"always": "Always verify", "sample": "Spot-check", "none": "None"}.get(
                        it["verifier_mode"] or t["verification"], "Spot-check"
                    ),
                    "setup": "off" if not on else ("ready" if ready else "needs_owner"),
                    "off_reason": it["state_reason"] if not on else None,
                    "switch_off_request": {
                        "id": str(pend.id),
                        "reason": pend.reason,
                        "by": pnames.get(pend.requested_by),
                    }
                    if pend
                    else None,
                    "state": it["state"],
                }
            )
        else:
            rows.append(
                {
                    "template_id": str(t["id"]),
                    "item_id": None,
                    "ref": None,
                    "template": t["name"],
                    "class": t["class"],
                    "domain_key": t["domain_key"],
                    "domain": t["domain"],
                    "applies": False,
                    "proposed": proposed,
                    "frequency": t["default_frequency"],
                    "frequency_label": freq.label(t["default_frequency"]),
                    "done_by": "—",
                    "accountable": "—",
                    "cover": None,
                    "verifier": None,
                    "setup": "not_added",
                    "done_by_hint": t["done_by_hint"],
                }
            )
    for r in rows:
        if r.get("switch_off_request"):
            r["setup"] = "off_requested"
    views = [
        listing.View("all", "All", lambda r: True),
        listing.View("needs_name", "Needs a name", lambda r: r["setup"] == "needs_owner"),
        listing.View("ready", "Ready", lambda r: r["setup"] == "ready"),
        listing.View("off", "Switched off", lambda r: r["setup"] in ("off", "off_requested", "not_added")),
    ]
    doms = sorted(
        {(r["domain_key"], r["domain"]) for r in rows}, key=lambda d: [x["domain_key"] for x in rows].index(d[0])
    )
    res = listing.run(
        rows,
        q=q,
        search=lambda r: r["template"],
        views=views,
        view=view,
        facets=[listing.Facet("area", "Area", lambda r: r["domain_key"], doms)],
        selected={"area": listing.multi(area)},
        page=1,
        page_size=100,
        noun=("template", "templates"),
    )
    on_rows = [r for r in rows if r["applies"]]
    tbc = [r for r in on_rows if r["setup"] == "needs_owner"]
    others = [
        {"code": x.code, "name": x.name}
        for x in conn.execute(
            select(property_.c.code, property_.c.name)
            .where(property_.c.id != p["id"])
            .where(property_.c.id.in_(select(register_item.c.property_id)))
        ).all()
    ]
    out = res.dump()
    out.update(
        {
            "property": p["name"],
            "code": p["code"],
            "property_id": str(p["id"]),
            "applies_count": len(on_rows),
            "total": len(rows),
            "off_count": sum(1 for r in rows if not r["applies"]),
            "needs_name": len(tbc),
            "can_activate": bool(on_rows) and not tbc and any(r["state"] == "draft" for r in on_rows if "state" in r),
            "has_draft": any(r.get("state") == "draft" for r in on_rows),
            "copy_from": others,
            "register_loaded": bool(items),
        }
    )
    return out


class ToggleIn(BaseModel):
    template_id: uuid.UUID
    applies: bool
    reason: str | None = None


@router.post("/{key}/toggle")
def toggle(key: str, body: ToggleIn, request: Request, pr: Current, conn: ConnDep) -> dict:
    p = resolve_property(conn, pr, key)
    actor = actor_for(request, pr)
    it = (
        conn.execute(
            select(register_item).where(
                register_item.c.property_id == p["id"], register_item.c.template_id == body.template_id
            )
        )
        .mappings()
        .first()
    )
    if not pr.can("register.toggle", p["id"]):
        # Site leads (and Systems) request; the system owner decides (§2).
        if not pr.can("register.request_toggle", p["id"]) or not it:
            raise problem(403, "forbidden", "Switching checks on or off here needs the system owner.")
        if not body.reason:
            raise problem(422, "reason", "Give a reason for switching it off.")
        from bide_comply.services import checks

        return checks.request_exception(
            conn, pr, actor, kind="switch_off", reason=body.reason, note=None, register_item_id=it["id"]
        )
    if not body.applies and not (body.reason and body.reason.strip()):
        raise problem(422, "reason", "Switching a check off needs a reason.")
    if it:
        state = ("draft" if it["state"] == "draft" else "on") if body.applies else "off"
        if body.applies and it["state"] == "off":
            state = "on"
        conn.execute(
            update(register_item)
            .where(register_item.c.id == it["id"])
            .values(state=state, state_reason=None if body.applies else body.reason)
        )
        iid, ref = it["id"], it["ref"]
    else:
        iid = uuid.uuid4()
        ref = next_ref(conn, p["id"])
        has_live = conn.execute(
            select(register_item.c.id)
            .where(register_item.c.property_id == p["id"], register_item.c.state == "on")
            .limit(1)
        ).first()
        conn.execute(
            register_item.insert().values(
                id=iid,
                ref=ref,
                property_id=p["id"],
                template_id=body.template_id,
                state="on" if has_live else "draft",
                needs_owner=True,
            )
        )
    audit.record(
        conn,
        actor,
        category="record",
        action="register.toggle",
        summary=f"{'Switched on' if body.applies else 'Switched off'} a check",
        entity_type="register_item",
        entity_id=iid,
        entity_ref=ref,
        property_id=p["id"],
        after={"applies": body.applies, "reason": body.reason},
    )
    recompute_item(conn, iid)
    return {"ref": ref}


@router.post("/{key}/load-master")
def load_master(key: str, request: Request, pr: Current, conn: ConnDep) -> dict:
    """Load the master list: every published template whose applies-to rule matches, in draft until activated."""
    pr.require("register.toggle")
    p = resolve_property(conn, pr, key)
    existing = set(
        conn.execute(select(register_item.c.template_id).where(register_item.c.property_id == p["id"])).scalars()
    )
    added = 0
    for t in conn.execute(
        select(template).where(template.c.status == "published").order_by(template.c.sort)
    ).mappings():
        if t["id"] in existing:
            continue
        on = applies(t["applies_to"], p)
        conn.execute(
            register_item.insert().values(
                id=uuid.uuid4(),
                ref=next_ref(conn, p["id"]),
                property_id=p["id"],
                template_id=t["id"],
                state="draft" if on else "off",
                state_reason=None if on else "Doesn't apply here (from the property's details)",
                needs_owner=True,
            )
        )
        added += 1
    _ensure_gate(conn, p["id"])
    audit.record(
        conn,
        actor_for(request, pr),
        category="record",
        action="register.load_master",
        summary=f"Loaded the master list ({added} templates)",
        entity_type="property",
        entity_id=p["id"],
        property_id=p["id"],
    )
    return {"added": added}


def _ensure_gate(conn, property_id: uuid.UUID) -> None:
    if conn.execute(select(gate.c.id).where(gate.c.property_id == property_id)).first():
        return
    gid = uuid.uuid4()
    conn.execute(gate.insert().values(id=gid, property_id=property_id))
    for it in conn.execute(select(gate_template_item).where(gate_template_item.c.version == 1)).mappings():
        conn.execute(
            gate_item.insert().values(
                id=uuid.uuid4(),
                gate_id=gid,
                ref=it["ref"],
                section=it["section"],
                item=it["item"],
                **{"class": it["class"]},
                legal_basis=it["legal_basis"],
                evidence_required=it["evidence_required"],
                owner_text=it["typical_owner"],
                sort=it["sort"],
            )
        )


class CopyIn(BaseModel):
    from_code: str


@router.post("/{key}/copy")
def copy_setup(key: str, body: CopyIn, request: Request, pr: Current, conn: ConnDep) -> dict:
    """Clone another property's plan (CMS-05). People named at a property are left for this one to fill in; groups
    and contractors carry over by name where this property has one of the same kind."""
    pr.require("register.toggle")
    p = resolve_property(conn, pr, key)
    src = resolve_property(conn, pr, body.from_code)
    existing = {
        r.template_id: r.id
        for r in conn.execute(
            select(register_item.c.template_id, register_item.c.id).where(register_item.c.property_id == p["id"])
        )
    }
    my_pools = {
        r.name.split(" – ")[0]: r.id
        for r in conn.execute(select(pool.c.id, pool.c.name).where(pool.c.property_id == p["id"]))
    }
    src_pools = {
        r.id: r.name.split(" – ")[0]
        for r in conn.execute(select(pool.c.id, pool.c.name).where(pool.c.property_id == src["id"]))
    }
    n = 0
    for it in conn.execute(select(register_item).where(register_item.c.property_id == src["id"])).mappings():
        vals = {
            "state": "draft" if it["state"] in ("on", "draft") else "off",
            "state_reason": it["state_reason"],
            "frequency": it["frequency"],
            "frequency_reason": it["frequency_reason"],
            "verifier_mode": it["verifier_mode"],
        }
        if it["done_by_kind"] == "contractor":
            vals |= {"done_by_kind": "contractor", "done_by_contractor_id": it["done_by_contractor_id"]}
        elif it["done_by_kind"] == "pool" and src_pools.get(it["done_by_pool_id"]) in my_pools:
            vals |= {"done_by_kind": "pool", "done_by_pool_id": my_pools[src_pools[it["done_by_pool_id"]]]}
        # Group people (system owner, register keeper) are the same people everywhere.
        if it["accountable_id"]:
            vals["accountable_id"] = it["accountable_id"]
        vals["needs_owner"] = not (vals.get("done_by_kind") and vals.get("accountable_id"))
        if it["template_id"] in existing:
            conn.execute(
                update(register_item)
                .where(register_item.c.id == existing[it["template_id"]], register_item.c.state == "draft")
                .values(**vals)
            )
        else:
            conn.execute(
                register_item.insert().values(
                    id=uuid.uuid4(),
                    ref=next_ref(conn, p["id"]),
                    property_id=p["id"],
                    template_id=it["template_id"],
                    **vals,
                )
            )
        n += 1
    audit.record(
        conn,
        actor_for(request, pr),
        category="record",
        action="register.copy",
        summary=f"Copied the setup from {src['name']} ({n} templates)",
        entity_type="property",
        entity_id=p["id"],
        property_id=p["id"],
    )
    return {"copied": n}


@router.post("/{key}/activate")
def activate(key: str, request: Request, pr: Current, conn: ConnDep) -> dict:
    pr.require("register.toggle")
    p = resolve_property(conn, pr, key)
    drafts = (
        conn.execute(
            select(register_item).where(register_item.c.property_id == p["id"], register_item.c.state == "draft")
        )
        .mappings()
        .all()
    )
    unnamed = [d["ref"] for d in drafts if not (d["accountable_id"] and d["done_by_kind"])]
    if unnamed:
        raise problem(
            409,
            "needs_owner",
            f"{len(unnamed)} items still say “TBC”. A task with no owner does not get done.",
            refs=unnamed,
        )
    for d in drafts:
        conn.execute(
            update(register_item).where(register_item.c.id == d["id"]).values(state="on", created_at=clock.now())
        )
        refresh_item(conn, d["id"])
    conn.execute(
        update(gate_item)
        .where(
            gate_item.c.gate_id.in_(select(gate.c.id).where(gate.c.property_id == p["id"])),
            gate_item.c.ref == "H02",
            gate_item.c.status != "done",
        )
        .values(status="in_progress")
    )
    audit.record(
        conn,
        actor_for(request, pr),
        category="record",
        action="register.activate",
        summary=f"Activated {len(drafts)} checks at {p['name']}",
        entity_type="property",
        entity_id=p["id"],
        property_id=p["id"],
    )
    return {"activated": len(drafts)}
