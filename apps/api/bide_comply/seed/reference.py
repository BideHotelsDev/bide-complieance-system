"""Reference data every install needs: lists, the library, the gate template, alert rules, wording and the default
theme. Safe to run again: existing rows are left as they are.
"""

import uuid

from sqlalchemy import Connection, select
from sqlalchemy.dialects.postgresql import insert as pg_insert

from bide_comply import clock
from bide_comply.engine import forms
from bide_comply.schema import (
    class_weight,
    content_message,
    domain,
    escalation_rule,
    gate_template_item,
    location_type,
    retention_policy,
    scheduled_report,
    setting,
    staff_requirement_type,
    template,
    template_version,
    theme_version,
    warning_window,
)
from bide_comply.seed import library as lib
from bide_comply.services.notify import DEFAULT_RULES

# Default themes (design: Brand, Foundations, Appearance). Values are tokens the client applies as CSS variables.
CLEAN_LIGHT = {
    "background": "#FBFBFC",
    "surface": "#FFFFFF",
    "sidebar": "#F6F6F8",
    "foreground": "#111113",
    "ink2": "#3A3A42",
    "muted": "#6B6B76",
    "subtle": "#8A8A94",
    "border": "#E3E3E8",
    "divider": "#EBEBEF",
    "primary": "#111113",
    "primaryForeground": "#FFFFFF",
    "accent": "#2459C7",
    "focus": "#2459C7",
    "hover": "#F1F1F3",
    "green": "#17703C",
    "greenBg": "#E8F5EE",
    "amber": "#9A4F00",
    "amberBg": "#FDF1E3",
    "red": "#B42424",
    "redBg": "#FCEBEB",
    "grey": "#5E5E69",
    "greyBg": "#F1F1F3",
    "blue": "#2459C7",
    "blueBg": "#EAF0FD",
}
CLEAN_DARK = {
    "background": "#0F0F11",
    "surface": "#17171A",
    "sidebar": "#131316",
    "foreground": "#EDEDF0",
    "ink2": "#C9C9D0",
    "muted": "#9A9AA5",
    "subtle": "#7A7A85",
    "border": "#2C2C32",
    "divider": "#26262B",
    "primary": "#EDEDF0",
    "primaryForeground": "#111113",
    "accent": "#8FA8E6",
    "focus": "#8FA8E6",
    "hover": "#1F1F23",
    "green": "#6FCF97",
    "greenBg": "#13291D",
    "amber": "#F2B060",
    "amberBg": "#2E2112",
    "red": "#F28B8B",
    "redBg": "#331616",
    "grey": "#A5A5AE",
    "greyBg": "#232328",
    "blue": "#8FA8E6",
    "blueBg": "#172036",
}
HIGH_CONTRAST = {
    **CLEAN_LIGHT,
    "background": "#FFFFFF",
    "sidebar": "#FFFFFF",
    "muted": "#3A3A42",
    "subtle": "#3A3A42",
    "border": "#5E5E69",
    "divider": "#8A8A94",
    "green": "#0B5A2C",
    "amber": "#7A3E00",
    "red": "#8F1515",
    "grey": "#3A3A42",
    "blue": "#173F99",
}
DEFAULT_THEME = {
    "preset": "clean_light",
    "light": CLEAN_LIGHT,
    "dark": CLEAN_DARK,
    "highContrast": HIGH_CONTRAST,
    "radius": 6,
    "density": "comfortable",
    "font": "Inter",
    "tone": "plain",
}
DEFAULT_BRANDING = {
    "appName": "bide Comply",
    "signinMessage": "Sign in with your bide Google account.",
}

MESSAGES = [
    (
        "check_due_soon",
        "alerts",
        "Check due soon",
        ["app", "slack"],
        "{check} at {property} is due {due_date}. It usually takes about {typical_time}.",
        "{check} due {due_date}",
        ["check", "property", "due_date", "typical_time", "person"],
    ),
    (
        "check_overdue",
        "alerts",
        "Check overdue",
        ["app", "slack", "email"],
        "{check} at {property} is {days_overdue} overdue. It usually takes about {typical_time}. Open it to do it now, "
        "or tell {site_lead} if you can't.",
        "{check} is overdue · {property} · {days_overdue}",
        ["check", "property", "due_date", "days_overdue", "person", "site_lead", "class", "typical_time"],
    ),
    (
        "class_a_failure",
        "alerts",
        "Class A failure",
        ["app", "slack", "email", "phone"],
        "Class A at {property}: {what}. Action {action} is with {owner}, due today. {caller} will call the site.",
        "Class A at {property}: {what}",
        ["property", "what", "action", "owner", "caller"],
    ),
    (
        "certificate_expiring",
        "alerts",
        "Certificate expiring",
        ["slack", "email"],
        "{certificate} at {property} expires on {expiry_date} ({days_left}). Book {contractor} now.",
        "{certificate} expires {expiry_date}",
        ["certificate", "property", "expiry_date", "days_left", "contractor"],
    ),
    (
        "monday_digest",
        "alerts",
        "Monday digest",
        ["slack", "email"],
        "Good morning. This week: {class_a_overdue} life-safety items overdue (goal 0), {on_time} of checks done on "
        "time last week (goal 95%), {high_over_7} urgent actions open more than 7 days (goal 0).",
        None,
        ["class_a_overdue", "on_time", "high_over_7"],
    ),
    ("failed_result", "screen", "Failed check result", [], "Logged as Failed. Thank you for reporting it.", None, []),
    (
        "empty_overdue",
        "screen",
        "Empty states",
        [],
        "Nothing is overdue at {property}. Next check: {next_check}, {next_date}.",
        None,
        ["property", "next_check", "next_date"],
    ),
    (
        "privacy_notice",
        "screen",
        "Staff privacy notice",
        [],
        "bide Comply records the checks you do, the photos you take, the time, and your location once at the moment you "
        "send a check, so inspectors can see the work was done. It never tracks where you are. Your manager and the "
        "compliance team can see your own numbers; nobody else can. Ask Samantha for a copy of anything held about you.",
        None,
        [],
    ),
    (
        "tour",
        "screen",
        "First-run tour",
        [],
        "Pick a property at the top, and every page follows it. Red means it needs someone now, amber means soon, green "
        "means in date and grey means it doesn't apply here. Search anything with Ctrl K.",
        None,
        [],
    ),
]


def run(conn: Connection) -> None:
    for i, (key, name) in enumerate(lib.DOMAINS):
        conn.execute(pg_insert(domain).values(id=uuid.uuid4(), key=key, name=name, sort=i).on_conflict_do_nothing())
    for key, name, weight in lib.CLASSES:
        conn.execute(pg_insert(class_weight).values(key=key, name=name, weight=weight).on_conflict_do_nothing())
    for f, days in lib.WINDOWS:
        conn.execute(pg_insert(warning_window).values(frequency=f, days=days).on_conflict_do_nothing())
    for key, name in lib.LOCATION_TYPES:
        conn.execute(pg_insert(location_type).values(key=key, name=name).on_conflict_do_nothing())
    for key, name, roles, months, restricted in lib.STAFF_REQUIREMENTS:
        conn.execute(
            pg_insert(staff_requirement_type)
            .values(
                id=uuid.uuid4(),
                key=key,
                name=name,
                roles=roles,
                renew_months=months,
                restricted=restricted,
            )
            .on_conflict_do_nothing()
        )
    for cat, years, trig, act, basis in lib.RETENTION:
        conn.execute(
            pg_insert(retention_policy)
            .values(
                id=uuid.uuid4(),
                category=cat,
                years=years,
                trigger=trig,
                action=act,
                legal_basis=basis,
            )
            .on_conflict_do_nothing()
        )

    domains = {r.key: r.id for r in conn.execute(select(domain.c.key, domain.c.id))}
    have = set(conn.execute(select(template.c.name)).scalars())
    for sort, (rows, status) in enumerate([(lib.MASTER, "CONFIRMED"), (lib.PROPOSED, "proposed_addition")]):
        for i, (dom, name, klass, kind, f, done_by, applies_note, applies, basis, extra) in enumerate(rows):
            if name in have:
                continue
            tid = uuid.uuid4()
            form = forms.validate_schema(extra.get("form") or lib.default_form(kind, name))
            values = dict(
                id=tid,
                name=name,
                domain_id=domains[dom],
                **{"class": klass},
                kind=kind,
                default_frequency=f,
                frequency_note=extra.get("frequency_note"),
                late_rule=extra.get("late_rule", "late"),
                verification=extra.get("verification", "sample"),
                legal_basis=basis,
                guidance=extra.get("guidance"),
                applies_to=applies,
                applies_note=applies_note,
                done_by_hint=done_by,
                geofence_required=extra.get("geofence_required", kind in ("check", "cleaning")),
                typical_minutes=extra.get("typical_minutes"),
                source_status=status,
                sort=sort * 100 + i,
                retention_category="certificates" if kind == "certificate" else "completed_checks",
                status="published" if status == "CONFIRMED" else "proposed",
            )
            conn.execute(template.insert().values(**values))
            conn.execute(
                template_version.insert().values(
                    id=uuid.uuid4(),
                    template_id=tid,
                    version=1,
                    form=form,
                    status="published",
                    published_at=clock.now(),
                    change_note="Starter library (BH-CMP-001 §8)"
                    if status == "CONFIRMED"
                    else "Proposed by the PRD review (§12.2); needs David's or the assessor's agreement",
                )
            )

    if not conn.execute(select(gate_template_item.c.id).limit(1)).first():
        for it in lib.gate_template():
            conn.execute(gate_template_item.insert().values(id=uuid.uuid4(), version=1, **it))

    for trig, r in DEFAULT_RULES.items():
        conn.execute(
            pg_insert(escalation_rule)
            .values(
                id=uuid.uuid4(),
                property_id=None,
                trigger=trig,
                recipients=r["recipients"],
                channels=r["channels"],
                timing=r["timing"],
                mutable=trig != "class_a_failure",
            )
            .on_conflict_do_nothing()
        )

    for key, group, name, channels, body, short, ph in MESSAGES:
        conn.execute(
            pg_insert(content_message)
            .values(
                key=key,
                group=group,
                name=name,
                channels=channels,
                body=body,
                short_body=short,
                placeholders=ph,
            )
            .on_conflict_do_nothing()
        )

    for key, value in {
        "quiet_hours": {"enabled": True, "from": "21:00", "until": "07:00"},
        "score_bands": {"green": 95, "amber": 80},
        "expiry_steps": [60, 30, 14, 7],
        "spot_check_rate": 10,
        "l10_targets": {"class_a_overdue": 0, "on_time": 95, "high_over_7": 0},
        "scorecard_targets": {"on_time": 95, "evidence": 100, "actions": 90},
    }.items():
        conn.execute(pg_insert(setting).values(key=key, value=value).on_conflict_do_nothing())

    if not conn.execute(select(theme_version.c.id).limit(1)).first():
        conn.execute(
            theme_version.insert().values(
                id=uuid.uuid4(),
                version=1,
                status="live",
                name="Default monochrome",
                tokens=DEFAULT_THEME,
                branding=DEFAULT_BRANDING,
                published_at=clock.now(),
            )
        )

    if not conn.execute(select(scheduled_report.c.id).limit(1)).first():
        conn.execute(
            scheduled_report.insert().values(
                id=uuid.uuid4(),
                name="Monday digest",
                schedule="Mondays 08:30",
                cron="30 8 * * 1",
                target="#bide-compliance + email",
                kind="monday_digest",
            )
        )
        conn.execute(
            scheduled_report.insert().values(
                id=uuid.uuid4(),
                name="Monthly pack for each dutyholder",
                schedule="1st of the month",
                cron="0 8 1 * *",
                target="email to SPV directors",
                kind="dutyholder_monthly",
            )
        )
