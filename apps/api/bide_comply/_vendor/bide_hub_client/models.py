"""What the client hands back: plain dataclasses, no framework types."""

from dataclasses import asdict, dataclass, field
from datetime import datetime
from typing import Any


@dataclass(frozen=True)
class PendingLogin:
    """What an app keeps (in its session or a short-lived signed cookie) between /login and /callback."""

    state: str
    nonce: str
    verifier: str
    next: str = "/"

    def to_dict(self) -> dict[str, str]:
        return asdict(self)

    @classmethod
    def from_dict(cls, data: Any) -> "PendingLogin | None":
        """None when `data` isn't a pending login (missing, tampered with, from an older version)."""
        if not isinstance(data, dict):
            return None
        try:
            values = {k: data[k] for k in ("state", "nonce", "verifier")}
        except KeyError:
            return None
        if not all(isinstance(v, str) and v for v in values.values()):
            return None
        nxt = data.get("next")
        return cls(**values, next=nxt if isinstance(nxt, str) else "/")


@dataclass(frozen=True)
class Identity:
    """Who signed in, from a verified ID token.

    `email` is only set when the Hub says it has verified it (`email_verified`), so linking by email can't be fooled by
    an address nobody proved. `raw_email` is whatever the token carried, for display.
    """

    sub: str
    sid: str
    email: str | None
    raw_email: str | None
    name: str | None
    picture: str | None
    amr: tuple[str, ...]
    auth_time: int | None
    claims: dict[str, Any] = field(repr=False, compare=False)


@dataclass(frozen=True)
class Logout:
    """A verified back-channel logout.

    End the app's sessions for `sid`; when `sid` is None, end every session of the person `sub` that started at or
    before `logout_at`. `logout_at` is when the sign-out really happened (the Hub retries a logout for days, each try a
    new token), never later than now. `disabled`: a Hub Admin switched the person off, so switch the app's own account
    off too, matched by `sub` only.
    """

    sub: str
    sid: str | None
    logout_at: datetime
    disabled: bool
    claims: dict[str, Any] = field(repr=False, compare=False)

    def ends(self, session_sid: str | None, session_sub: str | None, session_started: datetime) -> bool:
        """Whether this logout ends a session with these properties. Handy for apps with signed-cookie sessions that
        record logouts and check each request against them."""
        if self.sid is not None:
            return session_sid == self.sid
        return session_sub == self.sub and session_started <= self.logout_at


@dataclass(frozen=True)
class ProvisioningRequest:
    """A verified call from the Hub to the app's provisioning endpoints (accounts managed by the Hub)."""

    claims: dict[str, Any] = field(repr=False)
