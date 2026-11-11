"""Bide Hub, the group's single sign-on (an OpenID Connect provider; contract in bide-hub/docs/integrating.md).

On when BIDE_HUB_ISSUER, BIDE_HUB_CLIENT_ID and BIDE_HUB_CLIENT_SECRET are all set. The Hub answers who someone is
and whether they may open bide Comply; everything after that (device code, authenticator app, roles, sessions) stays
in auth.py.

Talking to the Hub (discovery, keys, PKCE, the code exchange, checking every token) is the shared bide-hub-client,
vendored under _vendor/ (don't edit it here: change it in bide-hub and sync). This module only hands auth.py a client
for the current settings, and re-exports what it needs.
"""

from functools import cache

from bide_comply import clock
from bide_comply._vendor.bide_hub_client import (
    ACCOUNT_DISABLED_EVENT,
    BACKCHANNEL_EVENT,
    HubClient,
    HubDenied,
    HubError,
    Identity,
    InvalidToken,
    Logout,
    PendingLogin,
    StateMismatch,
    same,
)
from bide_comply.config import settings

__all__ = [
    "ACCOUNT_DISABLED_EVENT",
    "BACKCHANNEL_EVENT",
    "HubDenied",
    "HubError",
    "Identity",
    "InvalidToken",
    "Logout",
    "PendingLogin",
    "StateMismatch",
    "client",
    "issuer",
    "logout_url",
    "same",
]


def issuer() -> str:
    return settings.bide_hub_issuer.rstrip("/")


@cache
def _client(iss: str, client_id: str, client_secret: str) -> HubClient:
    # The app's clock (tests freeze it), so a logout's time is capped at the same "now" sessions are dated by.
    return HubClient(iss, client_id, client_secret, now=lambda: clock.now().timestamp())


def client() -> HubClient:
    """The Hub client for the current settings (one per configuration, so its caches are shared)."""
    return _client(issuer(), settings.bide_hub_client_id, settings.bide_hub_client_secret)


def logout_url(post_logout_redirect_uri: str) -> str:
    """Built from the issuer, so signing out never waits on a Hub round trip."""
    return client().logout_url(post_logout_redirect_uri)
