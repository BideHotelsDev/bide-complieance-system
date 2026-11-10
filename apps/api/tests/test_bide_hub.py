"""Sign in with Bide (Bide Hub OIDC) against a mocked Hub: an RSA key made here, its JWKS served from a patched
fetch, ID and logout tokens signed with it, and the token endpoint patched. The device code, the authenticator app
and the outsiders' magic link must work exactly as they do after Google."""

import base64
import hashlib
import re
import time
import uuid
from urllib.parse import parse_qs, urlsplit

import pyotp
import pytest
from authlib.jose import JsonWebKey, jwt
from fastapi.testclient import TestClient
from sqlalchemy import select, update

from bide_comply import auth, emailer, hub, ratelimit
from bide_comply.config import settings
from bide_comply.db import engine
from bide_comply.schema import audit_event, auth_session, person, property_, role_assignment, totp_secret

ISSUER = "https://hub.test"
CLIENT_ID = "comply"
WEB = "http://localhost:5180"
FIELD = "http://localhost:5181"


class FakeHub:
    """The parts of Bide Hub the app talks to: discovery, JWKS and the token endpoint."""

    def __init__(self):
        self.key = JsonWebKey.generate_key("RSA", 2048, is_private=True, options={"kid": "test-1"})
        self.claims: dict = {}  # what the next ID token says, over the defaults
        self.nonce = ""
        self.challenge = ""
        self.token_calls: list[dict] = []

    @property
    def jwks(self) -> dict:
        return {"keys": [self.key.as_dict(is_private=False)]}

    def sign(self, claims: dict, key=None) -> str:
        return jwt.encode({"alg": "RS256", "kid": "test-1"}, claims, key or self.key).decode()

    def id_token(self) -> str:
        now = int(time.time())
        claims = {
            "iss": ISSUER,
            "aud": CLIENT_ID,
            "azp": CLIENT_ID,
            "iat": now,
            "exp": now + 300,
            "auth_time": now,
            "amr": ["google"],
            "nonce": self.nonce,
            "email_verified": True,
        } | self.claims
        return self.sign({k: v for k, v in claims.items() if v is not None})

    def logout_token(self, **claims) -> str:
        now = int(time.time())
        body = {
            "iss": ISSUER,
            "aud": CLIENT_ID,
            "iat": now,
            "exp": now + 120,
            "jti": uuid.uuid4().hex,
            "events": {hub.BACKCHANNEL_EVENT: {}},
        } | claims
        return self.sign({k: v for k, v in body.items() if v is not None})

    def post(self, url, auth=None, data=None, timeout=None):
        self.token_calls.append({"url": url, "auth": auth, "data": data})
        hub_ok = auth == (CLIENT_ID, "dev-secret-comply") and data["grant_type"] == "authorization_code"
        pkce = base64.urlsafe_b64encode(hashlib.sha256(data["code_verifier"].encode()).digest()).rstrip(b"=")
        if not hub_ok or pkce.decode() != self.challenge:
            return _Resp(400, {"error": "invalid_grant"})
        return _Resp(200, {"access_token": "x", "token_type": "Bearer", "id_token": self.id_token()})


class _Resp:
    def __init__(self, status_code: int, body: dict):
        self.status_code = status_code
        self._body = body

    def json(self) -> dict:
        return self._body


@pytest.fixture
def fake(monkeypatch):
    f = FakeHub()
    monkeypatch.setattr(settings, "bide_hub_issuer", ISSUER + "/")
    monkeypatch.setattr(settings, "bide_hub_client_id", CLIENT_ID)
    monkeypatch.setattr(settings, "bide_hub_client_secret", "dev-secret-comply")
    monkeypatch.setattr(
        hub,
        "discovery",
        lambda: {
            "issuer": ISSUER,
            "authorization_endpoint": f"{ISSUER}/oauth/authorize",
            "token_endpoint": f"{ISSUER}/oauth/token",
            "jwks_uri": f"{ISSUER}/oauth/jwks",
        },
    )
    monkeypatch.setattr(hub, "jwks", lambda fresh=False: f.jwks)
    monkeypatch.setattr(hub.httpx, "post", f.post)
    # Every test client shares one IP, and these tests enter many device codes.
    ratelimit._local.clear()
    yield f
    ratelimit._local.clear()


def _person(roles: tuple[str, ...] = ("staff",), kind: str = "staff") -> dict:
    """A fresh person, so revoking their sessions can't touch the shared test logins."""
    pid = uuid.uuid4()
    email = f"hub-{pid.hex[:10]}@demo.invalid"
    with engine.begin() as conn:
        prop = conn.execute(select(property_.c.id).limit(1)).scalar_one()
        conn.execute(person.insert().values(id=pid, name=f"Hub Test {pid.hex[:4]}", email=email, kind=kind))
        for r in roles:
            conn.execute(role_assignment.insert().values(person_id=pid, role=r, property_id=prop))
    return {"id": pid, "email": email, "sub": str(uuid.uuid4())}


def _start(c: TestClient, fake: FakeHub, app: str = "web", next_: str = "/actions") -> dict:
    r = c.get("/api/auth/bide/login", params={"app": app, "next": next_}, follow_redirects=False)
    assert r.status_code == 302, r.text
    url = urlsplit(r.headers["location"])
    assert f"{url.scheme}://{url.netloc}{url.path}" == f"{ISSUER}/oauth/authorize"
    q = {k: v[0] for k, v in parse_qs(url.query).items()}
    fake.nonce, fake.challenge = q["nonce"], q["code_challenge"]
    return q


def _sign_in(c: TestClient, fake: FakeHub, p: dict, app: str = "web", next_: str = "/actions", **claims) -> str:
    """Hub round trip; returns where the callback sent the browser."""
    q = _start(c, fake, app, next_)
    fake.claims = {"sub": p["sub"], "email": p["email"], "name": "Hub Test", "sid": str(uuid.uuid4())} | claims
    r = c.get("/api/auth/bide/callback", params={"code": "abc", "state": q["state"]}, follow_redirects=False)
    assert r.status_code == 302, r.text
    return r.headers["location"]


def _emailed_code(email: str) -> str:
    sent = [m for m in emailer.outbox if m["to"] == email]
    return re.search(r"(\d{6})", sent[-1]["subject"]).group(1)


def _sessions(pid) -> list[dict]:
    with engine.connect() as conn:
        rows = conn.execute(select(auth_session).where(auth_session.c.person_id == pid)).mappings().all()
    return [dict(r) for r in rows]


# --- flag off --------------------------------------------------------------------------------------------------------


def test_off_unless_all_three_are_set(app, monkeypatch):
    monkeypatch.setattr(settings, "bide_hub_issuer", ISSUER)
    monkeypatch.setattr(settings, "bide_hub_client_id", CLIENT_ID)  # no secret
    c = TestClient(app)
    assert c.get("/api/auth/bide").json() == {"enabled": False, "issuer": None}
    assert c.get("/api/auth/bide/login", follow_redirects=False).status_code == 404
    assert c.get("/api/auth/bide/callback", params={"code": "a", "state": "b"}).status_code == 404
    assert c.post("/api/auth/bide/backchannel-logout", data={"logout_token": "x"}).status_code == 404
    # Google sign-in is what it was (not configured in tests), not a hand-over to the Hub.
    assert c.get("/api/auth/google/start", follow_redirects=False).status_code == 503
    assert "hub.test" not in c.get("/api/health").headers["content-security-policy"]


def test_off_staff_keep_the_magic_link(app):
    ratelimit._local.clear()
    p = _person(("site_lead",))
    c = TestClient(app)
    assert c.post("/api/auth/magic", json={"email": p["email"], "app": "web"}).status_code == 200
    (link,) = _magic_links(p["email"])
    assert c.get(link, follow_redirects=False).headers["location"] == f"{WEB}/signin/code"
    ratelimit._local.clear()


def test_off_sign_out_stays_local(app, login):
    c = TestClient(app)
    c.headers.update({"X-Requested-With": "bide-comply"})
    assert c.post("/api/auth/dev", json={"person_id": str(_person()["id"])}).status_code == 200
    assert c.post("/api/auth/logout").json() == {"ok": True}


# --- sign-in ---------------------------------------------------------------------------------------------------------


def test_happy_path_device_code_then_session_with_hub_sid(app, fake):
    p = _person()
    c = TestClient(app)
    c.headers.update({"X-Requested-With": "bide-comply"})
    assert c.get("/api/auth/bide").json() == {"enabled": True, "issuer": ISSUER}
    q = _start(c, fake, "web", "/actions")
    assert q["client_id"] == CLIENT_ID
    assert q["redirect_uri"] == f"{WEB}/api/auth/bide/callback"
    assert q["scope"] == "openid email profile"
    assert q["code_challenge_method"] == "S256" and q["response_type"] == "code"
    sid = str(uuid.uuid4())
    fake.claims = {"sub": p["sub"], "email": p["email"].upper(), "name": "Hub Test", "sid": sid}
    r = c.get("/api/auth/bide/callback", params={"code": "abc", "state": q["state"]}, follow_redirects=False)
    # The token request used client_secret_basic, the same redirect_uri and the PKCE verifier (checked by FakeHub).
    assert fake.token_calls[-1]["data"]["redirect_uri"] == f"{WEB}/api/auth/bide/callback"
    # First sign-in on this device: the emailed code still comes first, and there's no session yet.
    assert r.headers["location"] == f"{WEB}/signin/code"
    assert c.get("/api/me").status_code == 401
    assert c.get("/api/auth/pending").json()["via"] == "bide"
    r = c.post("/api/auth/code", json={"code": _emailed_code(p["email"]), "trust": True})
    assert r.json() == {"next": "/actions"}
    assert c.get("/api/me").status_code == 200
    (s,) = _sessions(p["id"])
    assert s["hub_sid"] == sid
    with engine.connect() as conn:
        assert conn.execute(select(person.c.bide_hub_sub).where(person.c.id == p["id"])).scalar() == p["sub"]
    # The same device, now trusted: straight in.
    assert _sign_in(c, fake, p, next_="/reviews") == f"{WEB}/reviews"


def test_field_app_uses_its_own_origin(app, fake):
    p = _person()
    c = TestClient(app)
    q = _start(c, fake, "field", "/")
    assert q["redirect_uri"] == f"{FIELD}/api/auth/bide/callback"
    fake.claims = {"sub": p["sub"], "email": p["email"], "sid": str(uuid.uuid4())}
    r = c.get("/api/auth/bide/callback", params={"code": "abc", "state": q["state"]}, follow_redirects=False)
    assert r.headers["location"] == f"{FIELD}/signin/code"
    assert fake.token_calls[-1]["data"]["redirect_uri"] == f"{FIELD}/api/auth/bide/callback"


def test_admin_roles_still_need_device_code_and_authenticator(app, fake):
    p = _person(("system_owner",))
    c = TestClient(app)
    c.headers.update({"X-Requested-With": "bide-comply"})
    sid = str(uuid.uuid4())
    assert _sign_in(c, fake, p, sid=sid) == f"{WEB}/signin/code"
    r = c.post("/api/auth/code", json={"code": _emailed_code(p["email"]), "trust": True})
    assert r.json() == {"next": "/signin/totp-setup"}
    assert c.get("/api/me").status_code == 401
    secret = c.post("/api/auth/totp/setup").json()["secret"]
    r = c.post("/api/auth/totp", json={"code": pyotp.TOTP(secret).now()})
    assert r.json() == {"next": "/actions"}
    assert c.get("/api/me").status_code == 200
    (s,) = _sessions(p["id"])
    assert s["hub_sid"] == sid and s["totp_ok"] and s["idle_expires_at"] is not None
    # Next time on the trusted device: no code, but the authenticator app again.
    assert _sign_in(c, fake, p) == f"{WEB}/signin/totp"
    with engine.connect() as conn:
        assert conn.execute(select(totp_secret.c.confirmed_at).where(totp_secret.c.person_id == p["id"])).scalar()


def test_wrong_state_is_refused(app, fake):
    p = _person()
    c = TestClient(app)
    _start(c, fake)
    fake.claims = {"sub": p["sub"], "email": p["email"]}
    r = c.get("/api/auth/bide/callback", params={"code": "abc", "state": "not-it"}, follow_redirects=False)
    assert r.headers["location"] == f"{WEB}/signin?error=state"
    assert fake.token_calls == []
    # No cookie from /login at all (another browser): refused the same way.
    r = TestClient(app).get("/api/auth/bide/callback", params={"code": "a", "state": "b"}, follow_redirects=False)
    assert r.headers["location"] == f"{WEB}/signin?error=state"
    assert _sessions(p["id"]) == []


@pytest.mark.parametrize(
    "claims",
    [
        {"nonce": "another-sign-in"},
        {"aud": "linen-tracker"},
        {"iss": "https://evil.test"},
        {"exp": int(time.time()) - 600},
    ],
    ids=["nonce", "aud", "iss", "expired"],
)
def test_bad_id_token_is_refused(app, fake, claims):
    p = _person()
    c = TestClient(app)
    assert _sign_in(c, fake, p, **claims) == f"{WEB}/signin?error=hub"
    assert _sessions(p["id"]) == []


def test_token_signed_by_another_key_is_refused(app, fake, monkeypatch):
    p = _person()
    other = JsonWebKey.generate_key("RSA", 2048, is_private=True, options={"kid": "test-1"})
    monkeypatch.setattr(
        FakeHub, "sign", lambda self, claims, key=None: jwt.encode({"alg": "RS256"}, claims, other).decode()
    )
    assert _sign_in(TestClient(app), fake, p) == f"{WEB}/signin?error=hub"
    assert _sessions(p["id"]) == []


def test_hub_says_no_access(app, fake):
    c = TestClient(app)
    q = _start(c, fake)
    r = c.get("/api/auth/bide/callback", params={"error": "access_denied", "state": q["state"]}, follow_redirects=False)
    assert r.headers["location"] == f"{WEB}/signin?error=denied"


def test_unknown_person_is_refused_not_created(app, fake):
    p = {"sub": str(uuid.uuid4()), "email": f"stranger-{uuid.uuid4().hex[:6]}@bidehotels.com"}
    assert _sign_in(TestClient(app), fake, p) == f"{WEB}/signin?error=unknown"
    with engine.connect() as conn:
        assert conn.execute(select(person.c.id).where(person.c.email == p["email"])).first() is None
        assert conn.execute(select(person.c.id).where(person.c.bide_hub_sub == p["sub"])).first() is None


def test_links_by_email_then_by_sub(app, fake):
    p = _person()
    c = TestClient(app)
    _sign_in(c, fake, p)  # linked by email
    with engine.begin() as conn:
        assert conn.execute(select(person.c.bide_hub_sub).where(person.c.id == p["id"])).scalar() == p["sub"]
        # The address changes here; the Hub sub still finds them.
        conn.execute(update(person).where(person.c.id == p["id"]).values(email=f"renamed-{p['email']}"))
    assert _sign_in(c, fake, p) == f"{WEB}/signin/code"  # found, so on to the device code
    # Someone else's Hub account with this person's address doesn't take the linked account over.
    other = {"sub": str(uuid.uuid4()), "email": f"renamed-{p['email']}"}
    assert _sign_in(TestClient(app), fake, other) == f"{WEB}/signin?error=mismatch"


def test_leaver_is_refused(app, fake):
    p = _person()
    with engine.begin() as conn:
        conn.execute(update(person).where(person.c.id == p["id"]).values(employment_status="leaver"))
    assert _sign_in(TestClient(app), fake, p) == f"{WEB}/signin?error=inactive"


def test_google_start_hands_over_to_bide(app, fake):
    r = TestClient(app).get("/api/auth/google/start", params={"app": "field", "next": "/x"}, follow_redirects=False)
    assert r.headers["location"] == "/api/auth/bide/login?app=field&next=%2Fx"
    r = TestClient(app).get("/api/auth/google/callback", params={"code": "a", "state": "b"})
    assert r.status_code == 404


def test_csp_allows_the_switcher(app, fake):
    csp = TestClient(app).get("/api/health").headers["content-security-policy"]
    assert "script-src 'self' https://hub.test;" in csp and "connect-src 'self' https://hub.test;" in csp


# --- outsiders and break-glass are unchanged --------------------------------------------------------------------------


def test_magic_link_still_works_when_on(app, fake):
    p = _person(("assessor",), kind="external")
    c = TestClient(app)
    assert c.post("/api/auth/magic", json={"email": p["email"], "app": "web"}).status_code == 200
    link = re.search(r"(http\S+/api/auth/magic/\S+)", [m for m in emailer.outbox if m["to"] == p["email"]][-1]["text"])
    r = c.get(urlsplit(link.group(1)).path, follow_redirects=False)
    assert r.headers["location"] == f"{WEB}/signin/code"


def _magic_links(email: str) -> list[str]:
    return [
        urlsplit(re.search(r"(http\S+/api/auth/magic/\S+)", m["text"]).group(1)).path
        for m in emailer.outbox
        if m["to"] == email and "/api/auth/magic/" in m["text"]
    ]


def test_magic_link_refused_to_staff_when_on(app, fake):
    """Staff sign in through the Hub, which can switch them off; an emailed link must not get round that."""
    p = _person(("site_lead",))
    c = TestClient(app)
    r = c.post("/api/auth/magic", json={"email": p["email"], "app": "web"})
    assert r.status_code == 200 and r.json() == {"ok": True}  # the same answer as for anyone else
    assert _magic_links(p["email"]) == []


def test_magic_link_from_before_the_hub_stops_working_for_staff(app, fake, monkeypatch):
    p = _person(("site_lead",))
    c = TestClient(app)
    with monkeypatch.context() as m:
        m.setattr(settings, "bide_hub_client_secret", "")  # Hub off when the link was sent
        assert c.post("/api/auth/magic", json={"email": p["email"], "app": "web"}).status_code == 200
    (link,) = _magic_links(p["email"])
    r = c.get(link, follow_redirects=False)
    assert r.status_code == 302 and r.headers["location"] == f"{WEB}/signin?error=staff"
    assert _sessions(p["id"]) == []


def test_magic_link_refused_to_outside_people_with_a_bide_account(app, fake):
    """An outside person who has signed in with Bide is the Hub's to switch off; an emailed link must not get round it,
    whether asked for after linking or sent before."""
    p = _person(("assessor",), kind="external")
    c = TestClient(app)
    assert c.post("/api/auth/magic", json={"email": p["email"], "app": "web"}).status_code == 200
    (old,) = _magic_links(p["email"])
    _signed_in(app, fake, p)  # links bide_hub_sub
    assert c.post("/api/auth/magic", json={"email": p["email"], "app": "web"}).json() == {"ok": True}
    assert _magic_links(p["email"]) == [old]  # no new link sent
    r = c.get(old, follow_redirects=False)
    assert r.status_code == 302 and r.headers["location"] == f"{WEB}/signin?error=staff"


def test_magic_link_works_once(app, fake):
    p = _person(("assessor",), kind="external")
    c = TestClient(app)
    assert c.post("/api/auth/magic", json={"email": p["email"], "app": "web"}).status_code == 200
    (link,) = _magic_links(p["email"])
    assert c.get(link, follow_redirects=False).headers["location"] == f"{WEB}/signin/code"
    again = TestClient(app).get(link, follow_redirects=False)
    assert again.headers["location"] == f"{WEB}/signin?error=link"
    # A link in the format sent before links became single-use (no challenge) is refused too.
    legacy = auth._serializer("magic").dumps({"p": str(p["id"]), "a": "web"})
    assert c.get(f"/api/auth/magic/{legacy}", follow_redirects=False).headers["location"] == f"{WEB}/signin?error=link"


# --- sign-out --------------------------------------------------------------------------------------------------------


def _signed_in(app, fake, p: dict, sid: str | None = None, client_app: str = "web") -> TestClient:
    c = TestClient(app)
    c.headers.update({"X-Requested-With": "bide-comply", "X-Bide-App": client_app})
    _sign_in(c, fake, p, app=client_app, sid=sid or str(uuid.uuid4()))
    assert c.post("/api/auth/code", json={"code": _emailed_code(p["email"])}).status_code == 200
    assert c.get("/api/me").status_code == 200
    return c


def test_sign_out_goes_on_to_the_hub(app, fake):
    p = _person()
    c = _signed_in(app, fake, p)
    r = c.post("/api/auth/logout").json()
    assert r["redirect"] == (
        f"{ISSUER}/oauth/logout?client_id=comply&post_logout_redirect_uri=http%3A%2F%2Flocalhost%3A5180%2F"
    )
    assert c.get("/api/me").status_code == 401
    f = _signed_in(app, fake, p, client_app="field")
    assert (
        f.post("/api/auth/logout")
        .json()["redirect"]
        .endswith("post_logout_redirect_uri=http%3A%2F%2Flocalhost%3A5181%2F")
    )


def test_sign_out_of_a_session_not_from_the_hub_stays_local(app, fake):
    c = TestClient(app)
    c.headers.update({"X-Requested-With": "bide-comply"})
    assert c.post("/api/auth/dev", json={"person_id": str(_person()["id"])}).status_code == 200
    assert c.post("/api/auth/logout").json() == {"ok": True}


def test_backchannel_logout_by_sid_ends_that_session_only(app, fake):
    p = _person()
    sid = str(uuid.uuid4())
    one = _signed_in(app, fake, p, sid=sid)
    two = _signed_in(app, fake, p)  # another Hub session (another browser)
    r = TestClient(app).post(
        "/api/auth/bide/backchannel-logout", data={"logout_token": fake.logout_token(sub=p["sub"], sid=sid)}
    )
    assert r.status_code == 200
    assert one.get("/api/me").status_code == 401
    assert one.post("/api/auth/refresh").status_code == 401
    assert two.get("/api/me").status_code == 200
    with engine.connect() as conn:
        ev = (
            conn.execute(
                select(audit_event).where(audit_event.c.action == "sign_out", audit_event.c.actor_id == p["id"])
            )
            .mappings()
            .all()
        )
    assert len(ev) == 1 and ev[0]["summary"] == "Signed out from Bide Hub"


def test_backchannel_logout_by_sub_ends_every_session(app, fake):
    p = _person()
    one = _signed_in(app, fake, p)
    two = _signed_in(app, fake, p)
    r = TestClient(app).post(
        "/api/auth/bide/backchannel-logout", data={"logout_token": fake.logout_token(sub=p["sub"])}
    )
    assert r.status_code == 200
    assert one.get("/api/me").status_code == 401 and two.get("/api/me").status_code == 401
    assert all(s["revoked_at"] for s in _sessions(p["id"]))


def _disabled_token(fake: FakeHub, sub: str) -> str:
    return fake.logout_token(sub=sub, events={hub.BACKCHANNEL_EVENT: {}, hub.ACCOUNT_DISABLED_EVENT: {}})


def _status(pid) -> str:
    with engine.connect() as conn:
        return conn.execute(select(person.c.employment_status).where(person.c.id == pid)).scalar_one()


def test_switched_off_on_the_hub_becomes_a_leaver(app, fake):
    p = _person()
    c = _signed_in(app, fake, p)  # links bide_hub_sub
    for _ in range(2):  # the Hub retries until it gets a 2xx: the second delivery must be harmless
        r = TestClient(app).post(
            "/api/auth/bide/backchannel-logout", data={"logout_token": _disabled_token(fake, p["sub"])}
        )
        assert r.status_code == 200
    assert c.get("/api/me").status_code == 401
    assert _status(p["id"]) == "leaver"
    with engine.connect() as conn:
        ev = (
            conn.execute(
                select(audit_event.c.summary).where(
                    audit_event.c.action == "people.offboard", audit_event.c.entity_id == str(p["id"])
                )
            )
            .scalars()
            .all()
        )
    assert len(ev) == 1 and "switched off on Bide Hub" in ev[0]
    assert _sign_in(TestClient(app), fake, p) == f"{WEB}/signin?error=inactive"


def test_switch_off_matches_by_sub_never_by_email(app, fake):
    p = _person()  # never signed in through the Hub, so no bide_hub_sub
    r = TestClient(app).post(
        "/api/auth/bide/backchannel-logout", data={"logout_token": _disabled_token(fake, p["sub"])}
    )
    assert r.status_code == 200
    assert _status(p["id"]) == "active"


def test_a_plain_hub_logout_does_not_offboard(app, fake):
    p = _person()
    _signed_in(app, fake, p)
    r = TestClient(app).post(
        "/api/auth/bide/backchannel-logout", data={"logout_token": fake.logout_token(sub=p["sub"])}
    )
    assert r.status_code == 200
    assert _status(p["id"]) == "active"


@pytest.mark.parametrize(
    "claims",
    [
        {"events": {"something-else": {}}},
        {"nonce": "n"},
        {"aud": "linen-tracker"},
        {"sid": None, "sub": None},
    ],
    ids=["no-event", "nonce", "aud", "nobody"],
)
def test_backchannel_logout_refuses_bad_tokens(app, fake, claims):
    p = _person()
    sid = str(uuid.uuid4())
    c = _signed_in(app, fake, p, sid=sid)
    body = {"sub": p["sub"], "sid": sid} | claims
    r = TestClient(app).post("/api/auth/bide/backchannel-logout", data={"logout_token": fake.logout_token(**body)})
    assert r.status_code == 400
    assert c.get("/api/me").status_code == 200


def test_break_glass_admin_login_still_works_when_on(app, fake, monkeypatch):
    from bide_comply import passwords

    p = _person(("super_admin",))
    monkeypatch.setattr(settings, "admin_login_username", "bidesuperadmin")
    monkeypatch.setattr(settings, "admin_login_email", p["email"])
    monkeypatch.setattr(settings, "admin_login_password_hash", passwords.hash_password("Pw-for-the-test-only-123"))
    ratelimit._local.clear()
    c = TestClient(app)
    c.headers.update({"X-Requested-With": "bide-comply"})
    r = c.post("/api/auth/admin-password", json={"username": "bidesuperadmin", "password": "Pw-for-the-test-only-123"})
    assert r.status_code == 200 and r.json()["next"] == "/signin/totp-setup"
    ratelimit._local.clear()
