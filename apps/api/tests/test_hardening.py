"""Client IP behind the proxy, authenticator-app brute force and reuse, SVG logos and download file names."""

import time
import uuid

import pyotp
import pytest
from fastapi.testclient import TestClient
from sqlalchemy import select
from starlette.requests import Request

from bide_comply import passwords, ratelimit
from bide_comply.config import settings
from bide_comply.db import engine
from bide_comply.schema import audit_event, evidence, person, property_, role_assignment
from bide_comply.storage import content_disposition, storage

DAVID = "David Liddell"  # Super Admin: may publish a theme
PAMELA = "Pamela Mathers"  # staff


@pytest.fixture(autouse=True)
def _clear_limits():
    # Every test client shares one address.
    ratelimit._local.clear()
    yield
    ratelimit._local.clear()


# --- client IP -------------------------------------------------------------------------------------------------------


def _request(xff: list[str], client: str = "10.0.0.7") -> Request:
    headers = [(b"x-forwarded-for", v.encode()) for v in xff]
    return Request({"type": "http", "method": "GET", "path": "/", "headers": headers, "client": (client, 1234)})


def test_client_ip_is_the_entry_the_edge_appended():
    assert ratelimit.client_ip(_request(["203.0.113.9"])) == "203.0.113.9"
    # Whatever the client puts on the left (one header or several) doesn't change the answer.
    assert ratelimit.client_ip(_request(["1.2.3.4, 203.0.113.9"])) == "203.0.113.9"
    assert ratelimit.client_ip(_request(["6.6.6.6, 7.7.7.7", "203.0.113.9"])) == "203.0.113.9"
    assert ratelimit.client_ip(_request([])) == "10.0.0.7"


def test_client_ip_with_no_trusted_proxy_is_the_socket(monkeypatch):
    monkeypatch.setattr(settings, "trusted_proxy_hops", 0)
    assert ratelimit.client_ip(_request(["1.2.3.4, 203.0.113.9"])) == "10.0.0.7"


def test_spoofed_forwarded_for_does_not_dodge_the_rate_limit(app):
    c = TestClient(app)
    codes = []
    for _ in range(6):
        spoof = f"198.51.100.{uuid.uuid4().int % 250}, 203.0.113.9"
        r = c.post("/api/auth/magic", json={"email": "nobody@demo.invalid"}, headers={"X-Forwarded-For": spoof})
        codes.append(r.status_code)
    assert codes == [200] * 5 + [429]
    # Another real client (another right-most entry) has its own allowance.
    r = c.post("/api/auth/magic", json={"email": "x@demo.invalid"}, headers={"X-Forwarded-For": "203.0.113.10"})
    assert r.status_code == 200


def test_uvicorn_does_not_trust_forwarded_headers():
    from pathlib import Path

    start = (Path(__file__).parents[1] / "start.sh").read_text()
    assert "--no-proxy-headers" in start and "forwarded-allow-ips" not in start


def test_audit_ip_ignores_a_spoofed_forwarded_for(app, admin):
    c = TestClient(app)
    r = c.post(
        "/api/auth/admin-password",
        json={"username": "totpadmin", "password": "wrong"},
        headers={"X-Forwarded-For": "6.6.6.6, 203.0.113.77"},
    )
    assert r.status_code == 400
    with engine.connect() as conn:
        ip = conn.execute(
            select(audit_event.c.ip)
            .where(audit_event.c.action == "admin_password_failed")
            .order_by(audit_event.c.seq.desc())
            .limit(1)
        ).scalar()
    assert ip == "203.0.113.77"


# --- authenticator app -----------------------------------------------------------------------------------------------


@pytest.fixture
def admin(monkeypatch):
    """A fresh Super Admin who signs in with the break-glass password, which goes straight to the authenticator app."""
    pid = uuid.uuid4()
    email = f"totp-{pid.hex[:10]}@demo.invalid"
    with engine.begin() as conn:
        conn.execute(person.insert().values(id=pid, name="TOTP Test", email=email, kind="staff"))
        conn.execute(role_assignment.insert().values(person_id=pid, role="super_admin", property_id=None))
    monkeypatch.setattr(settings, "admin_login_username", "totpadmin")
    monkeypatch.setattr(settings, "admin_login_email", email)
    monkeypatch.setattr(settings, "admin_login_password_hash", passwords.hash_password("Pw-for-the-test-only-123"))
    return pid


def _pending(app) -> TestClient:
    c = TestClient(app)
    c.headers.update({"X-Requested-With": "bide-comply"})
    r = c.post("/api/auth/admin-password", json={"username": "totpadmin", "password": "Pw-for-the-test-only-123"})
    assert r.status_code == 200, r.text
    ratelimit._local.clear()
    return c


def _wrong(code: str) -> str:
    return f"{(int(code) + 1) % 1_000_000:06d}"


def test_five_wrong_codes_end_the_sign_in(app, admin):
    c = _pending(app)
    totp = pyotp.TOTP(c.post("/api/auth/totp/setup").json()["secret"])
    for left in (4, 3, 2, 1):
        r = c.post("/api/auth/totp", json={"code": _wrong(totp.now())})
        assert r.status_code == 400 and f"{left} tries left" in r.json()["message"]
    r = c.post("/api/auth/totp", json={"code": _wrong(totp.now())})
    assert r.status_code == 429 and r.json()["code"] == "locked"
    # The step is spent: even the right code now means starting again.
    r = c.post("/api/auth/totp", json={"code": totp.now()})
    assert r.status_code == 401 and r.json()["code"] == "no_pending"
    assert c.get("/api/me").status_code == 401
    # A fresh sign-in gets a fresh five.
    c = _pending(app)
    assert c.post("/api/auth/totp", json={"code": totp.now()}).status_code == 200
    assert c.get("/api/me").status_code == 200


def test_no_new_email_code_from_the_authenticator_step(app, admin):
    c = _pending(app)
    assert c.get("/api/auth/pending").json()["stage"] == "totp_setup"
    assert c.post("/api/auth/code/resend").status_code == 400


def test_a_code_works_once(app, admin):
    c = _pending(app)
    totp = pyotp.TOTP(c.post("/api/auth/totp/setup").json()["secret"])
    code = totp.now()
    assert c.post("/api/auth/totp", json={"code": code}).status_code == 200
    again = _pending(app)
    r = again.post("/api/auth/totp", json={"code": code})
    assert r.status_code == 400 and r.json()["code"] == "wrong"
    assert again.get("/api/me").status_code == 401
    # The next code (accepted one step early for clock drift) works.
    assert again.post("/api/auth/totp", json={"code": totp.at(time.time() + 30)}).status_code == 200


def test_old_pending_cookie_without_a_step_is_refused(app, admin):
    from bide_comply import auth

    c = TestClient(app)
    c.headers.update({"X-Requested-With": "bide-comply"})
    tok = auth._serializer("pending").dumps(
        {"p": str(admin), "d": str(uuid.uuid4()), "c": None, "a": "web", "n": "/", "s": "totp", "h": None}
    )
    c.cookies.set(auth.PENDING_COOKIE, tok)
    r = c.post("/api/auth/totp", json={"code": "123456"})
    assert r.status_code == 401 and r.json()["code"] == "no_pending"


# --- SVG logos -------------------------------------------------------------------------------------------------------

BAD_SVG = (
    b'<svg xmlns="http://www.w3.org/2000/svg" onload="alert(1)"><script>alert(2)</script>'
    b'<a href="javascript:alert(3)"><rect width="10" height="10" onclick=alert(4) /></a>'
    b"<foreignObject><iframe src='https://evil.test'></iframe></foreignObject></svg>"
)


def _upload(client, data: bytes, content_type: str, purpose: str = "evidence", file_name: str | None = None):
    r = client.post(
        "/api/uploads",
        json={"content_type": content_type, "size": len(data), "purpose": purpose, "file_name": file_name},
    )
    if r.status_code != 200:
        return r
    slot = r.json()
    put = client.put(slot["upload"]["url"], content=data, headers={"Content-Type": content_type})
    assert put.status_code == 200, put.text
    return client.post(f"/api/uploads/{slot['evidence_id']}/complete", json={})


def test_svg_logo_is_sanitised_before_it_is_kept(login):
    r = _upload(login(DAVID), BAD_SVG, "image/svg+xml", purpose="logo")
    assert r.status_code == 200, r.text
    with engine.connect() as conn:
        ev = conn.execute(select(evidence).where(evidence.c.id == uuid.UUID(r.json()["id"]))).mappings().one()
    kept = storage.get(ev["storage_key"])
    assert kept.startswith(b"<svg") and b"<rect" in kept
    for bad in (b"<script", b"onload", b"onclick", b"javascript:", b"foreignObject", b"evil.test"):
        assert bad not in kept, bad
    import hashlib

    assert ev["sha256"] == hashlib.sha256(kept).hexdigest()


def test_logo_uploads_need_theme_publish(login):
    png = b"\x89PNG\r\n\x1a\n" + b"0" * 32
    r = login(PAMELA).post("/api/uploads", json={"content_type": "image/png", "size": len(png), "purpose": "logo"})
    assert r.status_code == 403
    r = login(PAMELA).post("/api/uploads", json={"content_type": "image/svg+xml", "size": 100})
    assert r.status_code == 415  # SVG is for logos only
    r = login(PAMELA).post("/api/uploads", json={"content_type": "image/png", "size": 10, "purpose": "other"})
    assert r.status_code == 422


# --- download file names ---------------------------------------------------------------------------------------------

PDF = b"%PDF-1.4\n1 0 obj<<>>endobj\ntrailer<<>>\n%%EOF\n"


def test_download_with_a_non_latin1_file_name(login):
    name = "Fire – risk “final” 🔥.pdf"
    c = login(DAVID)
    with engine.connect() as conn:
        prop = str(conn.execute(select(property_.c.id).limit(1)).scalar_one())
    slot = c.post(
        "/api/uploads",
        json={"content_type": "application/pdf", "size": len(PDF), "file_name": name, "property_id": prop},
    ).json()
    assert c.put(slot["upload"]["url"], content=PDF, headers={"Content-Type": "application/pdf"}).status_code == 200
    assert c.post(f"/api/uploads/{slot['evidence_id']}/complete", json={}).status_code == 200
    view = c.get(f"/api/evidence/{slot['evidence_id']}").json()
    for url, disp in ((view["url"], "inline"), (view["original_url"], "attachment")):
        r = c.get(url)
        assert r.status_code == 200 and r.content == PDF
        assert r.headers["content-disposition"] == (
            f'{disp}; filename="Fire _ risk _final_ _.pdf"; '
            "filename*=UTF-8''Fire%20%E2%80%93%20risk%20%E2%80%9Cfinal%E2%80%9D%20%F0%9F%94%A5.pdf"
        )


def test_quotes_and_backslashes_cannot_break_the_header():
    h = content_disposition('a"b\\c\r\nd.pdf', inline=False)
    ascii_part = h.split("; filename*=")[0]
    assert ascii_part == 'attachment; filename="abc__d.pdf"'
    assert "\r" not in h and "\n" not in h and h.endswith("a%22b%5Cc%0D%0Ad.pdf")
    assert content_disposition("Café.pdf") == "inline; filename=\"Cafe.pdf\"; filename*=UTF-8''Caf%C3%A9.pdf"
