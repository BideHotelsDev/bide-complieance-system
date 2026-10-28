"""Sign-in, device trust and sessions (PRD §8, §9.2).

- Staff: Google Workspace OIDC with Authorization Code + PKCE; iss, aud, exp and the hd claim are checked here.
- Outside people (assessor, SPV directors without a bide account, contractors): an emailed magic link, 8-hour sessions.
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
import uuid
from dataclasses import dataclass
from datetime import timedelta
from typing import Annotated
from urllib.parse import urlencode

import httpx
import pyotp
from fastapi import APIRouter, Depends, HTTPException, Request, Response
from fastapi.responses import RedirectResponse
from itsdangerous import BadSignature, SignatureExpired, URLSafeTimedSerializer
from pydantic import BaseModel
from sqlalchemy import Connection, select, update

from bide_comply import audit, clock, emailer
from bide_comply.authz import STRONG_AUTH_ROLES, Principal, load_principal
from bide_comply.config import settings
from bide_comply.db import ConnDep
from bide_comply.schema import auth_session, device, otp_challenge, person, role_assignment, totp_secret

ACCESS_COOKIE = "bc_access"
REFRESH_COOKIE = "bc_refresh"
DEVICE_COOKIE = "bc_device"
PENDING_COOKIE = "bc_pending"
PKCE_COOKIE = "bc_pkce"

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
    ip = request.client.host if request.client else None
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


def start_session(conn: Connection, response: Response, p: dict, device_id: uuid.UUID, totp_ok: bool = False) -> None:
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
        f"Your bide Comply code: {code}",
        f"Your code is {code}. It works for {settings.otp_minutes} minutes.\n\n"
        "You're seeing this because someone signed in to bide Comply on a new device. If it wasn't you, tell "
        "Samantha straight away.",
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


def _set_pending(response: Response, pend: Pending) -> None:
    tok = _serializer("pending").dumps(
        {
            "p": str(pend.person_id),
            "d": str(pend.device_id),
            "c": str(pend.challenge_id) if pend.challenge_id else None,
            "a": pend.app,
            "n": pend.next,
            "s": pend.stage,
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
    return Pending(uuid.UUID(d["p"]), uuid.UUID(d["d"]), uuid.UUID(d["c"]) if d["c"] else None, d["a"], d["n"], d["s"])


def establish(
    conn: Connection,
    request: Request,
    response: Response,
    p: dict,
    app: str,
    next_: str,
    via: str,
    trust_without_code: bool = False,
) -> dict:
    """After Google, a magic link or dev sign-in: start a session, or ask for the device code first."""
    if p["employment_status"] != "active":
        raise HTTPException(403, detail={"code": "inactive", "message": "This account no longer has access."})
    label = _client_label(request, app)
    d = _find_or_create_device(conn, p["id"], _device_token(request, response), label, app)
    if d["revoked_at"]:
        # A revoked device can be trusted again, but only through a fresh code.
        conn.execute(update(device).where(device.c.id == d["id"]).values(revoked_at=None, trusted_at=None))
        d["trusted_at"] = None
        d["revoked_at"] = None
    actor = audit.Actor(p["id"], p["name"], request.client.host if request.client else None, label)
    if trust_without_code:
        conn.execute(
            update(device)
            .where(device.c.id == d["id"])
            .values(trusted_at=clock.now(), trusted_until=clock.now() + timedelta(days=settings.device_trust_days))
        )
        start_session(conn, response, p, d["id"], totp_ok=True)
        audit.record(conn, actor, category="sign_in", action="sign_in", summary=f"Signed in ({via})")
        return {"next": next_}
    if _device_trusted(d):
        strong = bool(_roles(conn, p["id"]) & STRONG_AUTH_ROLES)
        if strong:
            # Admin roles confirm with the authenticator app on every sign-in, not only on a new device.
            stage = "totp" if _totp_confirmed(conn, p["id"]) else "totp_setup"
            _set_pending(response, Pending(p["id"], d["id"], None, app, next_, stage))
            return {"next": f"/signin/{stage.replace('_', '-')}"}
        start_session(conn, response, p, d["id"])
        audit.record(conn, actor, category="sign_in", action="sign_in", summary=f"Signed in ({via})")
        return {"next": next_}
    cid = _send_otp(conn, p, d["id"])
    _set_pending(response, Pending(p["id"], d["id"], cid, app, next_, "otp"))
    return {"next": "/signin/code"}


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
        raise HTTPException(403, detail={"code": "domain", "message": "Use your bide Google account."})
    return dict(claims)


@router.get("/google/callback")
def google_callback(request: Request, conn: ConnDep, code: str, state: str) -> RedirectResponse:
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
            403, detail={"code": "unknown", "message": "You're not set up in bide Comply yet. Ask Samantha."}
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


class CodeIn(BaseModel):
    code: str
    trust: bool = True


@router.get("/pending")
def pending_state(request: Request, conn: ConnDep) -> dict:
    pend = _get_pending(request)
    p = conn.execute(select(person.c.name, person.c.email).where(person.c.id == pend.person_id)).first()
    email = p.email or ""
    local, _, dom = email.partition("@")
    return {"stage": pend.stage, "name": p.name, "email_masked": f"{local[:2]}…@{dom}", "app": pend.app}


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
        _set_pending(response, Pending(pend.person_id, pend.device_id, None, pend.app, pend.next, stage))
        return {"next": f"/signin/{stage.replace('_', '-')}"}
    start_session(conn, response, p, pend.device_id)
    audit.record(
        conn,
        audit.Actor(
            p["id"], p["name"], request.client.host if request.client else None, _client_label(request, pend.app)
        ),
        category="sign_in",
        action="new_device",
        summary="Signed in on a new device (email code confirmed)",
    )
    return {"next": pend.next}


@router.post("/code/resend")
def resend_code(request: Request, response: Response, conn: ConnDep) -> dict:
    pend = _get_pending(request)
    p = dict(conn.execute(select(person).where(person.c.id == pend.person_id)).mappings().one())
    cid = _send_otp(conn, p, pend.device_id)
    _set_pending(response, Pending(pend.person_id, pend.device_id, cid, pend.app, pend.next, "otp"))
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
    row = conn.execute(select(totp_secret).where(totp_secret.c.person_id == pend.person_id)).mappings().first()
    if not row or not pyotp.TOTP(row["secret"]).verify(body.code.strip(), valid_window=1):
        raise HTTPException(400, detail={"code": "wrong", "message": "That code isn't right."})
    if not row["confirmed_at"]:
        conn.execute(
            update(totp_secret).where(totp_secret.c.person_id == pend.person_id).values(confirmed_at=clock.now())
        )
    p = dict(conn.execute(select(person).where(person.c.id == pend.person_id)).mappings().one())
    start_session(conn, response, p, pend.device_id, totp_ok=True)
    audit.record(
        conn,
        audit.Actor(
            p["id"], p["name"], request.client.host if request.client else None, _client_label(request, pend.app)
        ),
        category="sign_in",
        action="sign_in",
        summary="Signed in (authenticator app confirmed)",
    )
    return {"next": pend.next}


class MagicIn(BaseModel):
    email: str
    app: str = "web"


@router.post("/magic")
def magic_request(body: MagicIn, conn: ConnDep) -> dict:
    """Outside people sign in with an emailed link. The answer is the same whether or not the address is known."""
    p = conn.execute(select(person).where(person.c.email == body.email.strip().lower())).mappings().first()
    if p and p["employment_status"] == "active":
        tok = _serializer("magic").dumps({"p": str(p["id"]), "a": body.app})
        link = f"{settings.api_base_url}/api/auth/magic/{tok}"
        emailer.send(
            p["email"],
            "Your bide Comply sign-in link",
            f"Open this link to sign in. It works for 7 days and only on the device you open it on first.\n\n{link}",
        )
    return {"ok": True}


@router.get("/magic/{token}")
def magic_open(token: str, request: Request, conn: ConnDep) -> RedirectResponse:
    try:
        d = _serializer("magic").loads(token, max_age=7 * 24 * 3600)
    except BadSignature:
        return RedirectResponse(f"{settings.web_base_url}/signin?error=link", status_code=302)
    p = conn.execute(select(person).where(person.c.id == uuid.UUID(d["p"]))).mappings().first()
    if not p:
        return RedirectResponse(f"{settings.web_base_url}/signin?error=link", status_code=302)
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
    if raw:
        conn.execute(update(auth_session).where(auth_session.c.refresh_hash == _h(raw)).values(revoked_at=clock.now()))
    _drop_cookie(response, ACCESS_COOKIE, "/")
    _drop_cookie(response, REFRESH_COOKIE, "/api/auth")
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
