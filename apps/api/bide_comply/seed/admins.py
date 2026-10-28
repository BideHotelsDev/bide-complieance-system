"""First Super Admins for a new install (an empty production database has nobody who can sign in).

BOOTSTRAP_ADMINS lists them, comma-separated, as "Name <email>" or just "email" (the name is then taken from the
address). At start-up they are added only while nobody holds an active Super Admin role, so removing or demoting
someone in Settings › People sticks after the next deploy. `python -m bide_comply.seed --admin "Name <email>"` adds
one by hand at any time.
"""

import re
import uuid

from sqlalchemy import Connection, func, select, update
from sqlalchemy.dialects.postgresql import insert as pg_insert

from bide_comply import audit
from bide_comply.config import settings
from bide_comply.schema import person, role_assignment

ENTRY = re.compile(r"^\s*(?:(?P<name>[^<>]+?)\s*<(?P<email>[^<>\s]+)>|(?P<bare>[^<>\s]+))\s*$")
EMAIL = re.compile(r"^[^@\s]+@[^@\s]+\.[^@\s]+$")


def parse(entries: str) -> list[tuple[str, str]]:
    """'Kyle Mendoza <kyle@x.com>, sam.kirk@x.com' -> [("Kyle Mendoza", "kyle@x.com"), ("Sam Kirk", "sam.kirk@x.com")]"""
    out = []
    for raw in entries.split(","):
        if not raw.strip():
            continue
        m = ENTRY.match(raw)
        email = (m and (m["email"] or m["bare"]) or "").lower()
        if not EMAIL.match(email):
            raise ValueError(f"Not an email address: {raw.strip()!r}. Use 'Name <email>' or 'email'.")
        name = m["name"] or " ".join(w.capitalize() for w in re.split(r"[._+-]+", email.split("@")[0]) if w)
        out.append((name, email))
    return out


def has_super_admin(conn: Connection) -> bool:
    return bool(
        conn.execute(
            select(func.count())
            .select_from(role_assignment.join(person, person.c.id == role_assignment.c.person_id))
            .where(role_assignment.c.role == "super_admin", person.c.employment_status == "active")
        ).scalar()
    )


def add(conn: Connection, name: str, email: str) -> str:
    """Make this person an active staff member with the group Super Admin role. Returns what was done."""
    if email.split("@")[1] not in settings.workspace_domains:
        print(f"  note: {email} is outside {settings.google_workspace_domains}, so Google sign-in will refuse it.")
    p = conn.execute(select(person.c.id, person.c.employment_status).where(person.c.email == email)).first()
    if p:
        pid = p.id
        if p.employment_status != "active":
            conn.execute(update(person).where(person.c.id == pid).values(employment_status="active", left_on=None))
    else:
        pid = uuid.uuid4()
        conn.execute(person.insert().values(id=pid, name=name, email=email, kind="staff"))
    added = conn.execute(
        pg_insert(role_assignment)
        .values(id=uuid.uuid4(), person_id=pid, role="super_admin", property_id=None)
        .on_conflict_do_nothing()
    ).rowcount
    if not p or added:
        audit.record(
            conn,
            audit.SYSTEM,
            category="settings",
            action="people.bootstrap_admin",
            summary=f"Gave {name if not p else 'someone'} the Super Admin role (first-admin setup)",
            entity_type="person",
            entity_id=pid,
            after={"email": email, "role": "super_admin"},
        )
    return "added" if not p else "made Super Admin" if added else "already a Super Admin"


def run(conn: Connection, entries: str | None = None, force: bool = False) -> None:
    """Add the listed admins (BOOTSTRAP_ADMINS by default). Skipped once an active Super Admin exists, unless force."""
    wanted = parse(settings.bootstrap_admins if entries is None else entries)
    if not wanted:
        return
    if not force and has_super_admin(conn):
        print("BOOTSTRAP_ADMINS: a Super Admin already exists; nothing to do (you can remove the variable).")
        return
    for name, email in wanted:
        print(f"Super Admin: {email} {add(conn, name, email)}.")
