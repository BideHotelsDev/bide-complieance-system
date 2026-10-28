"""The database, as SQLAlchemy Core tables (PRD §3, §11).

Every record that people act on has a UUID primary key so ids can't be guessed (§9.1, IDOR). Register items,
Actions and gate items also carry the human reference David's documents use ("TV-014", "TM-041", "A01").

Nothing compliance-specific is a column here: domains, classes, frequencies and forms are rows, so a new kind of
check is configuration, not a migration.
"""

import uuid

from sqlalchemy import (
    BigInteger,
    Boolean,
    CheckConstraint,
    Column,
    Date,
    DateTime,
    Float,
    ForeignKey,
    Index,
    Integer,
    MetaData,
    String,
    Table,
    Text,
    UniqueConstraint,
    func,
)
from sqlalchemy.dialects.postgresql import JSONB, UUID

metadata = MetaData(
    naming_convention={
        "ix": "ix_%(column_0_label)s",
        "uq": "uq_%(table_name)s_%(column_0_N_name)s",
        "ck": "ck_%(table_name)s_%(constraint_name)s",
        "fk": "fk_%(table_name)s_%(column_0_name)s_%(referred_table_name)s",
        "pk": "pk_%(table_name)s",
    }
)


def pk() -> Column:
    return Column("id", UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)


def fk(
    name: str, target: str, *, nullable: bool = True, ondelete: str | None = None, use_alter: bool = False
) -> Column:
    return Column(
        name, UUID(as_uuid=True), ForeignKey(f"{target}.id", ondelete=ondelete, use_alter=use_alter), nullable=nullable
    )


def created() -> Column:
    return Column("created_at", DateTime(timezone=True), nullable=False, server_default=func.now())


def updated() -> Column:
    return Column("updated_at", DateTime(timezone=True), nullable=False, server_default=func.now(), onupdate=func.now())


# ---------------------------------------------------------------------------------------------------------------------
# People, roles and access
# ---------------------------------------------------------------------------------------------------------------------

person = Table(
    "person",
    metadata,
    pk(),
    Column("name", String(200), nullable=False),
    Column("email", String(320), nullable=True, unique=True),
    Column("title", String(120), nullable=True),  # shown under the name, e.g. "System owner"
    # staff (Workspace account), external (assessor, SPV director, contractor contact: magic link)
    Column("kind", String(20), nullable=False, server_default="staff"),
    Column("employment_status", String(20), nullable=False, server_default="active"),  # active | leaver
    Column("slack_id", String(40), nullable=True),
    Column("google_sub", String(64), nullable=True, unique=True),
    Column("phone", String(40), nullable=True),
    Column("left_on", Date, nullable=True),
    Column("onboarded_at", DateTime(timezone=True), nullable=True),
    Column("privacy_notice_seen_at", DateTime(timezone=True), nullable=True),
    Column("preferences", JSONB, nullable=False, server_default="{}"),  # density, muted channels, push reminders
    created(),
    updated(),
)

# Roles from PRD §2: super_admin, system_owner, register_keeper, systems, dutyholder, site_lead, staff, keyholder,
# assessor, contractor. property_id NULL means the role applies to every property (group roles).
role_assignment = Table(
    "role_assignment",
    metadata,
    pk(),
    fk("person_id", "person", nullable=False, ondelete="CASCADE"),
    Column("role", String(30), nullable=False),
    fk("property_id", "property", ondelete="CASCADE"),
    created(),
    # A group role (no property) is still one row per person: NULLs compare equal here (Postgres 15+).
    UniqueConstraint("person_id", "role", "property_id", postgresql_nulls_not_distinct=True),
)

device = Table(
    "device",
    metadata,
    pk(),
    fk("person_id", "person", nullable=False, ondelete="CASCADE"),
    Column("label", String(120), nullable=False),  # "iPhone · staff app", "Chrome on Windows"
    Column("app", String(10), nullable=False),  # web | field
    Column("fingerprint_hash", String(64), nullable=False),
    Column("trusted_at", DateTime(timezone=True), nullable=True),
    Column("trusted_until", DateTime(timezone=True), nullable=True),
    Column("approved_by", UUID(as_uuid=True), ForeignKey("person.id"), nullable=True),
    Column("last_seen_at", DateTime(timezone=True), nullable=True),
    Column("revoked_at", DateTime(timezone=True), nullable=True),
    created(),
)

otp_challenge = Table(
    "otp_challenge",
    metadata,
    pk(),
    fk("person_id", "person", nullable=False, ondelete="CASCADE"),
    fk("device_id", "device", ondelete="CASCADE"),
    Column("purpose", String(20), nullable=False),  # new_device | magic_link
    Column("code_hash", String(64), nullable=False),
    Column("expires_at", DateTime(timezone=True), nullable=False),
    Column("attempts", Integer, nullable=False, server_default="0"),
    Column("used_at", DateTime(timezone=True), nullable=True),
    created(),
)

auth_session = Table(
    "auth_session",
    metadata,
    pk(),
    fk("person_id", "person", nullable=False, ondelete="CASCADE"),
    fk("device_id", "device", ondelete="CASCADE"),
    # Each refresh rotates the token. Presenting an old one again means it was stolen: the device is revoked.
    Column("refresh_hash", String(64), nullable=False, unique=True),
    Column("previous_refresh_hash", String(64), nullable=True),
    Column("expires_at", DateTime(timezone=True), nullable=False),
    Column("idle_expires_at", DateTime(timezone=True), nullable=True),
    Column("last_used_at", DateTime(timezone=True), nullable=True),
    Column("revoked_at", DateTime(timezone=True), nullable=True),
    Column("totp_ok", Boolean, nullable=False, server_default="false"),
    created(),
)

totp_secret = Table(
    "totp_secret",
    metadata,
    Column("person_id", UUID(as_uuid=True), ForeignKey("person.id", ondelete="CASCADE"), primary_key=True),
    Column("secret", String(64), nullable=False),
    Column("confirmed_at", DateTime(timezone=True), nullable=True),
)

# ---------------------------------------------------------------------------------------------------------------------
# Properties and their legal frame
# ---------------------------------------------------------------------------------------------------------------------

dutyholder = Table(
    "dutyholder",
    metadata,
    pk(),
    Column("name", String(200), nullable=False),  # "TDA Properties Scotland Ltd"
    Column("company_number", String(20), nullable=True),
    created(),
)

dutyholder_director = Table(
    "dutyholder_director",
    metadata,
    fk("dutyholder_id", "dutyholder", nullable=False, ondelete="CASCADE"),
    fk("person_id", "person", nullable=False, ondelete="CASCADE"),
    UniqueConstraint("dutyholder_id", "person_id"),
)

property_ = Table(
    "property",
    metadata,
    pk(),
    Column("name", String(120), nullable=False),
    Column("code", String(4), nullable=False, unique=True),  # TM, TV, AR, TH, EH, BS: the register ID prefix
    Column("town", String(120), nullable=True),
    fk("dutyholder_id", "dutyholder"),
    Column("jurisdiction", String(20), nullable=False, server_default="scotland"),  # scotland | england
    Column("local_authority", String(120), nullable=True),
    Column("licence_regime", String(30), nullable=False, server_default="class7_hotel"),  # class7_hotel | stl | other
    Column("stage", String(20), nullable=False, server_default="trading"),  # pre_opening | trading | closed | setup
    Column("stage_note", String(200), nullable=True),  # "interim", "loads in December"
    Column("opening_date", Date, nullable=True),
    Column("trading_since", Date, nullable=True),
    # has_gas, has_oil, has_hot_tub, has_sauna, has_lift, has_food, has_alcohol, has_cctv, has_salto, unmanned,
    # has_fire_alarm, pre_2000. Templates' applies-to rules read these (CMS-10).
    Column("features", JSONB, nullable=False, server_default="{}"),
    Column("geofence_lat", Float, nullable=True),
    Column("geofence_lng", Float, nullable=True),
    Column("geofence_radius_m", Integer, nullable=True),
    Column("timezone", String(40), nullable=False, server_default="Europe/London"),
    Column("accent", String(9), nullable=True),  # P2 per-property accent (CMS-16)
    Column("legal_hold", Boolean, nullable=False, server_default="false"),
    Column("next_number", Integer, nullable=False, server_default="1"),  # for new register item / Action refs
    Column("sort", Integer, nullable=False, server_default="0"),
    Column("active", Boolean, nullable=False, server_default="true"),
    created(),
    updated(),
)

licence = Table(
    "licence",
    metadata,
    pk(),
    fk("property_id", "property", nullable=False, ondelete="CASCADE"),
    Column("type", String(30), nullable=False),  # stl | premises | other
    Column("number", String(80), nullable=True),
    Column("authority", String(120), nullable=True),
    Column("issued_on", Date, nullable=True),
    Column("expires_on", Date, nullable=True),
    Column("max_occupancy", Integer, nullable=True),
    # [{text, kind: mandatory|local, template_ids: [...]}] (CMS-11)
    Column("conditions", JSONB, nullable=False, server_default="[]"),
    fk("document_id", "evidence"),
    created(),
)

location = Table(
    "location",
    metadata,
    pk(),
    fk("property_id", "property", nullable=False, ondelete="CASCADE"),
    Column("name", String(120), nullable=False),  # "Fire panel", "Call point 3 · Ground floor rear", "Room 004"
    Column("type", String(40), nullable=False),  # panel | call_point | room | fire_door | plant | hot_tub | other
    Column("sort", Integer, nullable=False, server_default="0"),
    Column("qr_code", String(64), nullable=True, unique=True),
    Column("active", Boolean, nullable=False, server_default="true"),
)

# ---------------------------------------------------------------------------------------------------------------------
# The library: editable lists, templates and their versioned forms
# ---------------------------------------------------------------------------------------------------------------------

domain = Table(
    "domain",
    metadata,
    pk(),
    Column("key", String(40), nullable=False, unique=True),
    Column("name", String(80), nullable=False),
    Column("sort", Integer, nullable=False, server_default="0"),
)

# A Life safety (3), B Statutory (2), C bide standard (1). Weights are editable (CMS-04).
class_weight = Table(
    "class_weight",
    metadata,
    Column("key", String(1), primary_key=True),
    Column("name", String(40), nullable=False),
    Column("weight", Integer, nullable=False),
)

# Amber starts this many days before the due date, per frequency (§4.2, editable).
warning_window = Table(
    "warning_window",
    metadata,
    Column("frequency", String(30), primary_key=True),
    Column("days", Integer, nullable=False),
)

location_type = Table(
    "location_type",
    metadata,
    Column("key", String(40), primary_key=True),
    Column("name", String(80), nullable=False),
)

staff_requirement_type = Table(
    "staff_requirement_type",
    metadata,
    pk(),
    Column("key", String(40), nullable=False, unique=True),
    Column("name", String(160), nullable=False),
    Column("roles", JSONB, nullable=False, server_default="[]"),  # applied automatically by role (DOC-03)
    Column("renew_months", Integer, nullable=True),
    Column("restricted", Boolean, nullable=False, server_default="false"),  # right to work: register keeper only
)

retention_policy = Table(
    "retention_policy",
    metadata,
    pk(),
    Column("category", String(60), nullable=False, unique=True),
    Column("years", Integer, nullable=False),
    Column("trigger", String(30), nullable=False),  # completion | expiry | employment_end
    Column("action", String(20), nullable=False, server_default="archive"),  # archive | delete
    Column("legal_basis", Text, nullable=True),
    Column("signed_off_by", UUID(as_uuid=True), ForeignKey("person.id"), nullable=True),
)

template = Table(
    "template",
    metadata,
    pk(),
    Column("name", String(240), nullable=False),
    fk("domain_id", "domain", nullable=False),
    Column("class", String(1), ForeignKey("class_weight.key"), nullable=False),
    # check | cleaning | certificate | staff | contractor_visit
    Column("kind", String(20), nullable=False),
    Column("default_frequency", String(30), nullable=False),
    Column("rrule", String(200), nullable=True),  # custom recurrence (SCH-01)
    Column("frequency_note", String(120), nullable=True),  # "Each visit, recorded weekly", "Daily when in use"
    Column("warning_days", Integer, nullable=True),  # NULL: the frequency's window
    Column("lead_days", Integer, nullable=True),  # certificates: task appears at expiry minus this (SCH-03)
    Column("due_time", String(5), nullable=False, server_default="23:59"),
    Column("window_hours", Integer, nullable=True),  # completion window before due; NULL: the whole period
    Column("late_rule", String(10), nullable=False, server_default="late"),  # late | missed (SCH-10)
    Column("verification", String(10), nullable=False, server_default="sample"),  # none | always | sample (VER-02)
    Column("sample_rate", Integer, nullable=False, server_default="10"),  # 1 in N
    Column("legal_basis", Text, nullable=True),
    Column("legal_link", String(500), nullable=True),
    Column("guidance", Text, nullable=True),
    fk("example_photo_id", "evidence"),
    # {"all": [{"feature": "has_hot_tub"}, {"jurisdiction": ["scotland","england"]}]} (CMS-10)
    Column("applies_to", JSONB, nullable=False, server_default="{}"),
    Column("applies_note", String(160), nullable=True),  # "Salto doors fitted", "Unmanned properties"
    Column("done_by_hint", String(120), nullable=True),  # master list "Done by" column: Keyholder, Housekeeping…
    Column("geofence_required", Boolean, nullable=False, server_default="true"),
    Column("qr_required", Boolean, nullable=False, server_default="false"),
    Column("typical_minutes", Integer, nullable=True),
    Column("retention_category", String(60), nullable=True),
    # David's labels on master-list rows (CONFIRMED, PROPOSED, TO CONFIRM); "proposed_addition" for §12.2 rows.
    Column("source_status", String(30), nullable=True),
    Column("review_before_use", Boolean, nullable=False, server_default="true"),  # CMS-09
    # published | proposed (a §12.2 addition awaiting agreement, not switched on anywhere) | archived
    Column("status", String(10), nullable=False, server_default="published"),
    Column("archive_reason", Text, nullable=True),
    Column("current_version", Integer, nullable=False, server_default="1"),
    Column("draft_version", Integer, nullable=True),
    Column("sort", Integer, nullable=False, server_default="0"),
    created(),
    updated(),
)

# A template's form and rules at one version. Tasks point at the version they were generated from, so past evidence
# always matches the form that was shown (§3, Versioning).
template_version = Table(
    "template_version",
    metadata,
    pk(),
    fk("template_id", "template", nullable=False, ondelete="CASCADE"),
    Column("version", Integer, nullable=False),
    # [{key, type, label, help, required, unit, min, max, options, fail_on, min_photos, max_photos, source}]
    Column("form", JSONB, nullable=False, server_default="[]"),
    Column("settings", JSONB, nullable=False, server_default="{}"),  # snapshot of the template's rule fields
    Column("status", String(10), nullable=False, server_default="published"),  # draft | published
    Column("published_at", DateTime(timezone=True), nullable=True),
    Column("published_by", UUID(as_uuid=True), ForeignKey("person.id"), nullable=True),
    Column("change_note", Text, nullable=True),
    created(),
    updated(),
    UniqueConstraint("template_id", "version"),
)

# ---------------------------------------------------------------------------------------------------------------------
# Contractors and doer pools
# ---------------------------------------------------------------------------------------------------------------------

contractor = Table(
    "contractor",
    metadata,
    pk(),
    Column("name", String(200), nullable=False),
    Column("trade", String(120), nullable=True),
    Column("accreditation", String(120), nullable=True),  # Gas Safe 123456, BAFE, OFTEC
    Column("accreditation_expires", Date, nullable=True),
    Column("email", String(320), nullable=True),
    Column("phone", String(40), nullable=True),
    Column("active", Boolean, nullable=False, server_default="true"),
    created(),
)

pool = Table(
    "pool",
    metadata,
    pk(),
    fk("property_id", "property", ondelete="CASCADE"),
    Column("name", String(120), nullable=False),  # "Keyholders – The Villa"
    Column("role", String(30), nullable=True),  # members follow a role at the property instead of a fixed list
    created(),
)

pool_member = Table(
    "pool_member",
    metadata,
    fk("pool_id", "pool", nullable=False, ondelete="CASCADE"),
    fk("person_id", "person", nullable=False, ondelete="CASCADE"),
    UniqueConstraint("pool_id", "person_id"),
)

# ---------------------------------------------------------------------------------------------------------------------
# The register: one row per template switched on at a property (BH-CMP-001 register columns)
# ---------------------------------------------------------------------------------------------------------------------

register_item = Table(
    "register_item",
    metadata,
    pk(),
    Column("ref", String(16), nullable=False, unique=True),  # TV-014
    fk("property_id", "property", nullable=False),
    fk("template_id", "template", nullable=False),
    fk("location_id", "location"),
    Column("done_by_kind", String(12), nullable=True),  # person | pool | contractor
    fk("done_by_person_id", "person"),
    fk("done_by_pool_id", "pool"),
    fk("done_by_contractor_id", "contractor"),
    fk("accountable_id", "person"),
    fk("cover_id", "person"),
    Column("verifier_mode", String(10), nullable=True),  # NULL: template rule | none | always | sample
    fk("verifier_id", "person"),
    Column("frequency", String(30), nullable=True),  # override of the template's default (CMS-12)
    Column("frequency_reason", String(240), nullable=True),  # the FRA section or assessor decision behind it
    Column("rrule", String(200), nullable=True),
    Column("due_time", String(5), nullable=True),
    Column("anchor_date", Date, nullable=True),  # where the recurrence starts counting
    Column("last_done_on", Date, nullable=True),  # the date the work was done, not typed in
    Column("next_due_on", Date, nullable=True),
    Column("last_evidence_id", UUID(as_uuid=True), nullable=True),
    # green | amber | red | grey, recomputed by the engine (§4.2)
    Column("status", String(6), nullable=False, server_default="red"),
    Column("status_reason", String(120), nullable=True),  # "fail open", "no evidence", "unsigned"
    Column("notes", Text, nullable=True),
    # on | off (switched off with approved reason: GREY) | paused (SCH-12) | draft (property setup, not activated)
    Column("state", String(10), nullable=False, server_default="on"),
    Column("state_reason", Text, nullable=True),
    Column("paused_until", Date, nullable=True),
    Column("na_review_on", Date, nullable=True),  # GREY items come back for review yearly
    Column("needs_owner", Boolean, nullable=False, server_default="false"),  # SCH-06
    Column("import_label", String(30), nullable=True),  # CONFIRMED | PROPOSED | TO CONFIRM from the Sheet
    created(),
    updated(),
)
Index("ix_register_item_property_status", register_item.c.property_id, register_item.c.status)

# A dated occurrence of a register item. Never deleted when a plan changes (SCH-09).
task = Table(
    "task",
    metadata,
    pk(),
    fk("register_item_id", "register_item", nullable=False),
    fk("template_version_id", "template_version", nullable=False),
    Column("period_key", String(20), nullable=False),  # "2026-W44", "2026-10", "2026-10-26": one task per period
    Column("due_at", DateTime(timezone=True), nullable=False),
    Column("window_opens_at", DateTime(timezone=True), nullable=False),
    Column("window_closes_at", DateTime(timezone=True), nullable=True),  # NULL: completable late, no end
    # scheduled | open | overdue | submitted | passed | verified | failed | missed | na | cancelled
    Column("status", String(10), nullable=False, server_default="scheduled"),
    fk("owner_id", "person"),  # accountable at generation, or approved cover from the moment of reassignment
    Column("doer_kind", String(12), nullable=True),
    Column("doer_id", UUID(as_uuid=True), nullable=True),
    fk("completed_by", "person"),
    Column("completed_at", DateTime(timezone=True), nullable=True),
    Column("escalation_level", Integer, nullable=False, server_default="0"),
    Column("needs_verification", Boolean, nullable=False, server_default="false"),
    Column("spot_check", Boolean, nullable=False, server_default="false"),
    Column("missed_reason_id", UUID(as_uuid=True), nullable=True),
    created(),
    updated(),
    UniqueConstraint("register_item_id", "period_key"),
)
Index("ix_task_due", task.c.due_at, task.c.status)

# Evidence files: photos, certificates, scans. Originals are immutable with a SHA-256 recorded at upload (§9.4).
evidence = Table(
    "evidence",
    metadata,
    pk(),
    Column("kind", String(10), nullable=False),  # photo | pdf | image | doc
    Column("storage_key", String(300), nullable=False),
    Column("display_key", String(300), nullable=True),  # stamped, metadata-stripped copy for viewing
    Column("thumb_key", String(300), nullable=True),
    Column("sha256", String(64), nullable=False),
    Column("phash", String(32), nullable=True),  # perceptual hash for duplicate detection (EXE-13, P2)
    Column("content_type", String(80), nullable=False),
    Column("size_bytes", BigInteger, nullable=False),
    Column("file_name", String(300), nullable=False),  # "What - Who - Date"
    Column("original_name", String(300), nullable=True),
    Column("captured_at", DateTime(timezone=True), nullable=True),
    Column("captured_with", String(10), nullable=True),  # camera | upload | import
    fk("uploaded_by", "person"),
    fk("property_id", "property"),
    Column("scan_status", String(10), nullable=False, server_default="clean"),  # pending | clean | infected
    Column("status", String(10), nullable=False, server_default="pending"),  # pending (upload url issued) | stored
    Column("legal_hold", Boolean, nullable=False, server_default="false"),
    created(),
)

submission = Table(
    "submission",
    metadata,
    pk(),
    fk("task_id", "task", nullable=False),
    fk("submitter_id", "person", nullable=False),
    Column("work_done_on", Date, nullable=False),
    Column("server_time", DateTime(timezone=True), nullable=False, server_default=func.now()),
    Column("device_time", DateTime(timezone=True), nullable=True),
    Column("captured_offline", Boolean, nullable=False, server_default="false"),
    Column("back_filed", Boolean, nullable=False, server_default="false"),
    Column("lat", Float, nullable=True),
    Column("lng", Float, nullable=True),
    Column("accuracy_m", Float, nullable=True),
    Column("inside_geofence", Boolean, nullable=True),
    fk("device_id", "device"),
    Column("values", JSONB, nullable=False, server_default="{}"),
    Column("result", String(10), nullable=False),  # passed | failed
    Column("failed_fields", JSONB, nullable=False, server_default="[]"),
    # outside_geofence, clock_skew, captured_offline, back_filed, duplicate_photo
    Column("flags", JSONB, nullable=False, server_default="[]"),
    Column("file_name", String(300), nullable=False),
    Column("notes", Text, nullable=True),
    Column("signature", Text, nullable=True),
    Column("locked", Boolean, nullable=False, server_default="true"),
    Column("approved_backfile_by", UUID(as_uuid=True), ForeignKey("person.id"), nullable=True),
    created(),
)

submission_evidence = Table(
    "submission_evidence",
    metadata,
    fk("submission_id", "submission", nullable=False, ondelete="CASCADE"),
    fk("evidence_id", "evidence", nullable=False),
    Column("field_key", String(60), nullable=True),
    Column("sort", Integer, nullable=False, server_default="0"),
)

# Corrections to a locked submission. The original stays visible (EXE-07).
amendment = Table(
    "amendment",
    metadata,
    pk(),
    fk("submission_id", "submission", nullable=False),
    fk("author_id", "person", nullable=False),
    Column("reason_type", String(40), nullable=False),  # typing_mistake | wrong_location | other
    Column("reason", Text, nullable=False),
    Column("changes", JSONB, nullable=False, server_default="{}"),
    created(),
)

verification = Table(
    "verification",
    metadata,
    pk(),
    fk("submission_id", "submission", nullable=False),
    fk("verifier_id", "person", nullable=False),
    Column("type", String(12), nullable=False),  # planned | spot_check | assessor
    Column("result", String(12), nullable=False),  # approved | rejected | needs_action
    Column("comment", Text, nullable=True),
    created(),
    CheckConstraint("result in ('approved','rejected','needs_action')", name="result"),
)

# ---------------------------------------------------------------------------------------------------------------------
# Approvals: everything someone asks for that someone else must agree
# ---------------------------------------------------------------------------------------------------------------------

approval_request = Table(
    "approval_request",
    metadata,
    pk(),
    # switch_off | na | missed | cover | pause | template | backfile
    Column("kind", String(12), nullable=False),
    fk("property_id", "property"),
    fk("register_item_id", "register_item"),
    fk("task_id", "task"),
    fk("requested_by", "person"),
    Column("source", String(20), nullable=False, server_default="app"),  # app | holiday_tracker | system
    Column("reason", Text, nullable=False),
    Column("note", Text, nullable=True),
    Column("payload", JSONB, nullable=False, server_default="{}"),  # cover dates and person, pause end, etc.
    Column("status", String(10), nullable=False, server_default="waiting"),  # waiting | approved | declined
    fk("decided_by", "person"),
    Column("decided_at", DateTime(timezone=True), nullable=True),
    Column("decision_note", Text, nullable=True),
    Column("review_on", Date, nullable=True),
    created(),
)

leave = Table(
    "leave",
    metadata,
    pk(),
    fk("person_id", "person", nullable=False),
    Column("starts_on", Date, nullable=False),
    Column("ends_on", Date, nullable=False),
    Column("source", String(20), nullable=False, server_default="manual"),  # manual | holiday_tracker
    fk("cover_id", "person"),
    fk("approved_by", "person"),
    Column("acknowledged_by", JSONB, nullable=False, server_default="[]"),  # supervised cover (SCH-07)
    fk("approval_id", "approval_request"),
    Column("ended_at", DateTime(timezone=True), nullable=True),
    created(),
)

# ---------------------------------------------------------------------------------------------------------------------
# Actions & Advisories, incidents, alarm events
# ---------------------------------------------------------------------------------------------------------------------

action = Table(
    "action",
    metadata,
    pk(),
    Column("ref", String(16), nullable=False, unique=True),  # TV-022
    fk("property_id", "property", nullable=False),
    Column("type", String(16), nullable=False),  # action | work_required | advisory
    # failed_check | out_of_range | assessor | sfrs | insurer | incident | snag | folder_review | certificate_fail
    # | alarm_events | manual | gate
    Column("source", String(20), nullable=False),
    Column("source_ref", String(120), nullable=True),  # "TV-EML-11 #2 (Gallagher)", "Folder review 24 Oct"
    Column("gate_ref", String(4), nullable=True),
    Column("description", Text, nullable=False),
    Column("class", String(1), nullable=True),
    Column("priority", String(4), nullable=False),  # high | med | low (shown as Urgent, Soon, Later)
    fk("owner_id", "person"),
    Column("owner_text", String(120), nullable=True),  # imported owners that are roles, until mapped to a person
    fk("owner_contractor_id", "contractor"),
    Column("raised_on", Date, nullable=False),
    Column("due_on", Date, nullable=False),
    Column("status", String(12), nullable=False, server_default="open"),  # open | to_confirm | closed
    Column("closed_on", Date, nullable=True),
    fk("closed_by", "person"),
    Column("decision", Text, nullable=True),  # Advisories close with a decision and its reason (ACT-02)
    Column("decision_reason", Text, nullable=True),
    fk("register_item_id", "register_item"),
    fk("task_id", "task"),
    fk("submission_id", "submission"),
    fk("gate_item_id", "gate_item"),
    fk("certificate_id", "certificate"),
    fk("incident_id", "incident"),
    fk("raised_by", "person"),
    Column("interim_measure", Text, nullable=True),  # Class A: interim measure agreed in writing
    Column("call_due", Boolean, nullable=False, server_default="false"),  # Class A failure phone call (§7)
    Column("call_made_at", DateTime(timezone=True), nullable=True),
    fk("call_made_by", "person"),
    Column("stop_sell_decision", Text, nullable=True),  # SGN-03
    created(),
    updated(),
)
Index("ix_action_open", action.c.status, action.c.priority, action.c.due_on)

action_evidence = Table(
    "action_evidence",
    metadata,
    fk("action_id", "action", nullable=False, ondelete="CASCADE"),
    fk("evidence_id", "evidence", nullable=False),
    Column("purpose", String(10), nullable=False, server_default="closing"),  # raised | closing
)

action_comment = Table(
    "action_comment",
    metadata,
    pk(),
    fk("action_id", "action", nullable=False, ondelete="CASCADE"),
    fk("author_id", "person", nullable=False),
    Column("body", Text, nullable=False),
    created(),
)

incident = Table(
    "incident",
    metadata,
    pk(),
    fk("property_id", "property", nullable=False),
    Column("kind", String(20), nullable=False),  # hazard | accident | near_miss | dangerous_occurrence
    Column("occurred_at", DateTime(timezone=True), nullable=False),
    fk("location_id", "location"),
    Column("location_text", String(200), nullable=True),
    Column("description", Text, nullable=False),
    Column("people_involved", Text, nullable=True),
    Column("riddor_reportable", Boolean, nullable=False, server_default="false"),
    Column("reported_on", Date, nullable=True),
    fk("reported_by", "person", nullable=False),
    created(),
)

incident_evidence = Table(
    "incident_evidence",
    metadata,
    fk("incident_id", "incident", nullable=False, ondelete="CASCADE"),
    fk("evidence_id", "evidence", nullable=False),
)

alarm_event = Table(
    "alarm_event",
    metadata,
    pk(),
    fk("property_id", "property", nullable=False),
    Column("occurred_at", DateTime(timezone=True), nullable=False),
    Column("zone", String(120), nullable=True),
    Column("cause", String(120), nullable=True),
    Column("false_alarm", Boolean, nullable=False, server_default="true"),
    Column("arc_response", String(200), nullable=True),
    Column("keyholder_attended_minutes", Integer, nullable=True),
    Column("notes", Text, nullable=True),
    fk("logged_by", "person"),
    fk("action_id", "action"),  # the engineering-review Action raised by three of the same cause
    created(),
)

# ---------------------------------------------------------------------------------------------------------------------
# Opening gate (BH-CMP-002) and sign-offs
# ---------------------------------------------------------------------------------------------------------------------

gate_template_item = Table(
    "gate_template_item",
    metadata,
    pk(),
    Column("version", Integer, nullable=False, server_default="1"),
    Column("ref", String(4), nullable=False),  # A01..H08
    Column("section", String(1), nullable=False),
    Column("item", Text, nullable=False),
    Column("class", String(1), nullable=False),
    Column("legal_basis", Text, nullable=True),
    Column("evidence_required", Text, nullable=True),
    Column("typical_owner", String(80), nullable=True),
    Column("sort", Integer, nullable=False, server_default="0"),
    UniqueConstraint("version", "ref"),
)

gate = Table(
    "gate",
    metadata,
    pk(),
    fk("property_id", "property", nullable=False, ondelete="CASCADE"),
    Column("template_version", Integer, nullable=False, server_default="1"),
    Column("target_opening", Date, nullable=True),
    fk("signoff_id", "signoff"),
    created(),
    UniqueConstraint("property_id"),
)

gate_item = Table(
    "gate_item",
    metadata,
    pk(),
    fk("gate_id", "gate", nullable=False, ondelete="CASCADE"),
    Column("ref", String(4), nullable=False),
    Column("section", String(1), nullable=False),
    Column("item", Text, nullable=False),
    Column("class", String(1), nullable=False),
    Column("legal_basis", Text, nullable=True),
    Column("evidence_required", Text, nullable=True),
    Column("applies", Boolean, nullable=False, server_default="true"),
    Column("na_reason", Text, nullable=True),
    # not_started | in_progress | to_confirm | done | na
    Column("status", String(12), nullable=False, server_default="not_started"),
    fk("owner_id", "person"),
    Column("owner_text", String(120), nullable=True),
    Column("due_on", Date, nullable=True),
    Column("evidence_link", String(500), nullable=True),
    Column("notes", Text, nullable=True),
    Column("sort", Integer, nullable=False, server_default="0"),
    updated(),
    UniqueConstraint("gate_id", "ref"),
)

gate_item_evidence = Table(
    "gate_item_evidence",
    metadata,
    fk("gate_item_id", "gate_item", nullable=False, ondelete="CASCADE"),
    fk("evidence_id", "evidence", nullable=False),
)

# Signed statements: FRA signature, assessor countersignature, quarterly register sign-off, gate sign-off (SGN-01).
signoff = Table(
    "signoff",
    metadata,
    pk(),
    Column("type", String(20), nullable=False),  # fra | fra_countersign | quarterly | gate
    fk("property_id", "property", nullable=False),
    fk("signer_id", "person", nullable=False),
    fk("dutyholder_id", "dutyholder"),
    Column("statement", Text, nullable=False),
    Column("signed_name", String(200), nullable=False),
    Column("subject", String(120), nullable=True),  # "TV-FRA-01 · version 22 Oct 2026", "Q1 2027"
    fk("evidence_id", "evidence"),
    Column("content_hash", String(64), nullable=False),
    Column("signed_at", DateTime(timezone=True), nullable=False, server_default=func.now()),
)

# Things a dutyholder or assessor must sign, with the conditions that unlock them.
signature_request = Table(
    "signature_request",
    metadata,
    pk(),
    Column("type", String(20), nullable=False),  # fra | fra_countersign | quarterly | gate
    fk("property_id", "property", nullable=False),
    Column("title", String(240), nullable=False),
    Column("subject", String(120), nullable=True),
    fk("evidence_id", "evidence"),
    fk("action_id", "action"),
    Column("gate_ref", String(4), nullable=True),
    fk("register_item_id", "register_item"),
    Column("opens_on", Date, nullable=True),
    Column("due_on", Date, nullable=True),
    Column("preconditions", JSONB, nullable=False, server_default="[]"),  # [{text, done}]
    fk("signoff_id", "signoff"),
    Column("status", String(10), nullable=False, server_default="open"),  # scheduled | open | signed
    created(),
)

# ---------------------------------------------------------------------------------------------------------------------
# Certificates, staff requirements, contractor visits
# ---------------------------------------------------------------------------------------------------------------------

certificate = Table(
    "certificate",
    metadata,
    pk(),
    fk("property_id", "property"),
    fk("person_id", "person"),  # staff certificates (training) belong to a person
    fk("register_item_id", "register_item"),
    Column("type", String(30), nullable=False),  # eicr | cp12 | oftec | pat | el | extinguisher | fra | lra | ...
    Column("title", String(240), nullable=False),
    Column("why_needed", String(240), nullable=True),
    Column("provider_text", String(120), nullable=True),
    Column("issuer", String(200), nullable=True),
    fk("contractor_id", "contractor"),
    Column("issued_on", Date, nullable=True),
    Column("expires_on", Date, nullable=True),
    fk("evidence_id", "evidence"),
    fk("contractor_visit_id", "contractor_visit"),
    # required (not on file yet) | partial | filed. Valid / Expiring / Expired is computed from expires_on.
    Column("filing", String(10), nullable=False, server_default="filed"),
    Column("fail_count", Integer, nullable=False, server_default="0"),
    # Actions point at certificates too; this side is added after both tables exist.
    fk("linked_action_id", "action", use_alter=True),
    Column("superseded_by", UUID(as_uuid=True), nullable=True),
    created(),
)

staff_requirement = Table(
    "staff_requirement",
    metadata,
    pk(),
    fk("person_id", "person", nullable=False, ondelete="CASCADE"),
    fk("type_id", "staff_requirement_type", nullable=False),
    fk("property_id", "property"),
    Column("status", String(12), nullable=False, server_default="missing"),  # missing | pending | done | expired
    Column("detail", String(200), nullable=True),  # "Feb–Jun 2026", "Checked by Lynne"
    Column("done_on", Date, nullable=True),
    Column("expires_on", Date, nullable=True),
    Column("follow_up_on", Date, nullable=True),
    fk("certificate_id", "certificate"),
    fk("evidence_id", "evidence"),
    fk("checked_by", "person"),
    created(),
    UniqueConstraint("person_id", "type_id", "property_id"),
)

contractor_visit = Table(
    "contractor_visit",
    metadata,
    pk(),
    fk("contractor_id", "contractor", nullable=False),
    fk("property_id", "property", nullable=False),
    fk("register_item_id", "register_item"),
    Column("visit_on", Date, nullable=False),
    Column("status", String(10), nullable=False, server_default="booked"),  # booked | done
    Column("purpose", String(120), nullable=False),
    Column("work_done", Text, nullable=True),
    Column("fails_found", JSONB, nullable=False, server_default="[]"),  # [{text, priority}]
    fk("logged_by", "person"),
    fk("evidence_id", "evidence"),
    fk("photo_id", "evidence"),
    created(),
)

# Contractor portal (§5.5, P2). A contact is an external person who signs in with a magic link for one contractor.
contractor_contact = Table(
    "contractor_contact",
    metadata,
    pk(),
    fk("contractor_id", "contractor", nullable=False, ondelete="CASCADE"),
    fk("person_id", "person", nullable=False, ondelete="CASCADE"),
    created(),
    UniqueConstraint("person_id"),
)

# What a contractor sends from the portal: a visit report or a fix photo. Nothing counts until a site manager checks
# it in Evidence review (approved: the visit is done / the Action closes; rejected: sent back with a comment).
contractor_upload = Table(
    "contractor_upload",
    metadata,
    pk(),
    fk("contractor_id", "contractor", nullable=False),
    fk("person_id", "person", nullable=False),
    fk("property_id", "property", nullable=False),
    Column("kind", String(10), nullable=False),  # report | fix
    fk("contractor_visit_id", "contractor_visit"),
    fk("action_id", "action"),
    Column("evidence_ids", JSONB, nullable=False, server_default="[]"),
    Column("note", Text, nullable=True),
    Column("status", String(10), nullable=False, server_default="pending"),  # pending | approved | rejected
    fk("reviewed_by", "person"),
    Column("reviewed_at", DateTime(timezone=True), nullable=True),
    Column("review_comment", Text, nullable=True),
    fk("certificate_id", "certificate"),
    created(),
)
Index("ix_contractor_upload_status", contractor_upload.c.status, contractor_upload.c.property_id)

# ---------------------------------------------------------------------------------------------------------------------
# Escalation, notifications, settings
# ---------------------------------------------------------------------------------------------------------------------

# One row per rung of the ladder (§7) and property (NULL = all properties). recipients: [{kind: role|person, ...}]
escalation_rule = Table(
    "escalation_rule",
    metadata,
    pk(),
    fk("property_id", "property", ondelete="CASCADE"),
    # amber | red_day1 | red_7days | class_a_failure | failed_check | missed | high_action_7days | certificate_window
    # | alarm_events
    Column("trigger", String(24), nullable=False),
    Column("recipients", JSONB, nullable=False, server_default="[]"),
    Column(
        "channels", JSONB, nullable=False, server_default="[]"
    ),  # app | push | slack_dm | slack_channel | email | phone
    Column("timing", JSONB, nullable=False, server_default="{}"),
    Column("mutable", Boolean, nullable=False, server_default="true"),  # Class A alerts can't be muted
    updated(),
    UniqueConstraint("property_id", "trigger"),
)

# An alert that a manager must acknowledge with a note (§7, Acknowledge).
escalation = Table(
    "escalation",
    metadata,
    pk(),
    Column("trigger", String(24), nullable=False),
    fk("property_id", "property"),
    fk("register_item_id", "register_item"),
    fk("task_id", "task"),
    fk("action_id", "action"),
    Column("level", Integer, nullable=False, server_default="1"),
    Column("summary", Text, nullable=False),
    Column("dedupe_key", String(120), nullable=False, unique=True),
    Column("recipients", JSONB, nullable=False, server_default="[]"),
    Column("acknowledged_at", DateTime(timezone=True), nullable=True),
    fk("acknowledged_by", "person"),
    Column("ack_note", Text, nullable=True),
    created(),
)

notification = Table(
    "notification",
    metadata,
    pk(),
    fk("person_id", "person", nullable=False, ondelete="CASCADE"),
    Column("kind", String(30), nullable=False),
    Column("class", String(1), nullable=True),
    Column("title", String(240), nullable=False),
    Column("body", Text, nullable=True),
    Column("link", String(300), nullable=True),
    fk("escalation_id", "escalation"),
    Column("channels", JSONB, nullable=False, server_default="[]"),
    Column("delivered", JSONB, nullable=False, server_default="{}"),  # {slack: ts, email: ok, push: ok}
    Column("hold_until", DateTime(timezone=True), nullable=True),  # quiet hours for Class B/C
    Column("read_at", DateTime(timezone=True), nullable=True),
    created(),
)

push_subscription = Table(
    "push_subscription",
    metadata,
    pk(),
    fk("person_id", "person", nullable=False, ondelete="CASCADE"),
    fk("device_id", "device", ondelete="CASCADE"),
    Column("endpoint", Text, nullable=False, unique=True),
    Column("keys", JSONB, nullable=False),
    created(),
)

setting = Table(
    "setting",
    metadata,
    Column("key", String(60), primary_key=True),
    Column("value", JSONB, nullable=False),
    updated(),
)

# Every theme ever published is kept; rolling back republishes an earlier one (CMS-15).
theme_version = Table(
    "theme_version",
    metadata,
    pk(),
    Column("version", Integer, nullable=False),
    Column("status", String(10), nullable=False),  # draft | live | retired
    Column("name", String(120), nullable=False),
    Column("tokens", JSONB, nullable=False),  # {light: {...}, dark: {...}, radius, density, font}
    Column("branding", JSONB, nullable=False, server_default="{}"),  # app name, logo evidence ids, sign-in text
    fk("created_by", "person"),
    Column("published_at", DateTime(timezone=True), nullable=True),
    fk("published_by", "person"),
    created(),
)

# Editable wording: labels, UI copy, notification and digest templates (CMS-17).
content_message = Table(
    "content_message",
    metadata,
    Column("key", String(60), primary_key=True),
    Column("group", String(30), nullable=False),  # alerts | screen | labels
    Column("name", String(120), nullable=False),
    Column("channels", JSONB, nullable=False, server_default="[]"),
    Column("body", Text, nullable=False),
    Column("draft_body", Text, nullable=True),
    Column("short_body", Text, nullable=True),  # push version
    Column("placeholders", JSONB, nullable=False, server_default="[]"),
    fk("updated_by", "person"),
    updated(),
)

saved_view = Table(
    "saved_view",
    metadata,
    pk(),
    fk("person_id", "person", nullable=False, ondelete="CASCADE"),
    Column("page", String(40), nullable=False),
    Column("name", String(80), nullable=False),
    Column("query", String(2000), nullable=False),
    created(),
)

# Inspection packs and exports (DSH-07, DSH-09). The fingerprint lets a reader detect a changed file.
report_export = Table(
    "report_export",
    metadata,
    pk(),
    Column("kind", String(20), nullable=False),  # inspection_pack | table_export | person_export
    fk("property_id", "property"),
    Column("params", JSONB, nullable=False, server_default="{}"),
    Column("status", String(10), nullable=False, server_default="queued"),  # queued | building | ready | failed
    Column("pdf_key", String(300), nullable=True),
    Column("zip_key", String(300), nullable=True),
    Column("fingerprint", String(64), nullable=True),
    Column("pages", Integer, nullable=True),
    Column("photo_count", Integer, nullable=True),
    Column("error", Text, nullable=True),
    fk("requested_by", "person", nullable=False),
    created(),
    Column("finished_at", DateTime(timezone=True), nullable=True),
)

scheduled_report = Table(
    "scheduled_report",
    metadata,
    pk(),
    Column("name", String(120), nullable=False),
    Column("schedule", String(60), nullable=False),  # "Mondays 08:30", "1st of the month"
    Column("cron", String(60), nullable=False),
    Column("target", String(200), nullable=False),
    Column("kind", String(30), nullable=False),  # monday_digest | dutyholder_monthly | property_daily
    Column("enabled", Boolean, nullable=False, server_default="true"),
    Column("last_run_at", DateTime(timezone=True), nullable=True),
)

# Assessor quarterly audit walks: each line compares the register with the building (§6 Assessor view).
audit_walk = Table(
    "audit_walk",
    metadata,
    pk(),
    fk("property_id", "property", nullable=False),
    fk("assessor_id", "person", nullable=False),
    Column("quarter", String(8), nullable=False),  # "2026-Q4"
    Column("status", String(12), nullable=False, server_default="in_progress"),  # in_progress | sent
    Column("sent_at", DateTime(timezone=True), nullable=True),
    created(),
    UniqueConstraint("property_id", "quarter"),
)

audit_walk_line = Table(
    "audit_walk_line",
    metadata,
    pk(),
    fk("walk_id", "audit_walk", nullable=False, ondelete="CASCADE"),
    fk("register_item_id", "register_item", nullable=False),
    Column("verdict", String(12), nullable=True),  # matches | doesnt | cant_check
    Column("finding", Text, nullable=True),
    Column("priority", String(4), nullable=True),
    Column("photo_ids", JSONB, nullable=False, server_default="[]"),
    fk("action_id", "action"),
    updated(),
    UniqueConstraint("walk_id", "register_item_id"),
)

# Column-mapping imports from the register Sheet or the gate workbook (CMS-06). Re-runnable until go-live.
import_job = Table(
    "import_job",
    metadata,
    pk(),
    Column("kind", String(20), nullable=False),  # register | gate_workbook | csv
    Column("file_name", String(300), nullable=False),
    fk("evidence_id", "evidence"),
    Column("sheets", JSONB, nullable=False, server_default="[]"),
    Column("mapping", JSONB, nullable=False, server_default="{}"),
    Column("owner_map", JSONB, nullable=False, server_default="{}"),
    Column("preview", JSONB, nullable=False, server_default="{}"),
    Column("status", String(12), nullable=False, server_default="mapping"),  # mapping | review | imported
    Column("result", JSONB, nullable=False, server_default="{}"),
    fk("created_by", "person", nullable=False),
    created(),
    updated(),
)

# Append-only, hash-chained history (AUD-01, §9.6). A trigger in the migration refuses UPDATE and DELETE.
audit_event = Table(
    "audit_event",
    metadata,
    Column("seq", BigInteger, primary_key=True, autoincrement=True),
    Column("id", UUID(as_uuid=True), nullable=False, unique=True, default=uuid.uuid4),
    Column("at", DateTime(timezone=True), nullable=False),
    fk("actor_id", "person"),
    Column("actor_label", String(200), nullable=False),  # "System", "Nightly job", or the person's name then
    Column("category", String(20), nullable=False),  # sign_in | check | amendment | export | settings | record
    Column("action", String(60), nullable=False),
    Column("summary", Text, nullable=False),
    Column("entity_type", String(30), nullable=True),
    Column("entity_id", UUID(as_uuid=True), nullable=True),
    Column("entity_ref", String(60), nullable=True),
    fk("property_id", "property"),
    Column("before", JSONB, nullable=True),
    Column("after", JSONB, nullable=True),
    Column("ip", String(64), nullable=True),
    Column("client", String(120), nullable=True),  # "Staff app · trusted iPhone", "Web · Chrome"
    Column("prev_hash", String(64), nullable=False),
    Column("hash", String(64), nullable=False),
)
Index("ix_audit_event_at", audit_event.c.at)
