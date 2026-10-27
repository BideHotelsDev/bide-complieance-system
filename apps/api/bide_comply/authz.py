"""Roles, capabilities and property scope (PRD §2 permission matrix, §9.3).

Deny by default. Every endpoint names the capability it needs; property scope is applied in queries, never only in
the UI. Separation of duties (nobody verifies, approves N/A for, or approves cover on their own work) is checked
where those decisions are made, with `not_self`.
"""

import uuid
from dataclasses import dataclass, field

from fastapi import HTTPException
from sqlalchemy import Connection, select

from bide_comply.schema import dutyholder_director, property_, role_assignment

ROLES = {
    "super_admin": "Super Admin",
    "system_owner": "System owner",
    "register_keeper": "Register keeper",
    "systems": "Systems",
    "dutyholder": "Dutyholder",
    "site_lead": "Site lead",
    "keyholder": "Keyholder",
    "staff": "Staff",
    "assessor": "Competent assessor",
    "contractor": "Contractor",
}
ADMIN_ROLES = {"super_admin", "system_owner", "register_keeper", "systems"}
# Roles that see every property without a per-property assignment.
GROUP_ROLES = {"super_admin", "system_owner", "register_keeper", "systems"}
# Roles that need a second factor (TOTP) or an Admin-approved device on a new device (§9.2).
STRONG_AUTH_ROLES = {"super_admin", "system_owner", "register_keeper", "systems"}

# capability -> roles that hold it. "own" variants are narrowed by property scope in the query that uses them.
CAPABILITIES: dict[str, set[str]] = {
    "library.edit": {"super_admin", "system_owner", "register_keeper"},
    "policy.retention": {"super_admin"},
    "policy.escalation": {"super_admin"},
    "register.toggle": {"super_admin", "system_owner", "register_keeper"},
    "register.request_toggle": {"site_lead", "systems"},
    "register.view": {
        "super_admin",
        "system_owner",
        "register_keeper",
        "systems",
        "dutyholder",
        "site_lead",
        "assessor",
    },
    "approval.decide": {"super_admin", "system_owner"},
    "people.manage": {"super_admin", "system_owner", "register_keeper"},
    "people.view": {"super_admin", "system_owner", "register_keeper", "systems", "site_lead"},
    "assign": {"super_admin", "system_owner", "register_keeper", "site_lead"},
    "cover.approve": {"super_admin", "system_owner", "register_keeper"},
    "task.complete": {"super_admin", "system_owner", "register_keeper", "systems", "site_lead", "keyholder", "staff"},
    "verify": {"super_admin", "system_owner", "register_keeper", "site_lead", "assessor"},
    "action.raise": {
        "super_admin",
        "system_owner",
        "register_keeper",
        "systems",
        "dutyholder",
        "site_lead",
        "keyholder",
        "staff",
        "assessor",
    },
    "action.close": {"super_admin", "system_owner", "register_keeper", "dutyholder", "site_lead"},
    "action.manage": {"super_admin", "system_owner", "register_keeper", "systems", "dutyholder"},
    "sign.dutyholder": {"dutyholder"},
    "sign.countersign": {"assessor"},
    "dashboard.view": {
        "super_admin",
        "system_owner",
        "register_keeper",
        "systems",
        "dutyholder",
        "site_lead",
        "assessor",
    },
    "scorecard.view": {"super_admin", "system_owner", "register_keeper", "systems", "dutyholder", "site_lead"},
    "export.pack": {"super_admin", "system_owner", "register_keeper", "dutyholder", "site_lead", "assessor"},
    "identity_docs.view": {"super_admin", "register_keeper"},
    "audit.view": {"super_admin", "system_owner", "register_keeper", "dutyholder"},
    "submission.amend": {"super_admin", "system_owner"},
    "theme.publish": {"super_admin", "system_owner"},
    "content.edit": {"super_admin", "system_owner"},
    "settings.view": {"super_admin", "system_owner", "register_keeper", "systems"},
    "import.run": {"super_admin", "system_owner", "register_keeper"},
    "alarm.log": {"super_admin", "system_owner", "register_keeper", "systems", "site_lead", "keyholder", "staff"},
    "assessor.walk": {"assessor"},
    "contractor.visits": {"contractor"},
}


@dataclass
class Principal:
    person_id: uuid.UUID
    name: str
    email: str | None
    kind: str
    # role -> set of property ids it applies to; None in the set means "all properties" (a group role).
    roles: dict[str, set[uuid.UUID | None]] = field(default_factory=dict)
    # Properties this person may see at all, or None for every property.
    scope: set[uuid.UUID] | None = None
    device_id: uuid.UUID | None = None
    session_id: uuid.UUID | None = None

    @property
    def role_names(self) -> set[str]:
        return set(self.roles)

    def has_role(self, role: str, property_id: uuid.UUID | None = None) -> bool:
        props = self.roles.get(role)
        if props is None:
            return False
        return None in props or property_id is None or property_id in props

    def can(self, capability: str, property_id: uuid.UUID | None = None) -> bool:
        holders = CAPABILITIES.get(capability)
        if holders is None:
            raise KeyError(capability)
        return any(self.has_role(r, property_id) for r in holders)

    def require(self, capability: str, property_id: uuid.UUID | None = None) -> None:
        if not self.can(capability, property_id):
            raise HTTPException(403, detail={"code": "forbidden", "message": MESSAGES.get(capability, NO_PERMISSION)})

    def sees(self, property_id: uuid.UUID | None) -> bool:
        return self.scope is None or property_id is None or property_id in self.scope

    def require_property(self, property_id: uuid.UUID | None) -> None:
        # A record outside your scope looks the same as one that doesn't exist (no IDOR probing).
        if not self.sees(property_id):
            raise HTTPException(404, detail={"code": "not_found", "message": "Not found."})

    @property
    def is_admin(self) -> bool:
        return bool(self.role_names & ADMIN_ROLES)

    @property
    def headline_role(self) -> str:
        for r in ROLES:
            if r in self.roles:
                return r
        return "staff"


NO_PERMISSION = "You don't have permission to do that. Ask Samantha (system owner) if you think you should."
MESSAGES = {
    "sign.dutyholder": "Only the SPV's own directors can sign this.",
    "approval.decide": "Only the system owner can approve this. It needs someone other than the person who asked.",
    "theme.publish": "Only the Super Admin and the system owner can publish a theme.",
    "submission.amend": "Only the system owner can amend a locked record.",
}


def not_self(principal: Principal, other: uuid.UUID | None, message: str) -> None:
    """Separation of duties: nobody verifies, approves N/A for, or approves cover on their own work."""
    if other is not None and other == principal.person_id:
        raise HTTPException(403, detail={"code": "own_work", "message": message})


def load_principal(conn: Connection, person: dict) -> Principal:
    roles: dict[str, set[uuid.UUID | None]] = {}
    for r in conn.execute(
        select(role_assignment.c.role, role_assignment.c.property_id).where(role_assignment.c.person_id == person["id"])
    ):
        roles.setdefault(r.role, set()).add(r.property_id)

    # Dutyholders see the properties of the SPVs they direct.
    spv_props = {
        r.id
        for r in conn.execute(
            select(property_.c.id)
            .join(dutyholder_director, dutyholder_director.c.dutyholder_id == property_.c.dutyholder_id)
            .where(dutyholder_director.c.person_id == person["id"])
        )
    }
    if spv_props:
        roles.setdefault("dutyholder", set()).update(spv_props)
        roles["dutyholder"].discard(None)

    if roles.keys() & GROUP_ROLES and any(None in roles[r] for r in roles.keys() & GROUP_ROLES):
        scope = None
    else:
        scope = {p for props in roles.values() for p in props if p is not None}
    return Principal(
        person_id=person["id"],
        name=person["name"],
        email=person["email"],
        kind=person["kind"],
        roles=roles,
        scope=scope,
    )


def scope_filter(principal: Principal, column):
    """A WHERE clause limiting `column` (a property_id column) to what the principal may see."""
    if principal.scope is None:
        return column.isnot(None) | column.is_(None)
    return column.in_(principal.scope or {uuid.UUID(int=0)})
