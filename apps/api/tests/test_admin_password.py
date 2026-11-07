"""Break-glass admin sign-in with a password (ADMIN_LOGIN_*): off by default, then the authenticator app."""

import pyotp
import pytest
from fastapi.testclient import TestClient
from sqlalchemy import delete, select

from bide_comply import passwords, ratelimit
from bide_comply.config import settings
from bide_comply.db import engine
from bide_comply.schema import audit_event, person, totp_secret

PASSWORD = "Abcdef-ghijkm-nopqrs-tuvwxy"  # noqa: S105 - test value


@pytest.fixture
def admin_login(monkeypatch):
    with engine.connect() as conn:
        email = conn.execute(select(person.c.email).where(person.c.email == "david@demo.invalid")).scalar_one()
    monkeypatch.setattr(settings, "admin_login_username", "bidesuperadmin")
    monkeypatch.setattr(settings, "admin_login_email", email)
    monkeypatch.setattr(settings, "admin_login_password_hash", passwords.hash_password(PASSWORD))
    ratelimit._local.clear()
    yield email
    ratelimit._local.clear()


def client(app) -> TestClient:
    c = TestClient(app)
    c.headers.update({"X-Requested-With": "bide-comply"})
    return c


def test_hash_round_trip():
    h = passwords.hash_password("one")
    assert h.startswith("scrypt$") and passwords.verify("one", h)
    assert not passwords.verify("two", h)
    assert not passwords.verify("one", "not-a-hash")
    assert len(passwords.generate()) == 27


def test_off_unless_configured(app):
    c = client(app)
    assert c.get("/api/auth/admin-password").json() == {"enabled": False}
    r = c.post("/api/auth/admin-password", json={"username": "bidesuperadmin", "password": PASSWORD})
    assert r.status_code == 404


def test_wrong_password_is_refused_and_audited(app, admin_login):
    c = client(app)
    assert c.get("/api/auth/admin-password").json() == {"enabled": True}
    r = c.post("/api/auth/admin-password", json={"username": "bidesuperadmin", "password": "wrong"})
    assert r.status_code == 400
    r = c.post("/api/auth/admin-password", json={"username": "someone", "password": PASSWORD})
    assert r.status_code == 400
    assert c.get("/api/me").status_code == 401
    with engine.connect() as conn:
        n = conn.execute(select(audit_event.c.id).where(audit_event.c.action == "admin_password_failed")).all()
    assert len(n) >= 2


def test_right_password_then_the_authenticator_app(app, admin_login):
    with engine.begin() as conn:
        pid = conn.execute(select(person.c.id).where(person.c.email == admin_login)).scalar_one()
        conn.execute(delete(totp_secret).where(totp_secret.c.person_id == pid))
    c = client(app)
    r = c.post("/api/auth/admin-password", json={"username": " BideSuperAdmin ", "password": PASSWORD})
    assert r.status_code == 200, r.text
    # No email to send a device code to: straight to the authenticator app, and no session before it.
    assert r.json()["next"] == "/signin/totp-setup"
    assert c.get("/api/me").status_code == 401
    secret = c.post("/api/auth/totp/setup").json()["secret"]
    r = c.post("/api/auth/totp", json={"code": pyotp.TOTP(secret).now()})
    assert r.status_code == 200, r.text
    assert c.get("/api/me").status_code == 200


def test_too_many_wrong_tries_pause_it_for_everyone(app, admin_login):
    limit, window = 10, 3600
    for _ in range(limit):
        ratelimit._hit("admin-password-failures", limit, window)
    r = client(app).post("/api/auth/admin-password", json={"username": "bidesuperadmin", "password": PASSWORD})
    assert r.status_code == 429
