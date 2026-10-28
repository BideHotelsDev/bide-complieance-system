"""Editable wording (CMS-17): the published text from Settings › Messages and wording, with its details filled in.

Notifications, the digest and the on-screen messages read their words from here, so a change published in the CMS is
what people see next, without a redeploy. Drafts are never used until they are published.
"""

import re

from sqlalchemy import Connection, select

from bide_comply.schema import content_message

PLACEHOLDER = re.compile(r"\{([a-z_]+)\}")


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
    return fill(row.body, v), fill(row.short_body, v) if row.short_body else None


def text(conn: Connection, key: str, default: str, values: dict | None = None) -> str:
    m = message(conn, key, values)
    return m[0] if m and m[0] else default


def screen_texts(conn: Connection) -> dict[str, str]:
    """On-screen wording (privacy notice, tour, empty states, the failed-check result), published versions only."""
    return {
        r.key: r.body
        for r in conn.execute(
            select(content_message.c.key, content_message.c.body).where(content_message.c.group == "screen")
        )
    }
