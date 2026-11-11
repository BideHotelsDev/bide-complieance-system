"""The app side of Sign in with Bide (bide-hub docs/integrating.md), in one place.

    hub = HubClient(issuer, client_id, client_secret)

    # GET /api/auth/bide/login
    url, pending = hub.start_login(redirect_uri, next_path)
    session["bide_hub"] = pending.to_dict();  redirect(url)

    # GET /api/auth/bide/callback
    identity = hub.finish_login(PendingLogin.from_dict(session.pop("bide_hub", None)), redirect_uri, state, code, error)
    ... find the app's user by identity.sub, else by identity.email (only set when verified) ...

    # POST /api/auth/bide/backchannel-logout
    logout = hub.verify_logout_token(form["logout_token"])   # 400 on InvalidToken
    ... end sessions for logout.sid, or for logout.sub up to logout.logout_at ...
    ... logout.disabled: switch the app's own account off too ...

What stays in the app: its users, its sessions, its sign-in rules. The client never touches a database or a request.
"""

import base64
import hashlib
import hmac
import secrets
import threading
import time
from collections.abc import Callable
from datetime import UTC, datetime
from typing import Any
from urllib.parse import urlencode, urlsplit

import httpx
import jwt

from .errors import HubDenied, HubUnavailable, InvalidToken, StateMismatch
from .models import Identity, Logout, PendingLogin, ProvisioningRequest

BACKCHANNEL_EVENT = "http://schemas.openid.net/event/backchannel-logout"
ACCOUNT_DISABLED_EVENT = "urn:bide:hub:account-disabled"
PROVISIONING_PURPOSE = "bide-hub-provisioning"
PROVISIONING_MAX_SECONDS = 120
# A logout token's media type (Back-Channel Logout 1.0 §2.4). When the `typ` header is present it must be one of these,
# so no other JWT the Hub signs (an ID token is "JWT") can pass for a logout.
LOGOUT_TYP = frozenset({"logout+jwt", "application/logout+jwt"})
ALGORITHMS = ["RS256"]  # the Hub signs with RS256 only; refusing anything else rules out algorithm confusion


def same(a: str, b: str) -> bool:
    """Constant-time string equality that copes with any input (secrets.compare_digest raises on non-ASCII str)."""
    return hmac.compare_digest(a.encode(), b.encode())


def pkce_challenge(verifier: str) -> str:
    return base64.urlsafe_b64encode(hashlib.sha256(verifier.encode()).digest()).rstrip(b"=").decode()


def safe_next(path: str | None, default: str = "/") -> str:
    """A same-site path to return to after sign-in: starts with one "/", no scheme or host, no backslash tricks."""
    if not path or not path.startswith("/") or path.startswith("//") or "\\" in path:
        return default
    parts = urlsplit(path)
    if parts.scheme or parts.netloc:
        return default
    return path


class HubClient:
    """One per app process. Thread-safe; caches the Hub's discovery document and keys.

    `http` is the httpx.Client used for every call (tests pass one with a MockTransport, see testing.FakeHub). `now`
    is the clock for `logout_at` capping and key-refresh pacing.
    """

    def __init__(
        self,
        issuer: str,
        client_id: str,
        client_secret: str = "",
        *,
        http: httpx.Client | None = None,
        timeout: float = 10.0,
        discovery_ttl: float = 3600.0,
        jwks_ttl: float = 3600.0,
        refresh_interval: float = 60.0,
        leeway: int = 30,
        now: Callable[[], float] = time.time,
    ) -> None:
        self.issuer = issuer.rstrip("/")
        self.client_id = client_id
        self.client_secret = client_secret
        self._http = http
        self._timeout = timeout
        self._discovery_ttl = discovery_ttl
        self._jwks_ttl = jwks_ttl
        self._refresh_interval = refresh_interval
        self.leeway = leeway
        self._now = now
        self._lock = threading.Lock()
        self._discovery: tuple[float, dict[str, Any]] | None = None
        self._jwks: tuple[float, dict[str, Any]] | None = None
        self._last_forced_refresh = float("-inf")

    @property
    def configured(self) -> bool:
        """Sign in with Bide is on when issuer, client ID and client secret are all set (integrating.md §2)."""
        return bool(self.issuer and self.client_id and self.client_secret)

    # --- network ---------------------------------------------------------------------------------------------------

    def _client(self) -> httpx.Client:
        if self._http is None:
            self._http = httpx.Client(timeout=self._timeout)
        return self._http

    def _get_json(self, url: str) -> dict[str, Any]:
        try:
            response = self._client().get(url)
            response.raise_for_status()
            data = response.json()
        except (httpx.HTTPError, ValueError) as exc:
            raise HubUnavailable(f"Bide Hub didn't answer {url}: {exc}") from exc
        if not isinstance(data, dict):
            raise HubUnavailable(f"Bide Hub answered {url} with something that isn't a JSON object")
        return data

    def discovery(self) -> dict[str, Any]:
        """The Hub's OpenID configuration, cached for `discovery_ttl` seconds."""
        with self._lock:
            hit = self._discovery
        if hit and self._now() - hit[0] < self._discovery_ttl:
            return hit[1]
        doc = self._get_json(f"{self.issuer}/.well-known/openid-configuration")
        if doc.get("issuer") not in (None, self.issuer):
            raise HubUnavailable(f"Bide Hub's discovery names another issuer: {doc.get('issuer')}")
        with self._lock:
            self._discovery = (self._now(), doc)
        return doc

    def _endpoint(self, name: str, fallback: str) -> str:
        value = self.discovery().get(name)
        return value if isinstance(value, str) and value else f"{self.issuer}{fallback}"

    def _keys(self, force: bool = False) -> dict[str, Any]:
        with self._lock:
            hit = self._jwks
        if hit and not force and self._now() - hit[0] < self._jwks_ttl:
            return hit[1]
        keys = self._get_json(self._endpoint("jwks_uri", "/oauth/jwks"))
        with self._lock:
            self._jwks = (self._now(), keys)
        return keys

    def _signing_key(self, token: str) -> Any:
        """The Hub key that signed this token. A key id the cached set doesn't know means the Hub rotated its key: the
        set is fetched again, at most once per `refresh_interval`, so tokens anyone can post (back-channel logout)
        can't make the app hammer the Hub."""
        try:
            header = jwt.get_unverified_header(token)
        except jwt.PyJWTError as exc:
            raise InvalidToken(f"not a JWT: {exc}") from exc
        if header.get("alg") not in ALGORITHMS:
            raise InvalidToken(f"unexpected algorithm {header.get('alg')!r}")
        kid = header.get("kid")

        def find(keyset: dict[str, Any]) -> Any:
            entries = [k for k in keyset.get("keys", []) if isinstance(k, dict)]
            if kid is None and len(entries) == 1:
                match = entries[0]
            else:
                match = next((k for k in entries if k.get("kid") == kid), None)
            if match is None:
                return None
            try:
                return jwt.PyJWK(match, algorithm="RS256").key
            except jwt.PyJWTError as exc:
                raise InvalidToken(f"the Hub's key {kid!r} can't be used: {exc}") from exc

        key = find(self._keys())
        if key is None:
            with self._lock:
                may_refresh = self._now() - self._last_forced_refresh >= self._refresh_interval
                if may_refresh:
                    self._last_forced_refresh = self._now()
            if may_refresh:
                key = find(self._keys(force=True))
        if key is None:
            raise InvalidToken(f"signed with a key the Hub doesn't publish ({kid!r})")
        return key

    # --- tokens ----------------------------------------------------------------------------------------------------

    def _decode(self, token: str, audience: str, required: list[str]) -> dict[str, Any]:
        if not isinstance(token, str) or not token:
            raise InvalidToken("no token")
        try:
            claims = jwt.decode(
                token,
                self._signing_key(token),
                algorithms=ALGORITHMS,
                audience=audience,
                issuer=self.issuer,
                leeway=self.leeway,
                options={"require": ["iss", "aud", "exp", "iat", *required]},
            )
        except jwt.PyJWTError as exc:
            raise InvalidToken(str(exc)) from exc
        if not isinstance(claims, dict):
            raise InvalidToken("claims aren't an object")
        return claims

    def verify_id_token(self, token: str, nonce: str) -> Identity:
        """RS256 signature, iss, aud, exp, iat, the nonce this sign-in started with, and a `sid` (without it a Hub
        sign-out could never end the app's session)."""
        claims = self._decode(token, self.client_id, ["sub", "sid"])
        if "events" in claims or "purpose" in claims:
            raise InvalidToken("a logout or provisioning token, not an ID token")
        if not same(str(claims.get("nonce", "")), nonce):
            raise InvalidToken("nonce doesn't match this sign-in")
        if claims.get("azp") not in (None, self.client_id):
            raise InvalidToken("issued to another app (azp)")
        raw_email = claims.get("email")
        raw_email = raw_email.strip() if isinstance(raw_email, str) and raw_email.strip() else None
        amr = claims.get("amr")
        auth_time = claims.get("auth_time")
        return Identity(
            sub=str(claims["sub"]),
            sid=str(claims["sid"]),
            email=raw_email.lower() if raw_email and claims.get("email_verified") is True else None,
            raw_email=raw_email,
            name=claims.get("name") if isinstance(claims.get("name"), str) else None,
            picture=claims.get("picture") if isinstance(claims.get("picture"), str) else None,
            amr=tuple(str(a) for a in amr) if isinstance(amr, list) else (),
            auth_time=auth_time if isinstance(auth_time, int) else None,
            claims=claims,
        )

    def verify_logout_token(self, token: str) -> Logout:
        """OIDC Back-Channel Logout 1.0 plus the Bide extensions: the logout event, no nonce, a `sub`; `logout_at` (when
        it really happened) and the account-disabled event. Raises InvalidToken; answer 400 then."""
        claims = self._decode(token, self.client_id, ["sub"])
        typ = jwt.get_unverified_header(token).get("typ")  # the signature has been checked by now
        if typ is not None and str(typ).lower() not in LOGOUT_TYP:
            raise InvalidToken(f"not a logout token (typ {typ!r})")
        events = claims.get("events")
        if not isinstance(events, dict) or BACKCHANNEL_EVENT not in events:
            raise InvalidToken("not a logout token (no back-channel logout event)")
        if "nonce" in claims or "purpose" in claims:
            raise InvalidToken("a logout token never has a nonce or a purpose")
        sid = claims.get("sid")
        return Logout(
            sub=str(claims["sub"]),
            sid=str(sid) if sid else None,
            logout_at=self._logout_time(claims),
            disabled=ACCOUNT_DISABLED_EVENT in events,
            claims=claims,
        )

    def _logout_time(self, claims: dict[str, Any]) -> datetime:
        """`logout_at`, never later than now. Without it (a Hub from before it was added), the arrival time: not `iat`,
        which is whole seconds and would put a logout before a session started earlier in that same second."""
        now = self._now()
        raw = claims.get("logout_at")
        at = raw if isinstance(raw, int | float) and not isinstance(raw, bool) else now
        return datetime.fromtimestamp(min(float(at), now), UTC)

    def verify_provisioning_request(
        self, authorization: str | None, method: str, url: str, body: bytes
    ) -> ProvisioningRequest:
        """A call from the Hub to the app's provisioning endpoints (integrating.md §4b). `url` is the full address being
        served, built from the app's own configured public address, never from the request's Host header."""
        scheme, _, token = (authorization or "").partition(" ")
        if scheme.lower() != "bearer" or not token:
            raise InvalidToken("no bearer token")
        claims = self._decode(token, self.client_id, ["purpose", "htm", "htu", "body_sha256"])
        if claims.get("purpose") != PROVISIONING_PURPOSE:
            raise InvalidToken("not a provisioning token")
        if not 0 < claims["exp"] - claims["iat"] <= PROVISIONING_MAX_SECONDS:
            raise InvalidToken("provisioning token lives too long")
        if not same(str(claims["htm"]).upper(), method.upper()):
            raise InvalidToken("provisioning token is for another method")
        if not same(str(claims["htu"]), url):
            raise InvalidToken("provisioning token is for another address")
        if not same(str(claims["body_sha256"]), hashlib.sha256(body).hexdigest()):
            raise InvalidToken("provisioning token is for another body")
        return ProvisioningRequest(claims=claims)

    # --- the sign-in flow ------------------------------------------------------------------------------------------

    def start_login(
        self,
        redirect_uri: str,
        next_path: str | None = "/",
        *,
        prompt: str | None = None,
        login_hint: str | None = None,
    ) -> tuple[str, PendingLogin]:
        """The Hub authorize URL to redirect to, and what to keep until the callback. Raises HubUnavailable."""
        pending = PendingLogin(
            state=secrets.token_urlsafe(32),
            nonce=secrets.token_urlsafe(32),
            verifier=secrets.token_urlsafe(48),
            next=safe_next(next_path),
        )
        params = {
            "response_type": "code",
            "client_id": self.client_id,
            "redirect_uri": redirect_uri,
            "scope": "openid email profile",
            "state": pending.state,
            "nonce": pending.nonce,
            "code_challenge": pkce_challenge(pending.verifier),
            "code_challenge_method": "S256",
        }
        if prompt:
            params["prompt"] = prompt
        if login_hint:
            params["login_hint"] = login_hint
        return f"{self._endpoint('authorization_endpoint', '/oauth/authorize')}?{urlencode(params)}", pending

    def finish_login(
        self,
        pending: PendingLogin | None,
        redirect_uri: str,
        state: str | None,
        code: str | None,
        error: str | None = None,
    ) -> Identity:
        """Check the callback against what /login kept, redeem the code (with PKCE) and verify the ID token.

        Raises StateMismatch, HubDenied (the Hub said no; `.no_access` for "you can't open this app"), HubUnavailable
        or InvalidToken. The state is checked first, so a forged callback can't even show an error message."""
        if pending is None or not state or not same(state, pending.state):
            raise StateMismatch("this sign-in wasn't started here, or has expired")
        if error:
            raise HubDenied(error)
        if not code:
            raise StateMismatch("no code")
        try:
            response = self._client().post(
                self._endpoint("token_endpoint", "/oauth/token"),
                auth=(self.client_id, self.client_secret),
                data={
                    "grant_type": "authorization_code",
                    "code": code,
                    "redirect_uri": redirect_uri,
                    "code_verifier": pending.verifier,
                },
            )
            body = response.json() if response.content else {}
        except (httpx.HTTPError, ValueError) as exc:
            raise HubUnavailable(f"Bide Hub token exchange failed: {exc}") from exc
        if response.is_error or not isinstance(body, dict) or not isinstance(body.get("id_token"), str):
            detail = body.get("error") if isinstance(body, dict) else None
            raise HubUnavailable(f"Bide Hub refused the code: {detail or response.status_code}")
        return self.verify_id_token(body["id_token"], pending.nonce)

    def logout_url(self, post_logout_redirect_uri: str | None = None) -> str:
        """Where to send the browser after clearing the app's session: ends the Hub session and every other app's.
        Built from the issuer, so signing out never waits on the Hub."""
        params = {"client_id": self.client_id}
        if post_logout_redirect_uri:
            params["post_logout_redirect_uri"] = post_logout_redirect_uri
        return f"{self.issuer}/oauth/logout?{urlencode(params)}"
