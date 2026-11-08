"""Sign-in, device trust and sessions (PRD §8, §9.2).

- Staff: Google Workspace OIDC with Authorization Code + PKCE; iss, aud, exp and the hd claim are checked here.
  When Bide Hub is configured (BIDE_HUB_*), "Sign in with Bide" takes the place of Google; see hub.py. Everything
  after the identity step below is the same either way, and a sign-out on the Hub ends the sessions it started.
- Break-glass: one Super Admin can sign in with a username and password (ADMIN_LOGIN_*), for an install that has
  neither Google sign-in nor email yet. The authenticator app is still required after the password.
- Outside people (assessor, SPV directors without a bide account, contractors): an emailed magic link, 8-hour sessions.
  Each link works once. With Bide Hub on, only outside people (kind external) can use one; staff go through the Hub.
- A first sign-in on a device needs an emailed 6-digit code (single use, 10 minutes, 5 attempts). Admin roles also
  need an authenticator app (TOTP).
- Access tokens last 15 minutes. Refresh tokens rotate on use; presenting an old one again revokes the device.
- Cookies are HttpOnly, Secure (outside development) and SameSite=Lax. Mutations also need the X-Requested-With
  header, which a cross-site form can't send.
"""

import base64
import hashlib
import hmac
import secrets
import time
import uuid
from dataclasses import dataclass
from datetime import timedelta
from typing import Annotated
from urllib.parse import urlencode, urlsplit

import httpx
import pyotp
from fastapi import APIRouter, Depends, Form, HTTPException, Request, Response
from fastapi.responses import RedirectResponse
from itsdangerous import BadSignature, SignatureExpired, URLSafeTimedSerializer
from pydantic import BaseModel
from sqlalchemy import Connection, func, or_, select, update

from bide_comply import audit, clock, emailer, hub, passwords, ratelimit
from bide_comply.authz import STRONG_AUTH_ROLES, Principal, load_principal
from bide_comply.config import settings
from bide_comply.db import ConnDep
from bide_comply.schema import auth_session, device, otp_challenge, person, role_assignment, totp_secret
from bide_comply.services import contact

ACCESS_COOKIE = "bc_access"
REFRESH_COOKIE = "bc_refresh"
DEVICE_COOKIE = "bc_device"
PENDING_COOKIE = "bc_pending"
PKCE_COOKIE = "bc_pkce"
BIDE_COOKIE = "bc_bide"

GOOGLE_AUTH = "https://accounts.google.com/o/oauth2/v2/auth"
GOOGLE_TOKEN = "https://oauth2.googleapis.com/token"  # noqa: S105 - a URL, not a secret
GOOGLE_JWKS = "https://www.googleapis.com/oauth2/v3/certs"
GOOGLE_ISSUERS = {"https://accounts.google.com", "accounts.google.com"}


def _secret() -> str:
    if not settings.session_secret:
        if settings.environment != "development":
            raise RuntimeError("SESSION_SECRET must be set outside development")
        return "dev-insecure-secret"
    return settings.session_secret


def _serializer(salt: str) -> URLSafeTimedSerializer:
    return URLSafeTimedSerializer(_secret(), salt=salt)


def _h(value: str) -> str:
    return hashlib.sha256(value.encode()).hexdigest()


def _cookie(response: Response, name: str, value: str, max_age: int, path: str = "/") -> None:
    response.set_cookie(
        name,
        value,
        max_age=max_age,
        httponly=True,
        secure=settings.environment != "development",
        samesite="lax",
        path=path,
    )


def _drop_cookie(response: Response, name: str, path: str = "/") -> None:
    """Clear a cookie with the same flags it was set with."""
    response.delete_cookie(name, path=path, httponly=True, secure=settings.environment != "development", samesite="lax")


def _client_label(request: Request, app: str) -> str:
    ua = (request.headers.get("user-agent") or "").lower()
    browser = next((b for b in ("edg", "chrome", "firefox", "safari") if b in ua), "browser")
    names = {"edg": "Edge", "chrome": "Chrome", "firefox": "Firefox", "safari": "Safari", "browser": "browser"}
    if "iphone" in ua:
        dev = "iPhone"
    elif "android" in ua:
        dev = "Android phone"
    elif "ipad" in ua:
        dev = "iPad"
    else:
        dev = names[browser]
    return f"{'Staff app' if app == 'field' else 'Web'} · {dev}"


def actor_for(request: Request, principal: "Principal | None") -> audit.Actor:
    ip = ratelimit.client_ip(request)
    app = request.headers.get("x-bide-app", "web")
    if principal is None:
        return audit.Actor(None, "Anonymous", ip, _client_label(request, app))
    return audit.Actor(principal.person_id, principal.name, ip, _client_label(request, app))


# ---------------------------------------------------------------------------------------------------------------------
# Establishing a session once identity is known
# ---------------------------------------------------------------------------------------------------------------------


def _device_token(request: Request, response: Response) -> str:
    tok = request.cookies.get(DEVICE_COOKIE)
    if not tok or len(tok) < 32:
        tok = secrets.token_urlsafe(32)
        _cookie(response, DEVICE_COOKIE, tok, 400 * 24 * 3600)
    return tok


def _find_or_create_device(conn: Connection, person_id: uuid.UUID, token: str, label: str, app: str) -> dict:
    fp = _h(token)
    row = (
        conn.execute(select(device).where(device.c.person_id == person_id, device.c.fingerprint_hash == fp))
        .mappings()
        .first()
    )
    if row:
        return dict(row)
    did = uuid.uuid4()
    conn.execute(device.insert().values(id=did, person_id=person_id, label=label, app=app, fingerprint_hash=fp))
    return dict(conn.execute(select(device).where(device.c.id == did)).mappings().one())


def _device_trusted(d: dict) -> bool:
    now = clock.now()
    return bool(d["trusted_at"] and not d["revoked_at"] and d["trusted_until"] and d["trusted_until"] > now)


def _roles(conn: Connection, person_id: uuid.UUID) -> set[str]:
    return set(conn.execute(select(role_assignment.c.role).where(role_assignment.c.person_id == person_id)).scalars())


def start_session(
    conn: Connection,
    response: Response,
    p: dict,
    device_id: uuid.UUID,
    totp_ok: bool = False,
    hub_sid: str | None = None,
) -> None:
    raw = secrets.token_urlsafe(48)
    now = clock.now()
    external = p["kind"] == "external"
    life = timedelta(hours=settings.external_session_hours) if external else timedelta(days=settings.refresh_days)
    strong = bool(_roles(conn, p["id"]) & STRONG_AUTH_ROLES)
    sid = uuid.uuid4()
    conn.execute(
        auth_session.insert().values(
            id=sid,
            person_id=p["id"],
            device_id=device_id,
            refresh_hash=_h(raw),
            expires_at=now + life,
            idle_expires_at=now + timedelta(minutes=settings.admin_idle_minutes) if strong else None,
            last_used_at=now,
            totp_ok=totp_ok,
            hub_sid=hub_sid,
        )
    )
    conn.execute(update(device).where(device.c.id == device_id).values(last_seen_at=now))
    _set_access(response, sid, p["id"])
    _cookie(response, REFRESH_COOKIE, raw, int(life.total_seconds()), path="/api/auth")
    _drop_cookie(response, PENDING_COOKIE, "/")


def _set_access(response: Response, sid: uuid.UUID, pid: uuid.UUID) -> None:
    tok = _serializer("access").dumps({"s": str(sid), "p": str(pid)})
    _cookie(response, ACCESS_COOKIE, tok, settings.access_minutes * 60)


def _send_otp(conn: Connection, p: dict, device_id: uuid.UUID, purpose: str = "new_device") -> uuid.UUID:
    code = f"{secrets.randbelow(1_000_000):06d}"
    cid = uuid.uuid4()
    conn.execute(
        otp_challenge.insert().values(
            id=cid,
            person_id=p["id"],
            device_id=device_id,
            purpose=purpose,
            code_hash=_h(f"{cid}:{code}"),
            expires_at=clock.now() + timedelta(minutes=settings.otp_minutes),
        )
    )
    emailer.send(
        p["email"],
        f"Your Bide Comply code: {code}",
        f"Your code is {code}. It works for {settings.otp_minutes} minutes.\n\n"
        "You're seeing this because someone signed in to Bide Comply on a new device. If it wasn't you, tell "
        f"{contact.phrase(conn)} straight away.",
    )
    return cid


@dataclass
class Pending:
    person_id: uuid.UUID
    device_id: uuid.UUID
    challenge_id: uuid.UUID | None
    app: str
    next: str
    stage: str  # otp | totp | totp_setup
    hub_sid: str | None = None  # signed in through Bide Hub: carried to the session once the steps are done


def _set_pending(response: Response, pend: Pending) -> None:
    tok = _serializer("pending").dumps(
        {
            "p": str(pend.person_id),
            "d": str(pend.device_id),
            "c": str(pend.challenge_id) if pend.challenge_id else None,
            "a": pend.app,
            "n": pend.next,
            "s": pend.stage,
            "h": pend.hub_sid,
        }
    )
    _cookie(response, PENDING_COOKIE, tok, 15 * 60)


def _get_pending(request: Request) -> Pending:
    tok = request.cookies.get(PENDING_COOKIE)
    if not tok:
        raise HTTPException(401, detail={"code": "no_pending", "message": "Start signing in again."})
    try:
        d = _serializer("pending").loads(tok, max_age=15 * 60)
    except BadSignature:
        raise HTTPException(401, detail={"code": "no_pending", "message": "Start signing in again."}) from None
    challenge = uuid.UUID(d["c"]) if d["c"] else None
    return Pending(uuid.UUID(d["p"]), uuid.UUID(d["d"]), challenge, d["a"], d["n"], d["s"], d.get("h"))


def establish(
    conn: Connection,
    request: Request,
    response: Response,
    p: dict,
    app: str,
    next_: str,
    via: str,
    trust_without_code: bool = False,
    trust_device: bool = False,
    hub_sid: str | None = None,
) -> dict:
    """After Google or Bide Hub, a magic link or dev sign-in: start a session, or ask for the device code first.

    trust_without_code skips both the device code and the authenticator app (dev sign-in). trust_device skips only
    the device code: the admin password sign-in has no email to send one to, but admin roles still need the app.
    hub_sid is the Bide Hub session behind this sign-in; the session (or the pending steps) keeps it.
    """
    if p["employment_status"] != "active":
        raise HTTPException(403, detail={"code": "inactive", "message": "This account no longer has access."})
    label = _client_label(request, app)
    d = _find_or_create_device(conn, p["id"], _device_token(request, response), label, app)
    if d["revoked_at"]:
        # A revoked device can be trusted again, but only through a fresh code.
        conn.execute(update(device).where(device.c.id == d["id"]).values(revoked_at=None, trusted_at=None))
        d["trusted_at"] = None
        d["revoked_at"] = None
    actor = audit.Actor(p["id"], p["name"], ratelimit.client_ip(request), label)
    if trust_without_code:
        conn.execute(
            update(device)
            .where(device.c.id == d["id"])
            .values(trusted_at=clock.now(), trusted_until=clock.now() + timedelta(days=settings.device_trust_days))
        )
        start_session(conn, response, p, d["id"], totp_ok=True)
        audit.record(conn, actor, category="sign_in", action="sign_in", summary=f"Signed in ({via})")
        return {"next": next_}
    if trust_device and not _device_trusted(d):
        now = clock.now()
        until = now + timedelta(days=settings.device_trust_days)
        conn.execute(update(device).where(device.c.id == d["id"]).values(trusted_at=now, trusted_until=until))
        d["trusted_at"], d["trusted_until"] = now, until
    if _device_trusted(d):
        strong = bool(_roles(conn, p["id"]) & STRONG_AUTH_ROLES)
        if strong:
            # Admin roles confirm with the authenticator app on every sign-in, not only on a new device.
            stage = "totp" if _totp_confirmed(conn, p["id"]) else "totp_setup"
            cid = _totp_challenge(conn, p["id"], d["id"])
            _set_pending(response, Pending(p["id"], d["id"], cid, app, next_, stage, hub_sid))
            return {"next": f"/signin/{stage.replace('_', '-')}"}
        start_session(conn, response, p, d["id"], hub_sid=hub_sid)
        audit.record(conn, actor, category="sign_in", action="sign_in", summary=f"Signed in ({via})")
        return {"next": next_}
    cid = _send_otp(conn, p, d["id"])
    _set_pending(response, Pending(p["id"], d["id"], cid, app, next_, "otp", hub_sid))
    return {"next": "/signin/code"}


TOTP_ATTEMPTS = 5


def _totp_challenge(conn: Connection, person_id: uuid.UUID, device_id: uuid.UUID) -> uuid.UUID:
    """The authenticator-app step of one sign-in. It counts wrong codes: after TOTP_ATTEMPTS it's spent, and signing in
    starts again from the top. Lives as long as the pending cookie."""
    cid = uuid.uuid4()
    conn.execute(
        otp_challenge.insert().values(
            id=cid,
            person_id=person_id,
            device_id=device_id,
            purpose="totp",
            code_hash=_h(f"{cid}:totp"),  # unused: the code comes from the authenticator app
            expires_at=clock.now() + timedelta(minutes=15),
        )
    )
    return cid


def _totp_step(secret: str, code: str) -> int | None:
    """The 30-second time step the code belongs to (this one, or one either side for clock drift), or None."""
    totp = pyotp.TOTP(secret)
    current = int(time.time() // totp.interval)
    for step in (current - 1, current, current + 1):
        if hmac.compare_digest(totp.generate_otp(step), code):
            return step
    return None


def _totp_confirmed(conn: Connection, person_id: uuid.UUID) -> bool:
    row = conn.execute(select(totp_secret.c.confirmed_at).where(totp_secret.c.person_id == person_id)).first()
    return bool(row and row.confirmed_at)


# ---------------------------------------------------------------------------------------------------------------------
# Current principal
# ---------------------------------------------------------------------------------------------------------------------


def _session_from_cookie(conn: Connection, request: Request) -> tuple[dict, dict] | None:
    tok = request.cookies.get(ACCESS_COOKIE)
    if not tok:
        return None
    try:
        d = _serializer("access").loads(tok, max_age=settings.access_minutes * 60)
    except SignatureExpired:
        raise HTTPException(401, detail={"code": "access_expired", "message": "Refresh the session."}) from None
    except BadSignature:
        return None
    s = conn.execute(select(auth_session).where(auth_session.c.id == uuid.UUID(d["s"]))).mappings().first()
    if not s or s["revoked_at"] or s["expires_at"] < clock.now():
        return None
    now = clock.now()
    if s["idle_expires_at"] and s["idle_expires_at"] < now:
        conn.execute(update(auth_session).where(auth_session.c.id == s["id"]).values(revoked_at=now))
        raise HTTPException(401, detail={"code": "idle", "message": "Signed out after 30 minutes without activity."})
    p = conn.execute(select(person).where(person.c.id == s["person_id"])).mappings().first()
    if not p or p["employment_status"] != "active":
        return None
    if s["last_used_at"] is None or (now - s["last_used_at"]).total_seconds() > 60:
        vals: dict = {"last_used_at": now}
        if s["idle_expires_at"]:
            vals["idle_expires_at"] = now + timedelta(minutes=settings.admin_idle_minutes)
        conn.execute(update(auth_session).where(auth_session.c.id == s["id"]).values(**vals))
    return dict(s), dict(p)


def optional_principal(request: Request, conn: ConnDep) -> Principal | None:
    found = _session_from_cookie(conn, request)
    if not found:
        return None
    s, p = found
    pr = load_principal(conn, p)
    pr.device_id = s["device_id"]
    pr.session_id = s["id"]
    request.state.principal = pr
    return pr


def current_principal(request: Request, conn: ConnDep) -> Principal:
    pr = optional_principal(request, conn)
    if pr is None:
        raise HTTPException(401, detail={"code": "signed_out", "message": "Please sign in."})
    if request.method not in ("GET", "HEAD", "OPTIONS") and request.headers.get("x-requested-with") != "bide-comply":
        raise HTTPException(403, detail={"code": "csrf", "message": "Missing request header."})
    return pr


Current = Annotated[Principal, Depends(current_principal)]

# ---------------------------------------------------------------------------------------------------------------------
# Routes
# ---------------------------------------------------------------------------------------------------------------------

router = APIRouter(prefix="/api/auth", tags=["auth"])


def _app_base(app: str) -> str:
    return settings.field_base_url if app == "field" else settings.web_base_url


def _safe_next(next_: str | None) -> str:
    return next_ if next_ and next_.startswith("/") and not next_.startswith("//") else "/"


@router.get("/google/start")
def google_start(app: str = "web", next: str | None = None) -> RedirectResponse:  # noqa: A002 - query name
    if settings.bide_hub_on:
        # Bide Hub has taken over the Google step (it signs people in with Google itself); old links still work.
        return RedirectResponse(f"/api/auth/bide/login?{urlencode({'app': app, 'next': _safe_next(next)})}", 302)
    if not settings.google_client_id:
        raise HTTPException(503, detail={"code": "sso_off", "message": "Google sign-in isn't configured here."})
    verifier = secrets.token_urlsafe(64)
    challenge = base64.urlsafe_b64encode(hashlib.sha256(verifier.encode()).digest()).rstrip(b"=").decode()
    state = secrets.token_urlsafe(24)
    nonce = secrets.token_urlsafe(24)
    params = {
        "client_id": settings.google_client_id,
        "redirect_uri": f"{settings.api_base_url}/api/auth/google/callback",
        "response_type": "code",
        "scope": "openid email profile",
        "state": state,
        "nonce": nonce,
        "code_challenge": challenge,
        "code_challenge_method": "S256",
        "prompt": "select_account",
    }
    if len(settings.workspace_domains) == 1:
        params["hd"] = settings.workspace_domains[0]
    resp = RedirectResponse(f"{GOOGLE_AUTH}?{urlencode(params)}", status_code=302)
    tok = _serializer("pkce").dumps({"v": verifier, "s": state, "n": nonce, "a": app, "x": _safe_next(next)})
    _cookie(resp, PKCE_COOKIE, tok, 600, path="/api/auth/google")
    return resp


def _verify_id_token(id_token: str, nonce: str) -> dict:
    from authlib.jose import JsonWebKey, jwt

    jwks = httpx.get(GOOGLE_JWKS, timeout=10).json()
    claims = jwt.decode(id_token, JsonWebKey.import_key_set(jwks))
    claims.validate()  # exp, iat
    if claims["iss"] not in GOOGLE_ISSUERS:
        raise HTTPException(401, detail={"code": "bad_token", "message": "Sign-in failed."})
    if claims["aud"] != settings.google_client_id:
        raise HTTPException(401, detail={"code": "bad_token", "message": "Sign-in failed."})
    if not hmac.compare_digest(claims.get("nonce", ""), nonce):
        raise HTTPException(401, detail={"code": "bad_token", "message": "Sign-in failed."})
    hd = (claims.get("hd") or "").lower()
    if hd not in settings.workspace_domains or not claims.get("email_verified"):
        raise HTTPException(403, detail={"code": "domain", "message": "Use your Bide Google account."})
    return dict(claims)


@router.get("/google/callback")
def google_callback(request: Request, conn: ConnDep, code: str, state: str) -> RedirectResponse:
    if settings.bide_hub_on:
        raise HTTPException(404, detail={"code": "not_found", "message": "Sign in with Bide instead."})
    try:
        pk = _serializer("pkce").loads(request.cookies.get(PKCE_COOKIE, ""), max_age=600)
    except BadSignature:
        raise HTTPException(400, detail={"code": "state", "message": "Sign-in expired. Try again."}) from None
    if not hmac.compare_digest(pk["s"], state):
        raise HTTPException(400, detail={"code": "state", "message": "Sign-in expired. Try again."})
    tokens = httpx.post(
        GOOGLE_TOKEN,
        data={
            "code": code,
            "client_id": settings.google_client_id,
            "client_secret": settings.google_client_secret,
            "redirect_uri": f"{settings.api_base_url}/api/auth/google/callback",
            "grant_type": "authorization_code",
            "code_verifier": pk["v"],
        },
        timeout=15,
    ).json()
    if "id_token" not in tokens:
        raise HTTPException(401, detail={"code": "bad_token", "message": "Sign-in failed."})
    claims = _verify_id_token(tokens["id_token"], pk["n"])
    email = claims["email"].lower()
    p = conn.execute(select(person).where(person.c.email == email)).mappings().first()
    if not p:
        raise HTTPException(
            403,
            detail={
                "code": "unknown",
                "message": f"You're not set up in Bide Comply yet. Ask {contact.phrase(conn, with_role=False)}.",
            },
        )
    if not p["google_sub"]:
        conn.execute(update(person).where(person.c.id == p["id"]).values(google_sub=claims["sub"]))
    elif p["google_sub"] != claims["sub"]:
        raise HTTPException(403, detail={"code": "mismatch", "message": "Sign-in failed."})
    app = pk["a"]
    resp = RedirectResponse(_app_base(app), status_code=302)
    result = establish(conn, request, resp, dict(p), app, pk["x"], "Google")
    resp.headers["location"] = _app_base(app) + result["next"]
    _drop_cookie(resp, PKCE_COOKIE, "/api/auth/google")
    return resp


# ---------------------------------------------------------------------------------------------------------------------
# Sign in with Bide (Bide Hub OIDC). Replaces only the Google step; establish() does the rest exactly as before.
# ---------------------------------------------------------------------------------------------------------------------


def _bide_redirect_uri(app: str) -> str:
    """The callback on the origin the app is served from, as registered on the Hub. Production serves the portal at
    / and the staff app at /app on one origin, so both share one callback; in development each Vite server proxies
    /api to the API, so each origin has its own."""
    base = urlsplit(_app_base(app))
    return f"{base.scheme}://{base.netloc}/api/auth/bide/callback"


def _signin_error(app: str, code: str) -> RedirectResponse:
    resp = RedirectResponse(f"{_app_base(app)}/signin?{urlencode({'error': code})}", status_code=302)
    _drop_cookie(resp, BIDE_COOKIE, "/api/auth/bide")
    return resp


@router.get("/bide")
def bide_state() -> dict:
    """Whether the sign-in pages show Sign in with Bide, and the Hub the app switcher loads from."""
    return {"enabled": settings.bide_hub_on, "issuer": hub.issuer() if settings.bide_hub_on else None}


@router.get("/bide/login")
def bide_login(app: str = "web", next: str | None = None) -> RedirectResponse:  # noqa: A002 - query name
    if not settings.bide_hub_on:
        raise HTTPException(404, detail={"code": "not_found", "message": "Not found."})
    app = "field" if app == "field" else "web"
    verifier = secrets.token_urlsafe(64)
    challenge = base64.urlsafe_b64encode(hashlib.sha256(verifier.encode()).digest()).rstrip(b"=").decode()
    state = secrets.token_urlsafe(24)
    nonce = secrets.token_urlsafe(24)
    try:
        url = hub.authorize_url(
            response_type="code",
            client_id=settings.bide_hub_client_id,
            redirect_uri=_bide_redirect_uri(app),
            scope="openid email profile",
            state=state,
            nonce=nonce,
            code_challenge=challenge,
            code_challenge_method="S256",
        )
    except hub.HubError:
        return _signin_error(app, "hub")
    resp = RedirectResponse(url, status_code=302)
    tok = _serializer("bide").dumps({"v": verifier, "s": state, "n": nonce, "a": app, "x": _safe_next(next)})
    _cookie(resp, BIDE_COOKIE, tok, 600, path="/api/auth/bide")
    return resp


def _hub_person(conn: Connection, claims: dict) -> dict:
    """The Bide Hub sub first, then the email, which links the sub for next time. Linking by email needs the Hub to say
    the address is verified (email_verified true), so an unverified address can't claim someone's account.
    Bide Comply is invite-only: someone who isn't in Settings › People is refused, as with Google."""
    sub, email = str(claims["sub"]), str(claims["email"]).strip().lower()
    p = conn.execute(select(person).where(person.c.bide_hub_sub == sub)).mappings().first()
    if p:
        return dict(p)
    if claims.get("email_verified") is not True:
        raise HTTPException(403, detail={"code": "unverified", "message": "Sign-in failed."})
    p = conn.execute(select(person).where(func.lower(person.c.email) == email)).mappings().first()
    if not p:
        raise HTTPException(403, detail={"code": "unknown", "message": "You're not set up in Bide Comply yet."})
    if p["bide_hub_sub"] and p["bide_hub_sub"] != sub:
        # Already linked to a different Hub account: don't let a reused address take this one over.
        raise HTTPException(403, detail={"code": "mismatch", "message": "Sign-in failed."})
    conn.execute(update(person).where(person.c.id == p["id"]).values(bide_hub_sub=sub))
    return dict(p) | {"bide_hub_sub": sub}


@router.get("/bide/callback")
def bide_callback(
    request: Request,
    conn: ConnDep,
    code: str | None = None,
    state: str | None = None,
    error: str | None = None,
) -> RedirectResponse:
    if not settings.bide_hub_on:
        raise HTTPException(404, detail={"code": "not_found", "message": "Not found."})
    try:
        pk = _serializer("bide").loads(request.cookies.get(BIDE_COOKIE, ""), max_age=600)
    except BadSignature:
        return _signin_error("web", "state")
    app = pk["a"]
    if not state or not hmac.compare_digest(pk["s"], state):
        return _signin_error(app, "state")
    if error or not code:
        # access_denied: the Hub says this person may not open Bide Comply. login_required and the rest: try again.
        return _signin_error(app, "denied" if error == "access_denied" else "hub")
    try:
        tokens = hub.exchange_code(code, _bide_redirect_uri(app), pk["v"])
        claims = hub.verify_id_token(tokens["id_token"], pk["n"])
    except hub.HubError:
        return _signin_error(app, "hub")
    resp = RedirectResponse(_app_base(app), status_code=302)
    try:
        p = _hub_person(conn, claims)
        result = establish(conn, request, resp, p, app, pk["x"], "Bide Hub", hub_sid=claims.get("sid"))
    except HTTPException as e:
        return _signin_error(app, e.detail["code"] if isinstance(e.detail, dict) else "hub")
    resp.headers["location"] = _app_base(app) + result["next"]
    _drop_cookie(resp, BIDE_COOKIE, "/api/auth/bide")
    return resp


@router.post("/bide/backchannel-logout")
def bide_backchannel_logout(conn: ConnDep, logout_token: Annotated[str, Form()] = "") -> Response:
    """The Hub, server to server, when someone signs out anywhere, everywhere, or is switched off. No cookies come
    with it: the token alone says which sessions end (that Hub sid, or every session of that person).

    Switched off by a Hub admin, the events also carry urn:bide:hub:account-disabled: the person linked to that sub
    (by sub only, never by email) is offboarded as an admin would offboard them in Settings › People. Nobody linked:
    nothing to do."""
    if not settings.bide_hub_on:
        raise HTTPException(404, detail={"code": "not_found", "message": "Not found."})
    try:
        claims = hub.verify_logout_token(logout_token)
    except hub.HubError:
        raise HTTPException(400, detail={"code": "invalid_request", "message": "Not a valid logout token."}) from None
    if hub.ACCOUNT_DISABLED_EVENT in claims["events"] and claims.get("sub"):
        disabled = conn.execute(
            select(person.c.id).where(
                person.c.bide_hub_sub == str(claims["sub"]), person.c.employment_status == "active"
            )
        ).scalar()
        if disabled:
            from bide_comply.services import offboarding  # imports this module

            offboarding.offboard(
                conn, disabled, audit.Actor(None, "Bide Hub", None, "Bide Hub"), via=" (switched off in Bide Hub)"
            )
    now = clock.now()
    live = auth_session.c.revoked_at.is_(None)
    if claims.get("sid"):
        which = auth_session.c.hub_sid == str(claims["sid"])
    else:
        pid = conn.execute(select(person.c.id).where(person.c.bide_hub_sub == str(claims["sub"]))).scalar()
        which = auth_session.c.person_id == pid
    ended = conn.execute(
        update(auth_session).where(which, live).values(revoked_at=now).returning(auth_session.c.person_id)
    ).scalars()
    counts: dict[uuid.UUID, int] = {}
    for pid in ended:
        counts[pid] = counts.get(pid, 0) + 1
    for pid, n in counts.items():
        name = conn.execute(select(person.c.name).where(person.c.id == pid)).scalar() or "Unknown"
        audit.record(
            conn,
            audit.Actor(pid, name, None, "Bide Hub"),
            category="sign_in",
            action="sign_out",
            summary="Signed out from Bide Hub" + (f" ({n} sessions)" if n > 1 else ""),
            entity_type="person",
            entity_id=pid,
        )
    return Response(status_code=200, headers={"Cache-Control": "no-store"})


class CodeIn(BaseModel):
    code: str
    trust: bool = True


@router.get("/pending")
def pending_state(request: Request, conn: ConnDep) -> dict:
    pend = _get_pending(request)
    p = conn.execute(select(person.c.name, person.c.email).where(person.c.id == pend.person_id)).first()
    email = p.email or ""
    local, _, dom = email.partition("@")
    return {
        "stage": pend.stage,
        "name": p.name,
        "email_masked": f"{local[:2]}…@{dom}",
        "app": pend.app,
        "via": "bide" if pend.hub_sid else None,
        "contact": contact.contact(conn),
    }


@router.post("/code")
def verify_code(body: CodeIn, request: Request, response: Response, conn: ConnDep) -> dict:
    pend = _get_pending(request)
    if pend.stage != "otp" or not pend.challenge_id:
        raise HTTPException(400, detail={"code": "stage", "message": "Start signing in again."})
    ch = conn.execute(select(otp_challenge).where(otp_challenge.c.id == pend.challenge_id)).mappings().first()
    now = clock.now()
    if not ch or ch["used_at"] or ch["expires_at"] < now:
        raise HTTPException(400, detail={"code": "expired", "message": "That code has expired. Send a new code."})
    if ch["attempts"] >= settings.otp_attempts:
        raise HTTPException(429, detail={"code": "locked", "message": "Too many tries. Send a new code."})
    conn.execute(update(otp_challenge).where(otp_challenge.c.id == ch["id"]).values(attempts=ch["attempts"] + 1))
    if not hmac.compare_digest(ch["code_hash"], _h(f"{ch['id']}:{body.code.strip()}")):
        left = settings.otp_attempts - ch["attempts"] - 1
        # Commit the attempt count even though the request fails.
        conn.commit()
        raise HTTPException(400, detail={"code": "wrong", "message": f"That code isn't right. {left} tries left."})
    conn.execute(update(otp_challenge).where(otp_challenge.c.id == ch["id"]).values(used_at=now))
    if body.trust:
        conn.execute(
            update(device)
            .where(device.c.id == pend.device_id)
            .values(trusted_at=now, trusted_until=now + timedelta(days=settings.device_trust_days))
        )
    p = dict(conn.execute(select(person).where(person.c.id == pend.person_id)).mappings().one())
    if _roles(conn, p["id"]) & STRONG_AUTH_ROLES:
        stage = "totp" if _totp_confirmed(conn, p["id"]) else "totp_setup"
        cid = _totp_challenge(conn, p["id"], pend.device_id)
        _set_pending(response, Pending(pend.person_id, pend.device_id, cid, pend.app, pend.next, stage, pend.hub_sid))
        return {"next": f"/signin/{stage.replace('_', '-')}"}
    start_session(conn, response, p, pend.device_id, hub_sid=pend.hub_sid)
    audit.record(
        conn,
        audit.Actor(p["id"], p["name"], ratelimit.client_ip(request), _client_label(request, pend.app)),
        category="sign_in",
        action="new_device",
        summary="Signed in on a new device (email code confirmed)",
    )
    return {"next": pend.next}


@router.post("/code/resend")
def resend_code(request: Request, response: Response, conn: ConnDep) -> dict:
    pend = _get_pending(request)
    if pend.stage != "otp":
        # Not from the authenticator step: a new code there would start a fresh set of tries at the app.
        raise HTTPException(400, detail={"code": "stage", "message": "Start signing in again."})
    p = dict(conn.execute(select(person).where(person.c.id == pend.person_id)).mappings().one())
    cid = _send_otp(conn, p, pend.device_id)
    _set_pending(response, Pending(pend.person_id, pend.device_id, cid, pend.app, pend.next, "otp", pend.hub_sid))
    return {"ok": True}


@router.post("/totp/setup")
def totp_setup(request: Request, conn: ConnDep) -> dict:
    pend = _get_pending(request)
    if pend.stage != "totp_setup":
        raise HTTPException(400, detail={"code": "stage", "message": "Start signing in again."})
    row = conn.execute(select(totp_secret).where(totp_secret.c.person_id == pend.person_id)).mappings().first()
    secret = row["secret"] if row and not row["confirmed_at"] else pyotp.random_base32()
    if not row:
        conn.execute(totp_secret.insert().values(person_id=pend.person_id, secret=secret))
    elif row["secret"] != secret:
        conn.execute(update(totp_secret).where(totp_secret.c.person_id == pend.person_id).values(secret=secret))
    email = conn.execute(select(person.c.email).where(person.c.id == pend.person_id)).scalar()
    return {"secret": secret, "uri": pyotp.TOTP(secret).provisioning_uri(email, issuer_name="bide Comply")}


@router.post("/totp")
def totp_verify(body: CodeIn, request: Request, response: Response, conn: ConnDep) -> dict:
    pend = _get_pending(request)
    if pend.stage not in ("totp", "totp_setup"):
        raise HTTPException(400, detail={"code": "stage", "message": "Start signing in again."})
    restart = HTTPException(401, detail={"code": "no_pending", "message": "Start signing in again."})
    if not pend.challenge_id:
        raise restart
    now = clock.now()
    # Count the try before checking the code, in one statement, so parallel guesses can't get past the limit.
    tries = conn.execute(
        update(otp_challenge)
        .where(
            otp_challenge.c.id == pend.challenge_id,
            otp_challenge.c.person_id == pend.person_id,
            otp_challenge.c.purpose == "totp",
            otp_challenge.c.used_at.is_(None),
            otp_challenge.c.expires_at > now,
            otp_challenge.c.attempts < TOTP_ATTEMPTS,
        )
        .values(attempts=otp_challenge.c.attempts + 1)
        .returning(otp_challenge.c.attempts)
    ).scalar()
    if tries is None:
        raise restart
    row = conn.execute(select(totp_secret).where(totp_secret.c.person_id == pend.person_id)).mappings().first()
    step = _totp_step(row["secret"], body.code.strip()) if row else None
    # A code works once: the step it belongs to must be later than the last one used, so a code seen over someone's
    # shoulder (or replayed) can't be used again while it's still valid.
    fresh = (
        step is not None
        and conn.execute(
            update(totp_secret)
            .where(
                totp_secret.c.person_id == pend.person_id,
                or_(totp_secret.c.last_step.is_(None), totp_secret.c.last_step < step),
            )
            .values(last_step=step)
        ).rowcount
        == 1
    )
    if not fresh:
        left = TOTP_ATTEMPTS - tries
        if left <= 0:
            conn.execute(update(otp_challenge).where(otp_challenge.c.id == pend.challenge_id).values(used_at=now))
        # Commit the try (and a spent step) even though the request fails.
        conn.commit()
        if left <= 0:
            raise HTTPException(
                429, detail={"code": "locked", "message": "Too many wrong codes. Start signing in again."}
            )
        raise HTTPException(400, detail={"code": "wrong", "message": f"That code isn't right. {left} tries left."})
    conn.execute(update(otp_challenge).where(otp_challenge.c.id == pend.challenge_id).values(used_at=now))
    if not row["confirmed_at"]:
        conn.execute(
            update(totp_secret).where(totp_secret.c.person_id == pend.person_id).values(confirmed_at=clock.now())
        )
    p = dict(conn.execute(select(person).where(person.c.id == pend.person_id)).mappings().one())
    start_session(conn, response, p, pend.device_id, totp_ok=True, hub_sid=pend.hub_sid)
    audit.record(
        conn,
        audit.Actor(p["id"], p["name"], ratelimit.client_ip(request), _client_label(request, pend.app)),
        category="sign_in",
        action="sign_in",
        summary="Signed in (authenticator app confirmed)",
    )
    return {"next": pend.next}


class MagicIn(BaseModel):
    email: str
    app: str = "web"


MAGIC_DAYS = 7


def _magic_allowed(p) -> bool:
    """With Bide Hub on, staff sign in through the Hub, which can switch them off or refuse them Bide Comply; an emailed
    link would get round that. Outside people (kind external) have no Bide account and keep the link."""
    return not settings.bide_hub_on or p["kind"] == "external"


@router.post("/magic")
def magic_request(body: MagicIn, conn: ConnDep) -> dict:
    """Outside people sign in with an emailed link. The answer is the same whether or not the address is known, and
    whether or not a link was sent."""
    p = conn.execute(select(person).where(person.c.email == body.email.strip().lower())).mappings().first()
    if p and p["employment_status"] == "active" and _magic_allowed(p):
        # Each link works once: its challenge row is marked used when it's opened.
        cid, nonce = uuid.uuid4(), secrets.token_urlsafe(16)
        conn.execute(
            otp_challenge.insert().values(
                id=cid,
                person_id=p["id"],
                purpose="magic_link",
                code_hash=_h(f"{cid}:{nonce}"),
                expires_at=clock.now() + timedelta(days=MAGIC_DAYS),
            )
        )
        tok = _serializer("magic").dumps({"p": str(p["id"]), "a": body.app, "c": str(cid), "n": nonce})
        link = f"{settings.api_base_url}/api/auth/magic/{tok}"
        emailer.send(
            p["email"],
            "Your Bide Comply sign-in link",
            f"Open this link to sign in. It works once, within {MAGIC_DAYS} days.\n\n{link}",
        )
    return {"ok": True}


@router.get("/magic/{token}")
def magic_open(token: str, request: Request, conn: ConnDep) -> RedirectResponse:
    expired = RedirectResponse(f"{settings.web_base_url}/signin?error=link", status_code=302)
    try:
        d = _serializer("magic").loads(token, max_age=MAGIC_DAYS * 24 * 3600)
        pid, cid, nonce = uuid.UUID(d["p"]), uuid.UUID(d["c"]), str(d["n"])
    except (BadSignature, KeyError, ValueError):
        # Links sent before they became single-use have no challenge: ask for a new one.
        return expired
    p = conn.execute(select(person).where(person.c.id == pid)).mappings().first()
    if not p:
        return expired
    if p["employment_status"] != "active":
        return RedirectResponse(f"{settings.web_base_url}/signin?error=inactive", status_code=302)
    if not _magic_allowed(p):
        return RedirectResponse(f"{settings.web_base_url}/signin?error=staff", status_code=302)
    used = conn.execute(
        update(otp_challenge)
        .where(
            otp_challenge.c.id == cid,
            otp_challenge.c.person_id == pid,
            otp_challenge.c.purpose == "magic_link",
            otp_challenge.c.code_hash == _h(f"{cid}:{nonce}"),
            otp_challenge.c.used_at.is_(None),
            otp_challenge.c.expires_at > clock.now(),
        )
        .values(used_at=clock.now())
    )
    if used.rowcount != 1:
        return expired
    app = d["a"]
    resp = RedirectResponse(_app_base(app), status_code=302)
    result = establish(conn, request, resp, dict(p), app, "/", "email link")
    resp.headers["location"] = _app_base(app) + result["next"]
    return resp


class DevIn(BaseModel):
    person_id: uuid.UUID
    app: str = "web"


def _dev_allowed() -> None:
    if not settings.dev_login or settings.is_production:
        raise HTTPException(404, detail={"code": "not_found", "message": "Not found."})


@router.get("/dev/people")
def dev_people(conn: ConnDep) -> list[dict]:
    _dev_allowed()
    rows = conn.execute(
        select(person.c.id, person.c.name, person.c.title, person.c.kind)
        .where(person.c.employment_status == "active")
        .order_by(person.c.name)
    ).mappings()
    return [dict(r) for r in rows]


@router.post("/dev")
def dev_signin(body: DevIn, request: Request, response: Response, conn: ConnDep) -> dict:
    _dev_allowed()
    p = conn.execute(select(person).where(person.c.id == body.person_id)).mappings().first()
    if not p:
        raise HTTPException(404, detail={"code": "not_found", "message": "Not found."})
    return establish(conn, request, response, dict(p), body.app, "/", "development sign-in", trust_without_code=True)


class AdminPasswordIn(BaseModel):
    username: str
    password: str


# Wrong passwords from anywhere: after this many in an hour the password sign-in refuses everyone until the hour ends.
ADMIN_FAILURES = (10, 3600)
ADMIN_REFUSED = {"code": "wrong", "message": "That username or password isn't right."}


def _admin_login_on() -> bool:
    return bool(settings.admin_login_username and settings.admin_login_email and settings.admin_login_password_hash)


@router.get("/admin-password")
def admin_password_state() -> dict:
    return {"enabled": _admin_login_on()}


@router.post("/admin-password")
def admin_password(body: AdminPasswordIn, request: Request, response: Response, conn: ConnDep) -> dict:
    if not _admin_login_on():
        raise HTTPException(404, detail={"code": "not_found", "message": "Not found."})
    limit, window = ADMIN_FAILURES
    if ratelimit.count("admin-password-failures", window) >= limit:
        raise HTTPException(
            429,
            detail={
                "code": "locked",
                "message": "Password sign-in is paused after too many wrong tries. Try again in an hour.",
            },
        )
    user_ok = hmac.compare_digest(
        body.username.strip().lower().encode(), settings.admin_login_username.lower().encode()
    )
    # The hash is checked even for a wrong username, so the answer takes the same time either way.
    pw_ok = passwords.verify(body.password, settings.admin_login_password_hash)
    p = (
        conn.execute(select(person).where(person.c.email == settings.admin_login_email.strip().lower()))
        .mappings()
        .first()
    )
    ip = ratelimit.client_ip(request)
    if not (user_ok and pw_ok and p and "super_admin" in _roles(conn, p["id"])):
        ratelimit._hit("admin-password-failures", limit, window)
        audit.record(
            conn,
            audit.Actor(None, "Anonymous", ip, _client_label(request, "web")),
            category="sign_in",
            action="admin_password_failed",
            summary="Admin password sign-in refused",
        )
        conn.commit()
        raise HTTPException(400, detail=ADMIN_REFUSED)
    return establish(conn, request, response, dict(p), "web", "/", "admin password", trust_device=True)


@router.post("/refresh")
def refresh(request: Request, response: Response, conn: ConnDep) -> dict:
    raw = request.cookies.get(REFRESH_COOKIE)
    if not raw:
        raise HTTPException(401, detail={"code": "signed_out", "message": "Please sign in."})
    now = clock.now()
    h = _h(raw)
    s = conn.execute(select(auth_session).where(auth_session.c.refresh_hash == h)).mappings().first()
    if not s:
        reused = conn.execute(select(auth_session).where(auth_session.c.previous_refresh_hash == h)).mappings().first()
        if reused:
            # An old refresh token came back: it was copied. Sign that device out everywhere.
            conn.execute(
                update(auth_session).where(auth_session.c.device_id == reused["device_id"]).values(revoked_at=now)
            )
            conn.execute(update(device).where(device.c.id == reused["device_id"]).values(revoked_at=now))
            audit.record(
                conn,
                audit.SYSTEM,
                category="sign_in",
                action="refresh_reuse",
                summary="Refresh token reused; device signed out",
                entity_type="device",
                entity_id=reused["device_id"],
            )
            conn.commit()
        raise HTTPException(401, detail={"code": "signed_out", "message": "Please sign in."})
    if s["revoked_at"] or s["expires_at"] < now:
        raise HTTPException(401, detail={"code": "signed_out", "message": "Please sign in."})
    if s["idle_expires_at"] and s["idle_expires_at"] < now:
        conn.execute(update(auth_session).where(auth_session.c.id == s["id"]).values(revoked_at=now))
        conn.commit()
        raise HTTPException(401, detail={"code": "idle", "message": "Signed out after 30 minutes without activity."})
    d = conn.execute(select(device).where(device.c.id == s["device_id"])).mappings().first()
    if not d or d["revoked_at"]:
        raise HTTPException(401, detail={"code": "signed_out", "message": "Please sign in."})
    p = conn.execute(select(person).where(person.c.id == s["person_id"])).mappings().one()
    if p["employment_status"] != "active":
        raise HTTPException(401, detail={"code": "signed_out", "message": "Please sign in."})
    new_raw = secrets.token_urlsafe(48)
    vals: dict = {"refresh_hash": _h(new_raw), "previous_refresh_hash": h, "last_used_at": now}
    if s["idle_expires_at"]:
        vals["idle_expires_at"] = now + timedelta(minutes=settings.admin_idle_minutes)
    conn.execute(update(auth_session).where(auth_session.c.id == s["id"]).values(**vals))
    _set_access(response, s["id"], s["person_id"])
    remaining = int((s["expires_at"] - now).total_seconds())
    _cookie(response, REFRESH_COOKIE, new_raw, remaining, path="/api/auth")
    return {"ok": True}


@router.post("/logout")
def logout(request: Request, response: Response, conn: ConnDep) -> dict:
    raw = request.cookies.get(REFRESH_COOKIE)
    hub_sid = None
    if raw:
        hub_sid = conn.execute(
            update(auth_session)
            .where(auth_session.c.refresh_hash == _h(raw))
            .values(revoked_at=clock.now())
            .returning(auth_session.c.hub_sid)
        ).scalar()
    _drop_cookie(response, ACCESS_COOKIE, "/")
    _drop_cookie(response, REFRESH_COOKIE, "/api/auth")
    if settings.bide_hub_on and hub_sid:
        # Signed in through Bide Hub: the browser goes on to end the Hub session too, which signs out every system.
        app = request.headers.get("x-bide-app", "web")
        return {"ok": True, "redirect": hub.logout_url(f"{_app_base(app)}/")}
    return {"ok": True}


def revoke_person(conn: Connection, person_id: uuid.UUID) -> None:
    """Offboarding: every session and device ends now (§9.2)."""
    now = clock.now()
    conn.execute(
        update(auth_session)
        .where(auth_session.c.person_id == person_id, auth_session.c.revoked_at.is_(None))
        .values(revoked_at=now)
    )
    conn.execute(
        update(device).where(device.c.person_id == person_id, device.c.revoked_at.is_(None)).values(revoked_at=now)
    )


def revoke_device(conn: Connection, device_id: uuid.UUID) -> None:
    now = clock.now()
    conn.execute(update(auth_session).where(auth_session.c.device_id == device_id).values(revoked_at=now))
    conn.execute(update(device).where(device.c.id == device_id).values(revoked_at=now))
