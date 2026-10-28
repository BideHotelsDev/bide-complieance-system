"""Settings: Alert rules (CMS-08), Messages and wording (CMS-17), Appearance (CMS-13..15), Audit log (AUD-01)."""

import re
import uuid
from datetime import date, timedelta

from fastapi import APIRouter, Query, Request
from pydantic import BaseModel
from sqlalchemy import func, select, update
from sqlalchemy.dialects.postgresql import insert as pg_insert

from bide_comply import audit, clock
from bide_comply.api import listing
from bide_comply.auth import Current, actor_for
from bide_comply.authz import ROLES, scope_filter
from bide_comply.db import ConnDep
from bide_comply.schema import (
    audit_event,
    content_message,
    escalation_rule,
    person,
    property_,
    role_assignment,
    setting,
    theme_version,
)
from bide_comply.services import notify
from bide_comply.services.common import names, problem
from bide_comply.services.register import get_setting

router = APIRouter(prefix="/api/settings", tags=["settings"])

# ---------------------------------------------------------------------------------------------------------------------
# Alert rules
# ---------------------------------------------------------------------------------------------------------------------

LADDER = ["amber", "red_day1", "red_7days", "class_a_failure"]
OTHER = ["failed_check", "missed", "high_action_7days", "certificate_window", "alarm_events"]
CHANNEL_LABEL = {
    "app": "App",
    "push": "Push",
    "slack_dm": "Slack DM",
    "slack_channel": "Slack #bide-compliance",
    "email": "Email",
    "phone": "Phone call prompt",
}


def _recipient_label(conn, r: dict) -> str:
    k = r.get("kind")
    if k == "doer":
        return "The person who does it"
    if k == "cover":
        return "Their cover"
    if k == "site_lead":
        return "Site lead"
    if k == "dutyholders":
        return "The property's SPV directors"
    if k == "accountable":
        return "The accountable person"
    if k == "role":
        found = (
            conn.execute(
                select(person.c.name)
                .join(role_assignment, role_assignment.c.person_id == person.c.id)
                .where(role_assignment.c.role == r["role"])
                .order_by(person.c.name)
            )
            .scalars()
            .all()
        )
        label = ", ".join(found[:2]) or ROLES.get(r["role"], r["role"])
        if r["role"] == "assessor" and found:
            label = f"{found[0]} (assessor)"
        return label
    if k == "person":
        return names(conn, {uuid.UUID(str(r["id"]))}).get(uuid.UUID(str(r["id"])), "Someone")
    return k or "?"


@router.get("/alerts")
def alert_rules(pr: Current, conn: ConnDep, property: uuid.UUID | None = None) -> dict:  # noqa: A002
    pr.require("settings.view")
    out = []
    for i, trig in enumerate(LADDER + OTHER):
        r = notify.rule(conn, trig, property)
        out.append(
            {
                "trigger": trig,
                "step": i + 1 if trig in LADDER else None,
                "title": notify.TRIGGERS[trig],
                "note": (r["timing"] or {}).get("note"),
                "recipients": [{**x, "label": _recipient_label(conn, x)} for x in r["recipients"]],
                "channels": [
                    {"key": c, "label": CHANNEL_LABEL.get(c, c), "on": c in r["channels"]} for c in CHANNEL_LABEL
                ],
                "mutable": r.get("mutable", True),
                "own_rule": r.get("property_id") is not None,
                "class_a": trig == "class_a_failure",
            }
        )
    q = get_setting(conn, "quiet_hours", {"enabled": True, "from": "21:00", "until": "07:00"})
    props = conn.execute(
        select(property_.c.id, property_.c.name).where(scope_filter(pr, property_.c.id)).order_by(property_.c.sort)
    ).all()
    return {
        "rules": out,
        "quiet_hours": q,
        "properties": [{"id": str(p.id), "name": p.name} for p in props],
        "can_edit": pr.can("policy.escalation"),
        "examples": [
            {"key": "alarm_missed_villa", "label": "Weekly alarm test missed · The Villa"},
            {"key": "temps_overdue_view", "label": "Water temperatures overdue · The View"},
            {"key": "cert_expiring", "label": "Fire alarm certificate expiring · The View"},
        ],
    }


class RuleIn(BaseModel):
    trigger: str
    recipients: list[dict]
    channels: list[str]
    note: str | None = None


class RulesIn(BaseModel):
    property_id: uuid.UUID | None = None
    rules: list[RuleIn]
    quiet_hours: dict | None = None


@router.put("/alerts")
def save_rules(body: RulesIn, request: Request, pr: Current, conn: ConnDep) -> dict:
    pr.require("policy.escalation")
    for r in body.rules:
        if r.trigger not in notify.TRIGGERS:
            raise problem(422, "trigger", "Unknown trigger.")
        channels = [c for c in r.channels if c in CHANNEL_LABEL]
        if r.trigger == "class_a_failure":
            # Class A alerts can't be muted: app, Slack DM and the phone prompt always stay on.
            channels = sorted(set(channels) | {"app", "slack_dm", "phone"})
        if not r.recipients:
            raise problem(
                422, "recipients", f"\u201c{notify.TRIGGERS[r.trigger]}\u201d needs at least one person to tell."
            )
        existing = conn.execute(
            select(escalation_rule.c.timing)
            .order_by(escalation_rule.c.updated_at.desc())
            .limit(1)
            .where(
                escalation_rule.c.trigger == r.trigger,
                escalation_rule.c.property_id.is_(body.property_id)
                if body.property_id is None
                else escalation_rule.c.property_id == body.property_id,
            )
        ).scalar()
        timing = {**(existing or notify.DEFAULT_RULES[r.trigger]["timing"]), **({"note": r.note} if r.note else {})}
        if body.property_id is None:
            # NULLs never conflict in a unique index, so the all-properties rule is replaced rather than upserted
            # (this also clears any duplicates an earlier upsert left behind).
            conn.execute(
                escalation_rule.delete().where(
                    escalation_rule.c.trigger == r.trigger, escalation_rule.c.property_id.is_(None)
                )
            )
        stmt = pg_insert(escalation_rule).values(
            id=uuid.uuid4(),
            property_id=body.property_id,
            trigger=r.trigger,
            recipients=r.recipients,
            channels=channels,
            timing=timing,
            mutable=r.trigger != "class_a_failure",
        )
        conn.execute(
            stmt.on_conflict_do_update(
                index_elements=["property_id", "trigger"],
                set_={"recipients": r.recipients, "channels": channels, "timing": timing, "updated_at": clock.now()},
            )
        )
    if body.quiet_hours is not None:
        q = body.quiet_hours
        if not re.fullmatch(r"\d\d:\d\d", q.get("from", "")) or not re.fullmatch(r"\d\d:\d\d", q.get("until", "")):
            raise problem(422, "quiet_hours", "Quiet hours need times like 21:00.")
        conn.execute(
            pg_insert(setting)
            .values(key="quiet_hours", value=q)
            .on_conflict_do_update(index_elements=["key"], set_={"value": q})
        )
    audit.record(
        conn,
        actor_for(request, pr),
        category="settings",
        action="alerts.save",
        summary="Changed the alert rules",
        entity_type="setting",
        property_id=body.property_id,
        after={"rules": [r.trigger for r in body.rules], "quiet_hours": body.quiet_hours},
    )
    return {"ok": True}


@router.get("/alerts/test")
def test_rules(pr: Current, conn: ConnDep, example: str = "alarm_missed_villa") -> dict:
    """Walk an example through the ladder: exactly who would hear about it, and when."""
    pr.require("settings.view")
    prop_code, klass, what = {
        "alarm_missed_villa": ("TV", "A", "Weekly alarm test"),
        "temps_overdue_view": ("TM", "B", "Water temperatures"),
        "cert_expiring": ("TM", "A", "Fire alarm service certificate"),
    }.get(example, ("TV", "A", "Weekly alarm test"))
    pid = conn.execute(select(property_.c.id).where(property_.c.code == prop_code)).scalar()
    steps = []
    if example == "cert_expiring":
        r = notify.rule(conn, "certificate_window", pid)
        who = ", ".join(_recipient_label(conn, x) for x in r["recipients"])
        for d in (60, 30, 14):
            steps.append(f"{d} days before: {who}, by {', '.join(CHANNEL_LABEL[c] for c in r['channels'])}")
        steps.append("Every day once expired: the same, and the item turns Red")
        return {"steps": steps}
    due = clock.today()
    for trig, when in [
        ("amber", "Due day"),
        ("red_day1", "Day 1 overdue"),
        ("red_7days" if klass != "A" else "red_7days", "Day 1 overdue (Class A)" if klass == "A" else "Day 7 overdue"),
    ]:
        r = notify.rule(conn, trig, pid)
        who = " and ".join(_recipient_label(conn, x) for x in r["recipients"])
        ch = " and ".join(CHANNEL_LABEL[c] for c in r["channels"] if c in ("app", "slack_dm", "slack_channel", "email"))
        steps.append(f"{when}: {who}, by {ch}")
    return {"steps": steps, "class": klass, "what": what, "from": due}


# ---------------------------------------------------------------------------------------------------------------------
# Messages and wording
# ---------------------------------------------------------------------------------------------------------------------

EXAMPLE = {
    "check": "Fire alarm test",
    "property": "The View",
    "due_date": "Mon 2 Nov",
    "days_overdue": "3 days",
    "person": "Pamela",
    "site_lead": "[site lead]",
    "class": "A",
    "typical_time": "5 minutes",
    "what": "the ARC did not receive this week's test signal",
    "action": "TV-030",
    "owner": "Lynne",
    "caller": "Samantha",
    "certificate": "Fire alarm service",
    "expiry_date": "6 Feb 2027",
    "days_left": "60 days",
    "contractor": "Nova",
    "class_a_overdue": "0",
    "on_time": "96%",
    "high_over_7": "1",
    "next_check": "emergency lighting",
    "next_date": "Mon 2 Nov",
}


def tone_check(text: str, limit: int = 280) -> list[dict]:
    """Plain words, no capitals or exclamation marks, says what to do next, under 280 characters (design: Content).
    On-screen text (privacy notice, tour) isn't a notification, so it gets a longer limit."""
    shouting = bool(re.search(r"\b[A-Z]{4,}\b", re.sub(r"\{[a-z_]+\}", "", text)))
    return [
        {
            "rule": "Plain words",
            "ok": not re.search(r"non-?conformance|task instance|artefact|corrective action item", text, re.I),
        },
        {"rule": "No capitals or exclamation marks", "ok": "!" not in text and not shouting},
        {
            "rule": "Says what to do next",
            "ok": bool(re.search(r"\b(open|tell|book|call|do|take|send|check|review)\b", text, re.I)),
        },
        {"rule": f"Under {limit} characters", "ok": len(fill(text)) <= limit},
    ]


def _limit(r) -> int:
    return 280 if r["group"] == "alerts" else 800


def fill(text: str) -> str:
    return re.sub(r"\{([a-z_]+)\}", lambda m: EXAMPLE.get(m.group(1), m.group(0)), text)


@router.get("/content")
def content(pr: Current, conn: ConnDep) -> dict:
    pr.require("settings.view")
    rows = (
        conn.execute(select(content_message).order_by(content_message.c.group, content_message.c.name)).mappings().all()
    )
    return {
        "groups": [
            {
                "key": g,
                "label": {"alerts": "Reminders and alerts", "screen": "On screen", "labels": "Labels"}[g],
                "items": [
                    {
                        "key": r["key"],
                        "name": r["name"],
                        "channels": r["channels"],
                        "edited": r["draft_body"] is not None,
                    }
                    for r in rows
                    if r["group"] == g
                ],
            }
            for g in ("alerts", "screen")
            if any(r["group"] == g for r in rows)
        ]
    }


@router.get("/content/{key}")
def content_item(key: str, pr: Current, conn: ConnDep) -> dict:
    pr.require("settings.view")
    r = conn.execute(select(content_message).where(content_message.c.key == key)).mappings().first()
    if not r:
        raise problem(404, "not_found", "Not found.")
    body = r["draft_body"] if r["draft_body"] is not None else r["body"]
    return {
        "key": r["key"],
        "name": r["name"],
        "channels": r["channels"],
        "body": body,
        "published_body": r["body"],
        "edited": r["draft_body"] is not None,
        "placeholders": r["placeholders"],
        "preview": fill(body),
        "short": fill(r["short_body"]) if r["short_body"] else None,
        "tone": tone_check(body, _limit(r)),
        "can_edit": pr.can("content.edit"),
    }


class ContentIn(BaseModel):
    body: str


@router.put("/content/{key}")
def save_content(key: str, body: ContentIn, pr: Current, conn: ConnDep) -> dict:
    pr.require("content.edit")
    r = conn.execute(select(content_message).where(content_message.c.key == key)).mappings().first()
    if not r:
        raise problem(404, "not_found", "Not found.")
    unknown = set(re.findall(r"\{([a-z_]+)\}", body.body)) - set(r["placeholders"])
    if unknown:
        raise problem(422, "placeholder", f"Unknown detail: {{{sorted(unknown)[0]}}}. Use the buttons to insert one.")
    conn.execute(
        update(content_message)
        .where(content_message.c.key == key)
        .values(draft_body=body.body, updated_by=pr.person_id)
    )
    return {"preview": fill(body.body), "tone": tone_check(body.body, _limit(r))}


@router.post("/content/publish")
def publish_content(request: Request, pr: Current, conn: ConnDep) -> dict:
    pr.require("content.edit")
    drafts = conn.execute(
        select(content_message.c.key, content_message.c.body, content_message.c.draft_body).where(
            content_message.c.draft_body.isnot(None)
        )
    ).all()
    for d in drafts:
        conn.execute(
            update(content_message).where(content_message.c.key == d.key).values(body=d.draft_body, draft_body=None)
        )
    audit.record(
        conn,
        actor_for(request, pr),
        category="settings",
        action="content.publish",
        summary=f"Published {len(drafts)} wording change{'' if len(drafts) == 1 else 's'}",
        entity_type="content",
        before={d.key: d.body for d in drafts},
        after={d.key: d.draft_body for d in drafts},
    )
    return {"published": len(drafts)}


@router.post("/content/{key}/reset")
def reset_content(key: str, pr: Current, conn: ConnDep) -> dict:
    pr.require("content.edit")
    from bide_comply.seed.reference import MESSAGES

    default = next((m for m in MESSAGES if m[0] == key), None)
    if not default:
        raise problem(404, "not_found", "Not found.")
    conn.execute(update(content_message).where(content_message.c.key == key).values(draft_body=default[4]))
    return {"ok": True}


# ---------------------------------------------------------------------------------------------------------------------
# Appearance: theme tokens with a contrast gate, versioned, one-click rollback
# ---------------------------------------------------------------------------------------------------------------------

HEX = re.compile(r"^#[0-9A-Fa-f]{6}$")
FONTS = ["Inter", "IBM Plex Sans", "Source Sans 3"]
TOKEN_KEYS = [
    "background",
    "surface",
    "sidebar",
    "foreground",
    "ink2",
    "muted",
    "subtle",
    "border",
    "divider",
    "primary",
    "primaryForeground",
    "accent",
    "focus",
    "hover",
    "green",
    "greenBg",
    "amber",
    "amberBg",
    "red",
    "redBg",
    "grey",
    "greyBg",
    "blue",
    "blueBg",
]


def _lum(hex_: str) -> float:
    v = [int(hex_[i : i + 2], 16) / 255 for i in (1, 3, 5)]
    v = [c / 12.92 if c <= 0.03928 else ((c + 0.055) / 1.055) ** 2.4 for c in v]
    return 0.2126 * v[0] + 0.7152 * v[1] + 0.0722 * v[2]


def ratio(a: str, b: str) -> float:
    x, y = _lum(a), _lum(b)
    return (max(x, y) + 0.05) / (min(x, y) + 0.05)


def contrast_checks(t: dict) -> list[dict]:
    """WCAG 2.2 AA (CMS-15): text 4.5:1, UI and links 3:1, and status colours on their tints."""
    pairs = [
        ("Button text on primary", t["primaryForeground"], t["primary"], 4.5),
        ("Primary on surface, links and focus", t["accent"], t["surface"], 3.0),
        ("Body text on background", t["foreground"], t["background"], 4.5),
        ("Muted text on surface", t["muted"], t["surface"], 4.5),
    ]
    for s in ("green", "amber", "red", "grey", "blue"):
        pairs.append((f"{s.capitalize()} status text on its tint", t[s], t[f"{s}Bg"], 4.5))
    out = [
        {"label": label, "ratio": round(ratio(a, b), 1), "min": m, "ok": ratio(a, b) >= m} for label, a, b, m in pairs
    ]
    # Red and green must differ in lightness too, for colour-blind users.
    dl = abs(_lum(t["red"]) - _lum(t["green"]))
    out.append(
        {
            "label": "Red and green differ in lightness",
            "ratio": round(ratio(t["red"], t["green"]), 2),
            "min": 1.1,
            "ok": dl > 0.005 or ratio(t["red"], t["green"]) >= 1.1,
        }
    )
    return out


def validate_tokens(tokens: dict) -> dict:
    # Colours must be hex values, never free CSS, so a theme can't inject styles or scripts (§9.5).
    out = {}
    for mode in ("light", "dark", "highContrast"):
        m = tokens.get(mode) or {}
        clean = {}
        for k in TOKEN_KEYS:
            v = m.get(k)
            if v is None or not HEX.match(str(v)):
                raise problem(422, "token", f"{mode} {k}: use a colour like #111113.")
            clean[k] = str(v).upper()
        out[mode] = clean
    radius = tokens.get("radius", 6)
    if radius not in (4, 6, 8, 10):
        raise problem(422, "radius", "Corner radius must be 4, 6, 8 or 10.")
    font = tokens.get("font", "Inter")
    if font not in FONTS:
        raise problem(422, "font", "Choose a font from the approved list.")
    density = tokens.get("density", "comfortable")
    if density not in ("comfortable", "compact"):
        raise problem(422, "density", "Density must be comfortable or compact.")
    return {
        **out,
        "radius": radius,
        "font": font,
        "density": density,
        "tone": tokens.get("tone", "plain"),
        "preset": tokens.get("preset"),
    }


def _theme_out(conn, t: dict | None) -> dict | None:
    if not t:
        return None
    who = names(conn, {t["published_by"], t["created_by"]})
    checks = {m: contrast_checks(t["tokens"][m]) for m in ("light", "dark") if m in t["tokens"]}
    return {
        "id": str(t["id"]),
        "version": t["version"],
        "status": t["status"],
        "name": t["name"],
        "tokens": t["tokens"],
        "branding": t["branding"],
        "published_at": t["published_at"],
        "by": who.get(t["published_by"] or t["created_by"]),
        "checks": checks,
        "publishable": all(c["ok"] for cs in checks.values() for c in cs),
    }


@router.get("/appearance")
def appearance(pr: Current, conn: ConnDep) -> dict:
    pr.require("settings.view")
    rows = [dict(r) for r in conn.execute(select(theme_version).order_by(theme_version.c.version.desc())).mappings()]
    from bide_comply.seed.reference import CLEAN_DARK, CLEAN_LIGHT, HIGH_CONTRAST

    return {
        "live": _theme_out(conn, next((r for r in rows if r["status"] == "live"), None)),
        "draft": _theme_out(conn, next((r for r in rows if r["status"] == "draft"), None)),
        "history": [_theme_out(conn, r) for r in rows if r["status"] != "draft"],
        "presets": {
            "clean_light": {"light": CLEAN_LIGHT, "dark": CLEAN_DARK},
            "clean_dark": {"light": CLEAN_LIGHT, "dark": CLEAN_DARK, "default_mode": "dark"},
            "high_contrast": {"light": HIGH_CONTRAST, "dark": CLEAN_DARK},
        },
        "fonts": FONTS,
        "can_publish": pr.can("theme.publish"),
    }


class ThemeIn(BaseModel):
    tokens: dict
    branding: dict = {}
    name: str = "Draft"


@router.put("/appearance/draft")
def save_theme(body: ThemeIn, pr: Current, conn: ConnDep) -> dict:
    pr.require("theme.publish")
    tokens = validate_tokens(body.tokens)
    branding = {
        k: v
        for k, v in body.branding.items()
        if k in ("appName", "signinMessage", "logoLight", "logoDark", "icon", "signinImage")
    }
    if "appName" in branding and not (1 <= len(str(branding["appName"]).strip()) <= 40):
        raise problem(422, "app_name", "The app name must be 1 to 40 characters.")
    d = conn.execute(select(theme_version.c.id).where(theme_version.c.status == "draft")).scalar()
    if d:
        conn.execute(
            update(theme_version)
            .where(theme_version.c.id == d)
            .values(tokens=tokens, branding=branding, name=body.name)
        )
    else:
        ver = (conn.execute(select(func.max(theme_version.c.version))).scalar() or 0) + 1
        d = uuid.uuid4()
        conn.execute(
            theme_version.insert().values(
                id=d,
                version=ver,
                status="draft",
                name=body.name,
                tokens=tokens,
                branding=branding,
                created_by=pr.person_id,
            )
        )
    return {"checks": {m: contrast_checks(tokens[m]) for m in ("light", "dark")}}


@router.post("/appearance/publish")
def publish_theme(request: Request, pr: Current, conn: ConnDep) -> dict:
    pr.require("theme.publish")
    d = conn.execute(select(theme_version).where(theme_version.c.status == "draft")).mappings().first()
    if not d:
        raise problem(409, "no_draft", "There's no draft theme to publish.")
    failing = [c["label"] for m in ("light", "dark") for c in contrast_checks(d["tokens"][m]) if not c["ok"]]
    if failing:
        raise problem(422, "contrast", "This theme can't be published: " + "; ".join(failing).lower() + ".")
    live = conn.execute(select(theme_version).where(theme_version.c.status == "live")).mappings().first()
    conn.execute(update(theme_version).where(theme_version.c.status == "live").values(status="retired"))
    conn.execute(
        update(theme_version)
        .where(theme_version.c.id == d["id"])
        .values(status="live", published_at=clock.now(), published_by=pr.person_id)
    )
    audit.record(
        conn,
        actor_for(request, pr),
        category="settings",
        action="theme.publish",
        summary=f"Published theme v{d['version']}",
        entity_type="theme",
        entity_id=d["id"],
        before={"version": live["version"] if live else None},
        after={"version": d["version"]},
    )
    return {"version": d["version"]}


@router.post("/appearance/rollback/{version}")
def rollback(version: int, request: Request, pr: Current, conn: ConnDep) -> dict:
    pr.require("theme.publish")
    old = conn.execute(select(theme_version).where(theme_version.c.version == version)).mappings().first()
    if not old or old["status"] == "draft":
        raise problem(404, "not_found", "Not found.")
    ver = (conn.execute(select(func.max(theme_version.c.version))).scalar() or 0) + 1
    conn.execute(update(theme_version).where(theme_version.c.status == "live").values(status="retired"))
    conn.execute(
        theme_version.insert().values(
            id=uuid.uuid4(),
            version=ver,
            status="live",
            name=f"{old['name']} (restored)",
            tokens=old["tokens"],
            branding=old["branding"],
            created_by=pr.person_id,
            published_at=clock.now(),
            published_by=pr.person_id,
        )
    )
    audit.record(
        conn,
        actor_for(request, pr),
        category="settings",
        action="theme.rollback",
        summary=f"Rolled the theme back to v{version}",
        entity_type="theme",
        after={"restored": version, "as": ver},
    )
    return {"version": ver}


@router.delete("/appearance/draft")
def discard_theme(pr: Current, conn: ConnDep) -> dict:
    pr.require("theme.publish")
    conn.execute(theme_version.delete().where(theme_version.c.status == "draft"))
    return {"ok": True}


# ---------------------------------------------------------------------------------------------------------------------
# Audit log (read only)
# ---------------------------------------------------------------------------------------------------------------------

CATEGORY_LABEL = {
    "all": "Everything",
    "sign_in": "Sign-ins",
    "check": "Changes to checks",
    "amendment": "Amendments",
    "export": "Exports",
    "settings": "Settings changes",
    "record": "Records",
}


@router.get("/audit")
def audit_log(
    pr: Current,
    conn: ConnDep,
    category: str = "all",
    q: str | None = None,
    person_id: list[str] | None = Query(None),
    prop: list[str] | None = Query(None),
    when: str = "today",
    page: int = 1,
    page_size: int = 50,
) -> dict:
    pr.require("audit.view")
    t0 = clock.today()
    since = {"today": t0, "7d": t0 - timedelta(days=7), "30d": t0 - timedelta(days=30), "all": date(2000, 1, 1)}.get(
        when, t0
    )
    qy = (
        select(audit_event, property_.c.name.label("property"), property_.c.code)
        .outerjoin(property_, property_.c.id == audit_event.c.property_id)
        .where(audit_event.c.at >= clock.start_of_day(since))
    )
    if pr.scope is not None:
        qy = qy.where(audit_event.c.property_id.in_(pr.scope or {uuid.UUID(int=0)}))
    if category != "all":
        cats = {
            "check": ("check",),
            "settings": ("settings",),
            "sign_in": ("sign_in",),
            "amendment": ("amendment",),
            "export": ("export",),
        }.get(category, (category,))
        qy = qy.where(audit_event.c.category.in_(cats))
    rows = [dict(r) for r in conn.execute(qy.order_by(audit_event.c.seq.desc()).limit(2000)).mappings()]
    people_opts = sorted({(str(r["actor_id"]), r["actor_label"]) for r in rows if r["actor_id"]}, key=lambda x: x[1])
    prop_opts = sorted({(r["code"], r["property"]) for r in rows if r["code"]}, key=lambda x: x[1])
    items = [
        {
            "id": str(r["id"]),
            "seq": r["seq"],
            "at": r["at"],
            "time": clock.london(r["at"]).strftime("%H:%M:%S"),
            "date": clock.london(r["at"]).date(),
            "who": r["actor_label"],
            "actor_id": str(r["actor_id"]) if r["actor_id"] else None,
            "what": r["summary"],
            "record": r["entity_ref"] or r["property"] or "—",
            "from": r["client"] or ("Nightly job" if r["actor_label"] == "Nightly job" else "—"),
            "category": r["category"],
            "action": r["action"],
            "code": r["code"],
            "flag": r["action"] in ("submission.create",) and (r["after"] or {}).get("result") == "failed",
            "changes": [
                {"field": k, "before": (r["before"] or {}).get(k), "after": v} for k, v in (r["after"] or {}).items()
            ]
            if r["before"] is not None or r["after"]
            else [],
            "hash": r["hash"],
            "prev_hash": r["prev_hash"],
        }
        for r in rows
    ]
    facets = [
        listing.Facet("person_id", "Person", lambda r: r["actor_id"], people_opts),
        listing.Facet("prop", "Property", lambda r: r["code"], prop_opts),
    ]
    res = listing.run(
        items,
        q=q,
        search=lambda r: f"{r['who']} {r['what']} {r['record']}",
        views=[listing.View("all", "All", lambda r: True)],
        view="all",
        facets=facets,
        selected={"person_id": listing.multi(person_id), "prop": listing.multi(prop)},
        page=page,
        page_size=page_size,
        noun=("event", "events"),
        where={"today": "from today", "7d": "from the last 7 days", "30d": "from the last 30 days", "all": ""}[when]
        if when in ("today", "7d", "30d", "all")
        else "",
        order_phrase="Newest first.",
    )
    chain = conn.execute(
        select(audit_event.c.at, audit_event.c.summary)
        .where(audit_event.c.action == "audit.chain_check")
        .order_by(audit_event.c.seq.desc())
        .limit(1)
    ).first()
    out = res.dump()
    out["categories"] = [{"key": k, "label": v} for k, v in CATEGORY_LABEL.items() if k != "record"]
    out["chain"] = {"checked_at": chain.at, "intact": "intact" in chain.summary} if chain else None
    return out


@router.post("/audit/verify")
def verify_now(request: Request, pr: Current, conn: ConnDep) -> dict:
    pr.require("audit.view")
    ok, n, broken = audit.verify_chain(conn)
    audit.record(
        conn,
        actor_for(request, pr),
        category="settings",
        action="audit.chain_check",
        summary=f"Checked the audit chain: {'intact' if ok else f'broken at event {broken}'}",
        after={"events": n},
    )
    return {"intact": ok, "events": n, "broken_at": broken}


# ---------------------------------------------------------------------------------------------------------------------
# Lists (CMS-04): domains, class weights, warning windows
# ---------------------------------------------------------------------------------------------------------------------


class ListsIn(BaseModel):
    weights: dict[str, int] | None = None
    windows: dict[str, int] | None = None


@router.put("/lists")
def save_lists(body: ListsIn, request: Request, pr: Current, conn: ConnDep) -> dict:
    pr.require("library.edit")
    from bide_comply.schema import class_weight, warning_window

    for k, w in (body.weights or {}).items():
        if k not in ("A", "B", "C") or not (1 <= w <= 10):
            raise problem(422, "weight", "Weights are whole numbers from 1 to 10.")
        conn.execute(update(class_weight).where(class_weight.c.key == k).values(weight=w))
    for f, d in (body.windows or {}).items():
        if not (0 <= d <= 365):
            raise problem(422, "window", "Warning windows are 0 to 365 days.")
        conn.execute(
            pg_insert(warning_window)
            .values(frequency=f, days=d)
            .on_conflict_do_update(index_elements=["frequency"], set_={"days": d})
        )
    audit.record(
        conn,
        actor_for(request, pr),
        category="settings",
        action="lists.save",
        summary="Changed class weights or warning windows",
        after=body.model_dump(),
    )
    return {"ok": True}
