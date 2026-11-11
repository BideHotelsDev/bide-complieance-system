"""A fake Bide Hub for an app's tests: its own RSA key, discovery, JWKS and token endpoint, served through an
httpx.MockTransport, plus helpers that sign the tokens a real Hub would send.

    hub = FakeHub(client_id="meeting-followup")
    client = hub.client()              # a HubClient wired to the fake; give it to the app under test
    hub.person = {"sub": "p-1", "email": "kyle@bidehotels.com", "sid": "s-1"}
    url = app.get("/api/auth/bide/login").headers["location"]
    app.get("/api/auth/bide/callback", params=hub.authorize(url))       # the Hub's answer: code + state
    app.post("/api/auth/bide/backchannel-logout", data={"logout_token": hub.logout_token(sid="s-1")})

Imports cryptography, which PyJWT's RS256 already needs.
"""

import base64
import hashlib
import json
import secrets
import time
from typing import Any
from urllib.parse import parse_qs, urlsplit

import httpx
import jwt
from cryptography.hazmat.primitives.asymmetric import rsa

from .client import ACCOUNT_DISABLED_EVENT, BACKCHANNEL_EVENT, PROVISIONING_PURPOSE, HubClient, pkce_challenge


def new_key() -> rsa.RSAPrivateKey:
    return rsa.generate_private_key(public_exponent=65537, key_size=2048)


class FakeHub:
    def __init__(
        self,
        issuer: str = "https://hub.test",
        client_id: str = "test-app",
        client_secret: str = "dev-secret-test-app",
        key: rsa.RSAPrivateKey | None = None,
        kid: str = "hub-key-1",
    ) -> None:
        self.issuer = issuer.rstrip("/")
        self.client_id = client_id
        self.client_secret = client_secret
        self.key = key or new_key()
        self.kid = kid
        # Who signs in at the Hub next. Anything here goes into the ID token (it may override the defaults).
        self.person: dict[str, Any] = {"sub": "hub-person-1", "email": "someone@bidehotels.com", "sid": "hub-sid-1"}
        # Extra or overriding claims for the next ID token only, e.g. {"aud": "another-app"} to test refusals.
        self.tamper: dict[str, Any] = {}
        self.requests: list[httpx.Request] = []
        self.token_error: str | None = None  # make the token endpoint refuse, e.g. "invalid_grant"
        self._codes: dict[str, dict[str, str]] = {}

    # --- what the Hub publishes ------------------------------------------------------------------------------------

    def jwk(self, key: rsa.RSAPrivateKey | None = None, kid: str | None = None) -> dict[str, Any]:
        public = json.loads(jwt.algorithms.RSAAlgorithm.to_jwk((key or self.key).public_key()))
        return public | {"kid": kid or self.kid, "use": "sig", "alg": "RS256"}

    def jwks(self) -> dict[str, Any]:
        return {"keys": [self.jwk()]}

    def discovery(self) -> dict[str, Any]:
        iss = self.issuer
        return {
            "issuer": iss,
            "authorization_endpoint": f"{iss}/oauth/authorize",
            "token_endpoint": f"{iss}/oauth/token",
            "userinfo_endpoint": f"{iss}/oauth/userinfo",
            "jwks_uri": f"{iss}/oauth/jwks",
            "end_session_endpoint": f"{iss}/oauth/logout",
        }

    def rotate(self, kid: str = "hub-key-2") -> None:
        """Switch to a new signing key, as the Hub would after a rotation."""
        self.key, self.kid = new_key(), kid

    # --- transport -------------------------------------------------------------------------------------------------

    def handler(self, request: httpx.Request) -> httpx.Response:
        self.requests.append(request)
        path = request.url.path
        if path == "/.well-known/openid-configuration":
            return httpx.Response(200, json=self.discovery())
        if path == "/oauth/jwks":
            return httpx.Response(200, json=self.jwks())
        if path == "/oauth/token" and request.method == "POST":
            return self._token(request)
        return httpx.Response(404, json={"detail": "Not Found"})

    def transport(self) -> httpx.MockTransport:
        return httpx.MockTransport(self.handler)

    def client(self, **kwargs: Any) -> HubClient:
        """A HubClient that talks to this fake."""
        return HubClient(
            self.issuer, self.client_id, self.client_secret, http=httpx.Client(transport=self.transport()), **kwargs
        )

    def fetches(self, path: str) -> int:
        """How many times the app fetched this path, e.g. "/oauth/jwks"."""
        return sum(1 for r in self.requests if r.url.path == path)

    # --- the sign-in flow ------------------------------------------------------------------------------------------

    def authorize(self, authorize_url: str) -> dict[str, str]:
        """Play the Hub's authorize page for the person in `self.person`: returns the callback's query parameters."""
        q = {k: v[0] for k, v in parse_qs(urlsplit(authorize_url).query).items()}
        assert q.get("client_id") == self.client_id, "authorize for another client"
        assert q.get("code_challenge_method") == "S256" and q.get("code_challenge"), "PKCE (S256) is required"
        code = secrets.token_urlsafe(16)
        self._codes[code] = {
            "nonce": q.get("nonce", ""),
            "challenge": q["code_challenge"],
            "redirect": q["redirect_uri"],
        }
        return {"code": code, "state": q.get("state", "")}

    def _token(self, request: httpx.Request) -> httpx.Response:
        form = {k: v[0] for k, v in parse_qs(request.content.decode()).items()}
        basic = base64.b64encode(f"{self.client_id}:{self.client_secret}".encode()).decode()
        if request.headers.get("authorization") != f"Basic {basic}":
            return httpx.Response(401, json={"error": "invalid_client"})
        if self.token_error:
            return httpx.Response(400, json={"error": self.token_error})
        issued = self._codes.pop(form.get("code", ""), None)
        if (
            issued is None
            or form.get("grant_type") != "authorization_code"
            or form.get("redirect_uri") != issued["redirect"]
            or pkce_challenge(form.get("code_verifier", "")) != issued["challenge"]
        ):
            return httpx.Response(400, json={"error": "invalid_grant"})
        return httpx.Response(
            200, json={"id_token": self.id_token(nonce=issued["nonce"]), "access_token": "at", "token_type": "Bearer"}
        )

    # --- tokens ----------------------------------------------------------------------------------------------------

    def sign(self, claims: dict[str, Any], key: rsa.RSAPrivateKey | None = None, headers: dict | None = None) -> str:
        """Sign claims as the Hub; a claim set to None is left out (to test a missing claim)."""
        body = {k: v for k, v in claims.items() if v is not None}
        return jwt.encode(body, key or self.key, algorithm="RS256", headers={"kid": self.kid, **(headers or {})})

    def id_token(self, nonce: str = "", **claims: Any) -> str:
        now = int(time.time())
        base = {
            "iss": self.issuer,
            "aud": self.client_id,
            "azp": self.client_id,
            "iat": now,
            "exp": now + 300,
            "auth_time": now,
            "amr": ["google"],
            "nonce": nonce,
            "email_verified": True,
            "name": "Someone",
        }
        return self.sign(base | self.person | self.tamper | claims)

    def logout_token(self, sid: str | None = None, sub: Any = ..., *, disabled: bool = False, **claims: Any) -> str:
        """A back-channel logout token for the person in `self.person` (or `sub`; None leaves it out). No sid: every
        session of the person.
        `logout_at` may be passed as a claim (seconds since 1970)."""
        now = int(time.time())
        events = {BACKCHANNEL_EVENT: {}, ACCOUNT_DISABLED_EVENT: {}} if disabled else {BACKCHANNEL_EVENT: {}}
        base = {
            "iss": self.issuer,
            "aud": self.client_id,
            "iat": now,
            "exp": now + 120,
            "jti": secrets.token_urlsafe(8),
            "sub": self.person["sub"] if sub is ... else sub,
            "sid": sid,
            "events": events,
        }
        return self.sign(base | claims, headers={"typ": "logout+jwt"})

    def provisioning_token(self, method: str, url: str, body: bytes = b"", **claims: Any) -> str:
        now = int(time.time())
        base = {
            "iss": self.issuer,
            "aud": self.client_id,
            "iat": now,
            "exp": now + 60,
            "jti": secrets.token_urlsafe(8),
            "purpose": PROVISIONING_PURPOSE,
            "htm": method,
            "htu": url,
            "body_sha256": hashlib.sha256(body).hexdigest(),
        }
        return self.sign(base | claims)
