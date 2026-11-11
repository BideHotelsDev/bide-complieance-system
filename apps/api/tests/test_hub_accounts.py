"""Accounts managed by Bide Hub: the Hub pushes which staff have access and their staff roles (hub_accounts.py).

The Hub is bide-hub-client's FakeHub, which signs provisioning tokens with the key it serves. The demo database is
shared by the whole run, so every test works on fresh people and leaves the demo's own people alone."""

import json
import uuid

import pytest
from fastapi.testclient import TestClient
from sqlalchemy import select

from bide_comply import hub, hub_accounts
from bide_comply._vendor.bide_hub_client.testing import FakeHub
from bide_comply.config import settings
from bide_comply.db import engine
from bide_comply.schema import person, property_, role_assignment, staff_requirement, staff_requirement_type

BASE = "http://localhost:5180"
PATH = hub_accounts.PATH


@pytest.fixture
def fake(monkeypatch):
    f = FakeHub(issuer="https://hub.test", client_id="comply", client_secret="dev-secret-comply")
    monkeypatch.setattr(settings, "bide_hub_issuer", f.issuer)
    monkeypatch.setattr(settings, "bide_hub_client_id", f.client_id)
    monkeypatch.setattr(settings, "bide_hub_client_secret", f.client_secret)
    monkeypatch.setattr(settings, "bide_hub_manages_accounts", True)
    c = f.client()
    monkeypatch.setattr(hub, "client", lambda: c)
    return f


@pytest.fixture
def api(app):
    return TestClient(app)


def call(api, fake: FakeHub, method: str, path: str, payload: dict | None = None, **token_claims):
    body = b"" if payload is None else json.dumps(payload).encode()
    token = fake.provisioning_token(method, f"{BASE}{PATH}{path}", body, **token_claims)
    headers = {"Authorization": f"Bearer {token}"} | ({"Content-Type": "application/json"} if body else {})
    return api.request(method, f"{PATH}{path}", content=body or None, headers=headers)


def a_property() -> str:
    with engine.connect() as conn:
        return str(conn.execute(select(property_.c.id).order_by(property_.c.code).limit(1)).scalar_one())


def fresh_email() -> str:
    return f"hubacct-{uuid.uuid4().hex[:10]}@demo.invalid"


def account(email: str, roles: list[tuple[str, str | None]], active: bool = True, name: str = "Hub Person") -> dict:
    return {
        "email": email,
        "name": name,
        "active": active,
        "assignments": [{"role": r, "scope": s} for r, s in roles],
    }


def row(email: str) -> dict | None:
    with engine.connect() as conn:
        p = conn.execute(select(person).where(person.c.email == email)).mappings().first()
        if p is None:
            return None
        roles = conn.execute(
            select(role_assignment.c.role, role_assignment.c.property_id).where(role_assignment.c.person_id == p["id"])
        ).all()
        return dict(p) | {"roles": {(r.role, str(r.property_id) if r.property_id else None) for r in roles}}


def make_person(kind: str = "staff", roles: list[tuple[str, str | None]] = ()) -> str:
    email = fresh_email()
    with engine.begin() as conn:
        pid = uuid.uuid4()
        conn.execute(person.insert().values(id=pid, name="Existing", email=email, kind=kind))
        for r, prop in roles:
            conn.execute(role_assignment.insert().values(person_id=pid, role=r, property_id=prop))
    return email


# --- reading ----------------------------------------------------------------------------------------------------------


def test_off_unless_the_operator_turns_it_on(api, fake, monkeypatch):
    monkeypatch.setattr(settings, "bide_hub_manages_accounts", False)
    assert call(api, fake, "GET", "/catalog").status_code == 404


def test_catalog_offers_the_staff_roles(api, fake):
    body = call(api, fake, "GET", "/catalog").json()
    roles = {r["key"]: r["scoped"] for r in body["roles"]}
    assert roles == {
        "super_admin": False,
        "system_owner": False,
        "register_keeper": False,
        "systems": False,
        "site_lead": True,
        "keyholder": True,
        "staff": True,
    }
    assert body["scopes"] and body["features"] == ["check"] and "max_assignments" not in body


def test_the_import_lists_staff_with_their_staff_roles_only(api, fake):
    prop = a_property()
    staff_email = make_person("staff", [("site_lead", prop), ("assessor", prop)])
    outside_email = make_person("external", [("contractor", None)])
    rows = {r["email"]: r for r in call(api, fake, "GET", "/users").json()}
    assert rows[staff_email]["assignments"] == [{"role": "site_lead", "scope": prop}]
    assert outside_email not in rows


def test_a_refusal_carries_detail_for_the_hub_admin(api, fake):
    r = call(api, fake, "PUT", "/users/hub-x", account(fresh_email(), []))
    assert r.status_code == 422 and "at least one role" in r.json()["detail"]


def test_a_token_for_another_address_is_refused(api, fake):
    assert call(api, fake, "GET", "/catalog", htu=f"{BASE}{PATH}/users").status_code == 401


# --- changing ---------------------------------------------------------------------------------------------------------


def test_a_new_person_gets_roles_and_their_training_and_repeating_it_changes_nothing(api, fake):
    prop, email = a_property(), fresh_email()
    for _ in range(2):
        r = call(api, fake, "PUT", "/users/hub-new", account(email, [("staff", prop), ("keyholder", prop)]))
        assert r.status_code == 200, r.text
    p = row(email)
    assert (p["kind"], p["bide_hub_sub"]) == ("staff", "hub-new")
    assert p["roles"] == {("staff", prop), ("keyholder", prop)}
    with engine.connect() as conn:
        needed = set(
            conn.execute(
                select(staff_requirement_type.c.id).where(
                    staff_requirement_type.c.roles.contains(["staff"])
                    | staff_requirement_type.c.roles.contains(["keyholder"])
                )
            ).scalars()
        )
        have = set(
            conn.execute(select(staff_requirement.c.type_id).where(staff_requirement.c.person_id == p["id"])).scalars()
        )
    assert needed <= have, "required training follows the roles given"


def test_roles_the_hub_doesnt_give_are_left_alone(api, fake):
    prop = a_property()
    email = make_person("staff", [("staff", prop), ("assessor", prop)])
    call(api, fake, "PUT", "/users/hub-ex", account(email, [("site_lead", prop)]))
    assert row(email)["roles"] == {("site_lead", prop), ("assessor", prop)}


def test_group_roles_cover_every_property(api, fake):
    email = fresh_email()
    call(api, fake, "PUT", "/users/hub-sys", account(email, [("systems", a_property())]))
    assert row(email)["roles"] == {("systems", None)}


@pytest.mark.parametrize(
    ("roles", "says"),
    [
        ([], "at least one role"),
        ([("contractor", None)], "isn't a staff role"),
        ([("staff", None)], "pick a property"),
        ([("staff", str(uuid.uuid4()))], "isn't in bide Comply"),
    ],
    ids=["none", "not-a-staff-role", "no-property", "unknown-property"],
)
def test_what_comply_cant_apply_is_refused(api, fake, roles, says):
    email = fresh_email()
    r = call(api, fake, "PUT", "/users/hub-bad", account(email, roles))
    assert r.status_code == 422 and says in r.json()["detail"]
    assert row(email) is None


def test_an_outside_person_is_managed_here_not_by_the_hub(api, fake):
    email = make_person("external", [("contractor", None)])
    r = call(api, fake, "PUT", "/users/hub-out", account(email, [("staff", a_property())]))
    assert r.status_code == 409 and "outside person" in r.json()["detail"]
    r = call(api, fake, "PUT", "/users/hub-out", account(email, [], active=False))
    assert r.status_code == 200 and row(email)["employment_status"] == "active", "and never offboarded by it"


def test_switching_off_offboards_and_never_creates(api, fake):
    ghost = fresh_email()
    assert call(api, fake, "PUT", "/users/hub-ghost", account(ghost, [], active=False)).json() == {
        "id": None,
        "active": False,
    }
    assert row(ghost) is None
    email = make_person("staff", [("staff", a_property())])
    r = call(api, fake, "PUT", "/users/hub-leaver", account(email, [], active=False))
    p = row(email)
    assert r.status_code == 200 and p["employment_status"] == "leaver" and p["left_on"] is not None
    # Given access again on the Hub: they're back.
    call(api, fake, "PUT", "/users/hub-leaver", account(email, [("staff", a_property())]))
    assert row(email)["employment_status"] == "active"


def test_there_is_always_a_super_admin(api, fake, monkeypatch):
    """As if this person were the only Super Admin: taking it away is refused when the Hub asks first, applied (with a
    warning) when the Hub delivers a change it already saved, and switching them off is never refused."""
    email = make_person("staff", [("super_admin", None)])
    pid = row(email)["id"]

    def only_this_one(conn):
        q = (
            select(role_assignment.c.id)
            .join(person, person.c.id == role_assignment.c.person_id)
            .where(
                role_assignment.c.person_id == pid,
                role_assignment.c.role == "super_admin",
                person.c.employment_status == "active",
            )
        )
        return 1 if conn.execute(q).first() else 0

    monkeypatch.setattr(hub_accounts, "_super_admins", only_this_one)
    demote = account(email, [("staff", a_property())])
    r = call(api, fake, "POST", "/users/hub-sa/check", demote)
    assert r.status_code == 409 and "at least one Super Admin" in r.json()["detail"]
    assert ("super_admin", None) in row(email)["roles"], "a check changes nothing"
    r = call(api, fake, "POST", "/users/hub-sa/check", account(email, [], active=False))
    assert r.status_code == 200 and "last active Super Admin" in r.json()["warnings"][0]
    assert call(api, fake, "PUT", "/users/hub-sa", demote).status_code == 200
    assert ("super_admin", None) not in row(email)["roles"]


# --- Settings › People while the Hub manages staff --------------------------------------------------------------------


def test_people_settings_keep_outside_people_and_other_roles(app, fake, login):
    david = login("David Liddell")  # the demo's Super Admin
    assert TestClient(app).get("/api/auth/bide").json()["accounts_managed"] is True
    prop = a_property()
    staff_email = make_person("staff", [("staff", prop)])
    outside_email = make_person("external", [])
    staff_id, outside_id = row(staff_email)["id"], row(outside_email)["id"]

    r = david.post(
        "/api/people",
        json={
            "name": "S",
            "email": f"hubacct-{uuid.uuid4().hex[:8]}@bidehotels.com",
            "kind": "staff",
            "role": "staff",
            "property_id": prop,
        },
    )
    assert r.status_code == 409 and r.json()["code"] == "managed_by_hub"
    r = david.post(f"/api/people/{staff_id}/roles", json={"role": "keyholder", "property_id": prop})
    assert r.status_code == 409 and r.json()["code"] == "managed_by_hub"
    assert david.post(f"/api/people/{staff_id}/offboard").status_code == 409

    assert (
        david.post(f"/api/people/{staff_id}/roles", json={"role": "assessor", "property_id": prop}).status_code == 200
    )
    assert (
        david.post(f"/api/people/{outside_id}/roles", json={"role": "contractor", "property_id": None}).status_code
        == 200
    )
