"""What can go wrong talking to Bide Hub. Every error is a HubError, so an app can catch one class at the edge."""


class HubError(Exception):
    """Base class. `code` is a short, stable string an app can map to its own sign-in page message."""

    code = "hub_error"


class HubUnavailable(HubError):
    """The Hub couldn't be reached, or answered with something that isn't what it should."""

    code = "hub_unavailable"


class InvalidToken(HubError):
    """A token from the Hub (ID, logout or provisioning) didn't check out: signature, issuer, audience, time, shape."""

    code = "invalid_token"


class StateMismatch(HubError):
    """The callback's `state` isn't the one this browser started with (expired, replayed or forged)."""

    code = "invalid_state"


class HubDenied(HubError):
    """The Hub answered the callback with an error. `error` is what it said, e.g. "access_denied", "login_required"."""

    code = "hub_denied"

    def __init__(self, error: str) -> None:
        super().__init__(error)
        self.error = error

    @property
    def no_access(self) -> bool:
        """The person may not open this app (or isn't signed in, with prompt=none), as opposed to something breaking."""
        return self.error in ("access_denied", "login_required")
