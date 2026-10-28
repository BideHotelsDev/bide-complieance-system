"""Who people are told to ask: the system owner, or a Super Admin while there is no system owner. Read from the
roles in the database, so the wording follows whoever holds the role."""

from sqlalchemy import Connection, select

from bide_comply.schema import person, role_assignment

# How the role reads inside a sentence: "Ask Samantha (system owner)".
ROLE_WORDS = {"system_owner": "system owner", "super_admin": "Super Admin"}


def contact(conn: Connection) -> dict | None:
    """{"name": first name, "role": role words} of the person to ask, or None if nobody holds either role."""
    for role in ROLE_WORDS:
        name = conn.execute(
            select(person.c.name)
            .join(role_assignment, role_assignment.c.person_id == person.c.id)
            .where(role_assignment.c.role == role, person.c.employment_status == "active")
            .order_by(person.c.created_at)
            .limit(1)
        ).scalar()
        if name:
            first = name if name.startswith("[") else name.split()[0]
            return {"name": first, "role": ROLE_WORDS[role]}
    return None


def phrase(conn: Connection, with_role: bool = True) -> str:
    """ "Samantha (system owner)", "Samantha", or "the system owner" when nobody holds the role yet."""
    c = contact(conn)
    if not c:
        return "the system owner"
    return f"{c['name']} ({c['role']})" if with_role else c["name"]
