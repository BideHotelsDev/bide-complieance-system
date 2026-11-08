"""Offboarding a person (§9.2, SCH-06): access ends, every device is signed out, and their checks move to the cover or
are flagged "needs owner". Settings › People does it by hand; Bide Hub does it when an admin there switches someone
off (the account-disabled back-channel logout, auth.py)."""

import uuid

from sqlalchemy import Connection, select, update

from bide_comply import audit, clock
from bide_comply.auth import revoke_person
from bide_comply.schema import person, pool_member, register_item
from bide_comply.services import notify
from bide_comply.services.register import sync_open_tasks


def offboard(conn: Connection, person_id: uuid.UUID, actor: audit.Actor, via: str = "") -> tuple[int, int]:
    """Returns (checks moved to cover, checks that need a new owner). via is added to the audit summary."""
    p = conn.execute(select(person).where(person.c.id == person_id)).mappings().one()
    conn.execute(
        update(person).where(person.c.id == person_id).values(employment_status="leaver", left_on=clock.today())
    )
    revoke_person(conn, person_id)
    moved, flagged = 0, 0
    for it in conn.execute(
        select(register_item).where(
            (register_item.c.accountable_id == person_id) | (register_item.c.done_by_person_id == person_id)
        )
    ).mappings():
        vals: dict = {}
        if it["cover_id"] and it["cover_id"] != person_id:
            if it["accountable_id"] == person_id:
                vals["accountable_id"] = it["cover_id"]
            if it["done_by_person_id"] == person_id:
                vals["done_by_person_id"] = it["cover_id"]
            moved += 1
        else:
            if it["accountable_id"] == person_id:
                vals["accountable_id"] = None
            if it["done_by_person_id"] == person_id:
                vals |= {"done_by_person_id": None, "done_by_kind": None}
            flagged += 1
        vals["needs_owner"] = not (vals.get("accountable_id", it["accountable_id"]))
        conn.execute(update(register_item).where(register_item.c.id == it["id"]).values(**vals))
        # Their unfinished tasks go with the check: to the cover, or to nobody until a new owner is named.
        sync_open_tasks(conn, it["id"])
    conn.execute(update(register_item).where(register_item.c.cover_id == person_id).values(cover_id=None))
    conn.execute(pool_member.delete().where(pool_member.c.person_id == person_id))
    if flagged:
        notify.notify(
            conn,
            notify.resolve(conn, [{"kind": "role", "role": "system_owner"}], None),
            kind="people.needs_owner",
            title=f"{flagged} checks need a new owner after {p['name']} left",
            link="/settings/setup",
        )
    audit.record(
        conn,
        actor,
        category="settings",
        action="people.offboard",
        summary=f"Offboarded {p['name']}{via}: access ended, {moved} checks moved to cover, {flagged} need a new owner",
        entity_type="person",
        entity_id=person_id,
    )
    return moved, flagged
