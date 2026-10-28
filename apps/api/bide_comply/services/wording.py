"""Editable wording (CMS-17): the published text from Settings › Messages and wording, with its details filled in.

Notifications, the digest and the on-screen messages read their words from here, so a change published in the CMS is
what people see next, without a redeploy. Drafts are never used until they are published.
"""

import re

from sqlalchemy import Connection, select

from bide_comply.schema import content_message, theme_version

PLACEHOLDER = re.compile(r"\{([a-z_]+)\}")

TONES = ("plain", "warm", "brief")
# Tone of messages (Settings › Appearance) styles reminders, alerts and empty states. The privacy notice and the
# tour are left exactly as written.
TONED = {"check_due_soon", "check_overdue", "class_a_failure", "certificate_expiring", "monday_digest", "empty_overdue"}
SENTENCE = re.compile(r"(?<=[.?])\s+(?=[A-Z{])")


def tone(conn: Connection) -> str:
    t = conn.execute(
        select(theme_version.c.tokens)
        .where(theme_version.c.status == "live")
        .order_by(theme_version.c.version.desc())
        .limit(1)
    ).scalar()
    v = (t or {}).get("tone", "plain")
    return v if v in TONES else "plain"


def styled(key: str, body: str, short: str | None, tone_: str, values: dict) -> str:
    """The message in the chosen tone. Plain is the text as written; brief keeps the first sentence (or the short
    version, which is written to stand alone); warm greets the person by first name and thanks them."""
    if key not in TONED or tone_ == "plain":
        return body
    if tone_ == "brief":
        if short:
            return short
        first = SENTENCE.split(body, maxsplit=1)[0]
        return first if first.endswith((".", "?")) else first + "."
    person = values.get("person")
    first_name = str(person).split()[0] if person else None
    if key == "empty_overdue":
        return f"{body} Well done."
    if key == "monday_digest":
        return f"{body} Thank you for keeping on top of it."
    greeting = f"Hi {first_name}. " if first_name else ""
    return f"{greeting}{body} Thank you."


def fill(text: str, values: dict) -> str:
    """Put the details into the text. A detail with no value is left out, and the spacing tidied after it."""

    def one(m: re.Match) -> str:
        v = values.get(m.group(1))
        return "" if v is None else str(v)

    out = PLACEHOLDER.sub(one, text)
    out = re.sub(r"\s+([.,;:])", r"\1", out)
    out = re.sub(r"\(\s*\)", "", out)
    return re.sub(r"[ \t]{2,}", " ", out).strip()


def message(conn: Connection, key: str, values: dict | None = None) -> tuple[str, str | None] | None:
    """The published message and its short (push) version, filled in. None if the key doesn't exist."""
    row = conn.execute(
        select(content_message.c.body, content_message.c.short_body).where(content_message.c.key == key)
    ).first()
    if not row:
        return None
    v = values or {}
    body = fill(row.body, v)
    short = fill(row.short_body, v) if row.short_body else None
    return styled(key, body, short, tone(conn), v), short


def text(conn: Connection, key: str, default: str, values: dict | None = None) -> str:
    m = message(conn, key, values)
    return m[0] if m and m[0] else default


def screen_texts(conn: Connection) -> dict[str, str]:
    """On-screen wording (privacy notice, tour, empty states, the failed-check result), published versions only.
    Texts with details in them ({property}...) are filled in where they're used; see empty_overdue()."""
    return {
        r.key: r.body
        for r in conn.execute(
            select(content_message.c.key, content_message.c.body).where(content_message.c.group == "screen")
        )
    }


def empty_overdue(conn: Connection, property_name: str, next_check: str | None, next_date: str | None) -> str:
    """The empty state when nothing is overdue at a property (Settings › Messages and wording › Empty states)."""
    default = "Nothing is overdue at {property}. Next check: {next_check}, {next_date}."
    values = {"property": property_name, "next_check": next_check, "next_date": next_date}
    m = message(conn, "empty_overdue", values)
    out = m[0] if m and m[0] else fill(default, values)
    if not next_check:
        # No upcoming check to name: keep just the first sentence rather than "Next check: ,".
        out = SENTENCE.split(out, maxsplit=1)[0]
    return out
