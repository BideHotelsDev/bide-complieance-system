"""Bide Hub, the group's single sign-on (an OpenID Connect provider; contract in bide-hub/docs/integrating.md).

On when BIDE_HUB_ISSUER, BIDE_HUB_CLIENT_ID and BIDE_HUB_CLIENT_SECRET are all set. The Hub answers who someone is
and whether they may open bide Comply; everything after that (device code, authenticator app, roles, sessions) stays
in auth.py. This module only talks to the Hub: discovery, token exchange and checking the tokens it signs.
"""

import base64
import hmac
import json
import time
from collections.abc import Callable
from typing import Any
from urllib.parse import urlencode

import httpx
from authlib.jose import JsonWebKey, JsonWebToken
from authlib.jose.errors import JoseError

from bide_comply.config import settings

BACKCHANNEL_EVENT = "http://schemas.openid.net/event/backchannel-logout"
# Sent with the logout event when a Hub Admin switches someone off (integrating.md §3).
ACCOUNT_DISABLED_EVENT = "urn:bide:hub:account-disabled"
# The Hub signs with RS256 only; refusing every other algorithm rules out alg-confusion tricks.
_jwt = JsonWebToken(["RS256"])
_CACHE_SECONDS = 3600
_cache: dict[str, tuple[float, Any]] = {}
_REFRESH_SECONDS = 60
_jwks_refreshed_at = [float("-inf")]  # when an unknown key id last made us fetch the JWKS again


class HubError(Exception):
    """The Hub couldn't be reached, or a token it sent didn't check out."""


def issuer() -> str:
    return settings.bide_hub_issuer.rstrip("/")


def _cached(key: str, fetch: Callable[[], Any], fresh: bool = False) -> Any:
    hit = _cache.get(key)
    if hit and not fresh and time.monotonic() - hit[0] < _CACHE_SECONDS:
        return hit[1]
    value = fetch()
    _cache[key] = (time.monotonic(), value)
    return value


def _get_json(url: str) -> dict:
    try:
        r = httpx.get(url, timeout=10)
        r.raise_for_status()
        return r.json()
    except (httpx.HTTPError, ValueError) as e:
        raise HubError(f"Bide Hub didn't answer {url}: {e}") from e


def discovery() -> dict:
    return _cached(f"discovery:{issuer()}", lambda: _get_json(f"{issuer()}/.well-known/openid-configuration"))


def jwks(fresh: bool = False) -> dict:
    return _cached(f"jwks:{issuer()}", lambda: _get_json(discovery()["jwks_uri"]), fresh=fresh)


def authorize_url(**params: str) -> str:
    return f"{discovery()['authorization_endpoint']}?{urlencode(params)}"


def logout_url(post_logout_redirect_uri: str) -> str:
    # Built from the issuer rather than discovery, so signing out never waits on a Hub round trip.
    q = urlencode({"client_id": settings.bide_hub_client_id, "post_logout_redirect_uri": post_logout_redirect_uri})
    return f"{issuer()}/oauth/logout?{q}"


def exchange_code(code: str, redirect_uri: str, code_verifier: str) -> dict:
    try:
        r = httpx.post(
            discovery()["token_endpoint"],
            auth=(settings.bide_hub_client_id, settings.bide_hub_client_secret),
            data={
                "grant_type": "authorization_code",
                "code": code,
                "redirect_uri": redirect_uri,
                "code_verifier": code_verifier,
            },
            timeout=15,
        )
        body = r.json()
    except (httpx.HTTPError, ValueError) as e:
        raise HubError(f"Bide Hub token exchange failed: {e}") from e
    if r.status_code != 200 or "id_token" not in body:
        raise HubError(f"Bide Hub refused the code: {body.get('error', r.status_code)}")
    return body


def _kid(token: str) -> str | None:
    """The key id in a token's header, read without verifying anything (it only picks which key to check against)."""
    try:
        header = json.loads(base64.urlsafe_b64decode(token.split(".", 1)[0] + "=="))
    except (ValueError, IndexError):
        return None
    kid = header.get("kid") if isinstance(header, dict) else None
    return kid if isinstance(kid, str) else None


def _key_set(token: str) -> dict:
    """The Hub's keys. Fetched again only when the token names a key the cached set doesn't have (the Hub rotated),
    and at most once a minute, so tokens anyone can post to the back-channel address can't make the app hammer the
    Hub."""
    keys = jwks()
    kid = _kid(token)
    known = {k.get("kid") for k in keys.get("keys", []) if isinstance(k, dict)}
    if kid and kid not in known and time.monotonic() - _jwks_refreshed_at[0] >= _REFRESH_SECONDS:
        _jwks_refreshed_at[0] = time.monotonic()
        keys = jwks(fresh=True)
    return keys


def _decode(token: str) -> dict:
    """Signature, iss, aud, exp and iat (all required)."""
    try:
        claims = _jwt.decode(
            token,
            JsonWebKey.import_key_set(_key_set(token)),
            claims_options={"exp": {"essential": True}, "iat": {"essential": True}},
        )
    except (JoseError, ValueError) as e:
        raise HubError(f"Bide Hub token didn't verify: {e}") from e
    try:
        claims.validate(leeway=30)  # exp, iat, nbf
    except JoseError as e:
        raise HubError(f"Bide Hub token has expired or lacks exp/iat: {e}") from e
    if claims.get("iss") != issuer():
        raise HubError("Bide Hub token is from another issuer")
    aud = claims.get("aud")
    if aud != settings.bide_hub_client_id and not (isinstance(aud, list) and settings.bide_hub_client_id in aud):
        raise HubError("Bide Hub token is for another system")
    return dict(claims)


def verify_id_token(token: str, nonce: str) -> dict:
    claims = _decode(token)
    if not hmac.compare_digest(str(claims.get("nonce", "")), nonce):
        raise HubError("Bide Hub token is for another sign-in (nonce)")
    if not claims.get("sub") or not claims.get("email"):
        raise HubError("Bide Hub token has no sub or email")
    return claims


def verify_logout_token(token: str) -> dict:
    """OIDC Back-Channel Logout 1.0: the logout event, no nonce, and a sid or sub to say whose sessions end."""
    claims = _decode(token)
    if not isinstance(claims.get("events"), dict) or BACKCHANNEL_EVENT not in claims["events"]:
        raise HubError("Not a logout token")
    if "nonce" in claims:
        raise HubError("A logout token never has a nonce")
    if not claims.get("sid") and not claims.get("sub"):
        raise HubError("A logout token needs a sid or a sub")
    return claims
