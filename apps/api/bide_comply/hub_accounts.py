"""Accounts managed by Bide Hub: the Hub says which staff have access to bide Comply, and with which staff roles.

The contract is the Hub's docs/integrating.md ("Accounts managed by the Hub"). Off unless Sign in with Bide is on and
BIDE_HUB_MANAGES_ACCOUNTS is set, so the Hub can't take over the people here until an operator has said it may.

    GET  /api/auth/bide/provisioning/catalog            the staff roles and properties, for the Hub's People screen
    GET  /api/auth/bide/provisioning/users              the staff here, for the Hub's one-time import
    PUT  /api/auth/bide/provisioning/users/{sub}        make this person's access match the Hub
    POST /api/auth/bide/provisioning/users/{sub}/check  would that PUT be accepted? changes nothing

Every call carries a short-lived token the Hub signs with its sign-in key; bide-hub-client checks it (purpose, method,
the full address built from WEB_BASE_URL, a hash of the body).

What the Hub manages, and what stays here:

- **Staff only.** Outside people (assessors, contractor contacts, SPV directors: kind "external") sign in with an
  emailed link and are managed in Settings › People. An email that belongs to one is refused.
- **The staff roles only** (HUB_ROLES): the four group roles, which cover every property, and Site lead, Keyholder and
  Staff, given at properties. A person may hold several. Dutyholder, Competent assessor and Contractor stay set here,
  and a push never adds or removes them.
- Required training follows each role given, as it does when an Admin gives it (people.require_training).

The Hub saves a change first and then delivers it, repeating the PUT until it gets a 2xx. So:

- A PUT refuses only what it can't apply (no staff role, an unknown one, a property role without a property, an unknown
  property, an email that is another Hub person's or an outside person's). Repeating it is harmless.
- `active: false` is never refused and never creates a person. It offboards them exactly as Settings › People does
  (people.end_access: a leaver, every device signed out, their checks handed to cover or flagged "needs owner"). If
  that leaves no active Super Admin, the Hub Admin is warned.
- "There's always a Super Admin" lives in the check, which the Hub asks before saving anything else: taking the role
  from the last one is refused there; a PUT of a change the Hub already saved applies it and warns.
"""

import json
import logging
import uuid
from typing import Any

from fastapi import APIRouter, Depends, HTTPException, Request
from fastapi.concurrency import run_in_threadpool
from fastapi.responses import JSONResponse
from sqlalchemy import Connection, func, select, update

from bide_comply import audit, hub
from bide_comply._vendor.bide_hub_client import HubError, InvalidToken
from bide_comply.authz import GROUP_ROLES, ROLES
from bide_comply.config import settings
from bide_comply.db import ConnDep
from bide_comply.schema import person, property_, role_assignment

log = logging.getLogger(__name__)

PATH = "/api/auth/bide/provisioning"
FEATURES = ["check"]
HUB_ROLES = ("super_admin", "system_owner", "register_keeper", "systems", "site_lead", "keyholder", "staff")
HUB = audit.Actor(None, "Bide Hub")
NO_STORE = {"Cache-Control": "no-store"}


class Refused(Exception):
    """The Hub's request can't be carried out. The message is shown to the Hub Admin."""

    def __init__(self, message: str, status: int = 409):
        super().__init__(message)
        self.status = status


def managed() -> bool:
    return settings.accounts_managed_by_hub


def _no(status: int, code: str, message: str) -> HTTPException:
    """An error the Hub can show its Admin: the contract's `detail`, alongside the app's usual code and message."""
    return HTTPException(status, detail={"code": code, "message": message, "detail": message})


# --- what the Hub reads ---------------------------------------------------------------------------------------------


def catalog(conn: Connection) -> dict[str, Any]:
    properties = conn.execute(
        select(property_.c.id, property_.c.name).where(property_.c.stage != "closed").order_by(property_.c.name)
    ).all()
    return {
        "roles": [{"key": r, "name": ROLES[r], "scoped": r not in GROUP_ROLES} for r in HUB_ROLES],
        "scopes": [{"id": str(p.id), "name": p.name} for p in properties],
        "scope_label": "Property",
        "unscoped_label": "Every property",
        "features": FEATURES,
    }


def _hub_assignments(conn: Connection, person_id: uuid.UUID) -> set[tuple[str, uuid.UUID | None]]:
    rows = conn.execute(
        select(role_assignment.c.role, role_assignment.c.property_id).where(
            role_assignment.c.person_id == person_id, role_assignment.c.role.in_(HUB_ROLES)
        )
    ).all()
    return {(r.role, r.property_id) for r in rows}


def accounts(conn: Connection) -> list[dict[str, Any]]:
    out = []
    for p in conn.execute(select(person).where(person.c.kind == "staff").order_by(person.c.email)).mappings():
        if not p["email"]:
            continue
        out.append(
            {
                "email": p["email"],
                "name": p["name"],
                "active": p["employment_status"] == "active",
                "sub": p["bide_hub_sub"],
                "assignments": [
                    {"role": role, "scope": str(prop) if prop else None}
                    for role, prop in sorted(_hub_assignments(conn, p["id"]), key=lambda a: (a[0], str(a[1])))
                ],
            }
        )
    return out


# --- what the Hub changes -------------------------------------------------------------------------------------------


def _wanted(conn: Connection, raw: Any) -> set[tuple[str, uuid.UUID | None]]:
    wanted: set[tuple[str, uuid.UUID | None]] = set()
    for item in [a for a in raw or [] if isinstance(a, dict)]:
        role = str(item.get("role") or "")
        if role not in HUB_ROLES:
            raise Refused(f"'{role}' isn't a staff role the Hub can give in bide Comply.", 422)
        scope = item.get("scope")
        if role in GROUP_ROLES:
            wanted.add((role, None))
            continue
        if scope in (None, ""):
            raise Refused(f"pick a property for {ROLES[role]}.", 422)
        try:
            prop = uuid.UUID(str(scope))
        except ValueError as exc:
            raise Refused("that property isn't in bide Comply.", 422) from exc
        if not conn.execute(select(property_.c.id).where(property_.c.id == prop)).first():
            raise Refused("that property isn't in bide Comply.", 422)
        wanted.add((role, prop))
    if not wanted:
        raise Refused("pick at least one role for bide Comply.", 422)
    return wanted


def _find(conn: Connection, sub: str, email: str) -> dict | None:
    p = conn.execute(select(person).where(person.c.bide_hub_sub == sub)).mappings().first()
    if p is None:
        p = conn.execute(select(person).where(func.lower(person.c.email) == email)).mappings().first()
        if p is not None and p["bide_hub_sub"] and p["bide_hub_sub"] != sub:
            raise Refused(f"{email} belongs to a different Hub person in bide Comply.")
    if p is not None and p["kind"] != "staff":
        raise Refused(f"{email} is an outside person in bide Comply (managed there under Settings › People).")
    return dict(p) if p is not None else None


def _super_admins(conn: Connection) -> int:
    from bide_comply.api.people import _active_super_admins  # people imports from auth, which imports hub

    return _active_super_admins(conn)


def _no_super_admin(name: str) -> str:
    return (
        f"{name} was the last active Super Admin in bide Comply. Until you give someone that role in Bide Hub, nobody "
        "can change retention, escalation or who holds the admin roles there."
    )


def _apply(conn: Connection, sub: str, payload: dict, *, checking: bool) -> tuple[dict | None, list[str]]:
    from bide_comply.api.people import end_access, require_training

    email = str(payload.get("email") or "").strip().lower()
    if not email or "@" not in email:
        raise Refused("the Hub sent no email.", 422)
    active = bool(payload.get("active"))
    warnings: list[str] = []
    had = _super_admins(conn)
    try:
        p = _find(conn, sub, email)
    except Refused:
        if active:
            raise
        return None, warnings  # the address is someone else's here, and this person has nothing to switch off

    if not active:
        # No access at the Hub: offboard them if they're here, never make a person. Never refused.
        if p is None or p["employment_status"] != "active":
            return p, warnings
        moved, flagged = end_access(conn, p)
        if had and not _super_admins(conn):
            warnings.append(_no_super_admin(p["name"]))
        audit.record(
            conn,
            HUB,
            category="settings",
            action="people.offboard",
            summary=f"Bide Hub took away {p['name']}'s access: {moved} checks moved to cover, {flagged} need a new owner",
            entity_type="person",
            entity_id=p["id"],
        )
        return p, warnings

    wanted = _wanted(conn, payload.get("assignments"))
    name = str(payload.get("name") or "").strip()[:200]
    if p is None:
        pid = uuid.uuid4()
        conn.execute(person.insert().values(id=pid, name=name or email, email=email, kind="staff", bide_hub_sub=sub))
        summary = f"Bide Hub added {name or email}"
    else:
        pid = p["id"]
        values: dict[str, Any] = {"bide_hub_sub": sub}
        if (p["email"] or "").lower() != email:
            clash = conn.execute(
                select(person.c.id).where(func.lower(person.c.email) == email, person.c.id != pid)
            ).first()
            if clash:
                raise Refused(f"{email} is already another person in bide Comply.")
            values["email"] = email
        if name:
            values["name"] = name
        if p["employment_status"] != "active":
            values |= {"employment_status": "active", "left_on": None}
        conn.execute(update(person).where(person.c.id == pid).values(**values))
        summary = f"Bide Hub updated {name or p['name']}"

    have = _hub_assignments(conn, pid)
    for role, prop in have - wanted:
        conn.execute(
            role_assignment.delete().where(
                role_assignment.c.person_id == pid,
                role_assignment.c.role == role,
                role_assignment.c.property_id.is_(None) if prop is None else role_assignment.c.property_id == prop,
            )
        )
    for role, prop in sorted(wanted - have, key=lambda a: (a[0], str(a[1]))):
        conn.execute(role_assignment.insert().values(id=uuid.uuid4(), person_id=pid, role=role, property_id=prop))
        require_training(conn, pid, role)

    if had and not _super_admins(conn):
        # This change takes away the last Super Admin. Asked before the Hub saves: refused there. A PUT carries a
        # change the Hub has already saved, so it is applied, and the Hub is where one is put back.
        if checking:
            raise Refused("There must always be at least one Super Admin in bide Comply: give someone else it first.")
        warnings.append(_no_super_admin(name or email))
    if have != wanted or p is None:
        audit.record(
            conn,
            HUB,
            category="settings",
            action="people.hub_sync",
            summary=summary,
            entity_type="person",
            entity_id=pid,
            before={"roles": sorted(f"{r}@{x}" for r, x in have)},
            after={"roles": sorted(f"{r}@{x}" for r, x in wanted)},
        )
    return {"id": pid, "employment_status": "active"}, warnings


def apply(conn: Connection, sub: str, payload: dict) -> dict | None:
    """Make this Hub person's access match `payload`, in the request's transaction (it commits when the request ends;
    on Refused it rolls back)."""
    p, warnings = _apply(conn, sub, payload, checking=False)
    for warning in warnings:
        log.warning("Bide Hub push for %s: %s", sub, warning)
    return p


def check(conn: Connection, sub: str, payload: dict) -> list[str]:
    """Would `apply` accept this? Runs it in a savepoint and throws the result away, so the answer is exactly the PUT's."""
    savepoint = conn.begin_nested()
    try:
        _, warnings = _apply(conn, sub, payload, checking=True)
    finally:
        savepoint.rollback()
    return warnings


# --- the routes -----------------------------------------------------------------------------------------------------


def _require_managed() -> None:
    if not managed():
        raise _no(404, "not_found", "Not found.")


router = APIRouter(prefix=PATH, tags=["auth"], include_in_schema=False, dependencies=[Depends(_require_managed)])


async def _verified(request: Request, path: str) -> bytes:
    """The raw body, once the Hub's token for exactly this call checks out. Async only to read the body; the check (it
    may fetch the Hub's keys) runs in the thread pool."""
    body = await request.body()
    url = f"{settings.web_base_url.rstrip('/')}{PATH}{path}"
    try:
        await run_in_threadpool(
            hub.client().verify_provisioning_request, request.headers.get("authorization"), request.method, url, body
        )
    except InvalidToken as exc:
        log.warning("Bide Hub provisioning refused: %s", exc)
        raise _no(401, "invalid_token", "invalid token") from exc
    except HubError as exc:  # the Hub's keys couldn't be fetched: a 5xx, which the Hub retries
        raise _no(503, "unavailable", "can't check the token") from exc
    return body


def _payload(sub: str, body: bytes) -> dict:
    try:
        payload = json.loads(body or b"{}")
    except ValueError as exc:
        raise _no(422, "invalid", "not JSON") from exc
    if not isinstance(payload, dict) or len(sub) > 64:
        raise _no(422, "invalid", "bad request")
    return payload


@router.get("/catalog")
async def get_catalog(request: Request, conn: ConnDep) -> JSONResponse:
    await _verified(request, "/catalog")
    return JSONResponse(await run_in_threadpool(catalog, conn), headers=NO_STORE)


@router.get("/users")
async def get_users(request: Request, conn: ConnDep) -> JSONResponse:
    await _verified(request, "/users")
    return JSONResponse(await run_in_threadpool(accounts, conn), headers=NO_STORE)


@router.post("/users/{sub}/check")
async def check_user(sub: str, request: Request, conn: ConnDep) -> JSONResponse:
    payload = _payload(sub, await _verified(request, f"/users/{sub}/check"))
    try:
        warnings = await run_in_threadpool(check, conn, sub, payload)
    except Refused as exc:
        raise _no(exc.status, "refused", str(exc)) from exc
    return JSONResponse({"ok": True, "warnings": warnings}, headers=NO_STORE)


@router.put("/users/{sub}")
async def put_user(sub: str, request: Request, conn: ConnDep) -> JSONResponse:
    payload = _payload(sub, await _verified(request, f"/users/{sub}"))
    try:
        p = await run_in_threadpool(apply, conn, sub, payload)
    except Refused as exc:
        raise _no(exc.status, "refused", str(exc)) from exc
    body = {"id": str(p["id"]), "active": p["employment_status"] == "active"} if p else {"id": None, "active": False}
    return JSONResponse(body, headers=NO_STORE)
