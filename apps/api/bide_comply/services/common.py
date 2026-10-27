"""Small helpers shared by the services: refs, names, labels, errors."""

import re
import uuid
from datetime import date, datetime

from fastapi import HTTPException
from sqlalchemy import Connection, select, update

from bide_comply import clock
from bide_comply.schema import contractor, person, pool, property_

GENERIC_NAMES = {"tbc", "tba", "housekeeping", "staff", "team", "someone", "n/a", "na", "-", "—", "?", "unknown"}


def problem(status: int, code: str, message: str, **extra) -> HTTPException:
    return HTTPException(status, detail={"code": code, "message": message, **extra})


def check_named(value: str | None, what: str = "Done by") -> None:
    """Golden rule 2 (SCH-05): one name per item. "Housekeeping" or "TBC" is rejected."""
    if value is None or value.strip().lower() in GENERIC_NAMES:
        shown = value or "empty"
        raise problem(422, "generic_name", f'"{shown}" is not a name. Choose a person, pool or contractor for {what}.')


def next_ref(conn: Connection, property_id: uuid.UUID) -> str:
    """The next free reference at a property, e.g. TV-046. Shared by register items and Actions, as on the Sheet."""
    row = conn.execute(
        update(property_)
        .where(property_.c.id == property_id)
        .values(next_number=property_.c.next_number + 1)
        .returning(property_.c.code, property_.c.next_number)
    ).one()
    return f"{row.code}-{row.next_number - 1:03d}"


def names(conn: Connection, ids: set[uuid.UUID | None]) -> dict[uuid.UUID, str]:
    ids = {i for i in ids if i}
    if not ids:
        return {}
    return {r.id: r.name for r in conn.execute(select(person.c.id, person.c.name).where(person.c.id.in_(ids)))}


def initials(name: str) -> str:
    parts = [p for p in re.split(r"[\s\-]+", name.strip("[] ")) if p and p[0].isalpha()]
    return "".join(p[0] for p in parts[:2]).upper() or "?"


def doer_label(conn: Connection, kind: str | None, person_id, pool_id, contractor_id) -> str | None:
    if kind == "person" and person_id:
        return conn.execute(select(person.c.name).where(person.c.id == person_id)).scalar()
    if kind == "pool" and pool_id:
        return conn.execute(select(pool.c.name).where(pool.c.id == pool_id)).scalar()
    if kind == "contractor" and contractor_id:
        return conn.execute(select(contractor.c.name).where(contractor.c.id == contractor_id)).scalar()
    return None


def fmt_date(d: date | None, with_year: bool | None = None) -> str:
    """en-GB: "26 Oct 2026". The year is dropped for dates in the current year when with_year is None."""
    if d is None:
        return ""
    if with_year is None:
        with_year = d.year != clock.today().year
    return f"{d.day} {d.strftime('%b')}" + (f" {d.year}" if with_year else "")


def fmt_day(d: date) -> str:
    """ "Mon 2 Nov" """
    return f"{d.strftime('%a')} {d.day} {d.strftime('%b')}"


def fmt_time(dt: datetime) -> str:
    return clock.london(dt).strftime("%H:%M")


def relative_days(d: date, today: date | None = None) -> str:
    today = today or clock.today()
    n = (d - today).days
    if n == 0:
        return "today"
    if n == 1:
        return "tomorrow"
    if n == -1:
        return "yesterday"
    if n < 0:
        return f"{-n} days ago"
    return f"in {n} days"


def overdue_label(due: datetime, now: datetime | None = None) -> str:
    """ "3 days overdue", "5h overdue" """
    now = now or clock.now()
    secs = (now - due).total_seconds()
    if secs < 3600 * 24:
        h = max(int(secs // 3600), 1)
        return f"{h}h overdue"
    days = (clock.london(now).date() - clock.london(due).date()).days
    return f"{days} {'day' if days == 1 else 'days'} overdue"


def file_name(what: str, who: str, d: date, ext: str | None = None) -> str:
    """Evidence is named "What - Who - Date" automatically (golden rule 3)."""
    clean = re.sub(r"[\\/:*?\"<>|]+", " ", f"{what} - {who} - {d.isoformat()}").strip()
    return f"{clean}.{ext}" if ext else clean
