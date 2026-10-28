"""First-admin setup (BOOTSTRAP_ADMINS) and the "who to ask" contact that the wording names."""

import pytest
from sqlalchemy import delete, select

from bide_comply.db import engine
from bide_comply.schema import person, role_assignment
from bide_comply.seed import admins
from bide_comply.services import contact, wording


def test_parse_takes_names_or_bare_addresses():
    assert admins.parse(" Kyle Mendoza <Kyle@BideHotels.com>, sam.kirk-land@bidehotels.com ,") == [
        ("Kyle Mendoza", "kyle@bidehotels.com"),
        ("Sam Kirk Land", "sam.kirk-land@bidehotels.com"),
    ]
    assert admins.parse("") == []
    with pytest.raises(ValueError):
        admins.parse("Kyle Mendoza")


def test_skipped_while_a_super_admin_exists(capsys):
    with engine.connect() as conn, conn.begin() as tx:
        admins.run(conn, "new.admin@bidehotels.com")
        assert conn.execute(select(person.c.id).where(person.c.email == "new.admin@bidehotels.com")).first() is None
        tx.rollback()
    assert "already exists" in capsys.readouterr().out


def test_an_install_with_no_super_admin_gets_the_listed_ones():
    with engine.connect() as conn, conn.begin() as tx:
        conn.execute(delete(role_assignment).where(role_assignment.c.role == "super_admin"))
        assert not admins.has_super_admin(conn)
        admins.run(conn, "First Admin <first.admin@bidehotels.com>, david@demo.invalid")
        p = conn.execute(select(person).where(person.c.email == "first.admin@bidehotels.com")).mappings().one()
        assert (p["name"], p["kind"], p["employment_status"]) == ("First Admin", "staff", "active")
        holders = set(
            conn.execute(select(role_assignment.c.person_id).where(role_assignment.c.role == "super_admin")).scalars()
        )
        david = conn.execute(select(person.c.id).where(person.c.email == "david@demo.invalid")).scalar()
        # An existing person is given the role rather than added twice.
        assert holders == {p["id"], david}
        # Running again changes nothing.
        admins.run(conn, "First Admin <first.admin@bidehotels.com>")
        assert conn.execute(select(person.c.id).where(person.c.email == "first.admin@bidehotels.com")).all() == [
            (p["id"],)
        ]
        tx.rollback()


def test_contact_is_the_system_owner_then_a_super_admin():
    with engine.connect() as conn, conn.begin() as tx:
        assert contact.contact(conn) == {"name": "Samantha", "role": "system owner"}
        assert contact.phrase(conn) == "Samantha (system owner)"
        conn.execute(delete(role_assignment).where(role_assignment.c.role == "system_owner"))
        assert contact.contact(conn)["role"] == "Super Admin"
        conn.execute(delete(role_assignment).where(role_assignment.c.role == "super_admin"))
        assert contact.phrase(conn) == "the system owner"
        tx.rollback()


def test_privacy_notice_names_the_contact():
    with engine.connect() as conn:
        notice = wording.screen_texts(conn)["privacy_notice"]
    assert "Ask Samantha for a copy" in notice and "{contact}" not in notice


def test_me_carries_the_contact(login):
    assert login("Pamela Mathers", "field").get("/api/me").json()["contact"] == {
        "name": "Samantha",
        "role": "system owner",
    }
