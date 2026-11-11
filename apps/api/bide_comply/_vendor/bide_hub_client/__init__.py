"""bide-hub-client: the app side of Sign in with Bide (bide-hub docs/integrating.md).

Vendored into each Bide app (see packages/bide-hub-client/README.md); don't edit a vendored copy, change it here and
sync. Imports inside the package are relative, so it works wherever it is copied.
"""

from .client import (
    ACCOUNT_DISABLED_EVENT,
    BACKCHANNEL_EVENT,
    PROVISIONING_PURPOSE,
    HubClient,
    pkce_challenge,
    safe_next,
    same,
)
from .errors import HubDenied, HubError, HubUnavailable, InvalidToken, StateMismatch
from .models import Identity, Logout, PendingLogin, ProvisioningRequest

__version__ = "0.1.2"

__all__ = [
    "ACCOUNT_DISABLED_EVENT",
    "BACKCHANNEL_EVENT",
    "PROVISIONING_PURPOSE",
    "HubClient",
    "HubDenied",
    "HubError",
    "HubUnavailable",
    "Identity",
    "InvalidToken",
    "Logout",
    "PendingLogin",
    "ProvisioningRequest",
    "StateMismatch",
    "__version__",
    "pkce_challenge",
    "safe_next",
    "same",
]
