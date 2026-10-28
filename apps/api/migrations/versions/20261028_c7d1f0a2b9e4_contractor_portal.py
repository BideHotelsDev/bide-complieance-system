"""contractor portal: contractor contacts and their uploads waiting for a site manager's check

Revision ID: c7d1f0a2b9e4
Revises: ab3e90b77148
Create Date: 2026-10-28 15:00:00.000000
"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects import postgresql

revision: str = "c7d1f0a2b9e4"
down_revision: str | None = "ab3e90b77148"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.create_table(
        "contractor_contact",
        sa.Column("id", sa.UUID(), nullable=False),
        sa.Column("contractor_id", sa.UUID(), nullable=False),
        sa.Column("person_id", sa.UUID(), nullable=False),
        sa.Column("created_at", sa.DateTime(timezone=True), server_default=sa.text("now()"), nullable=False),
        sa.ForeignKeyConstraint(
            ["contractor_id"],
            ["contractor.id"],
            name=op.f("fk_contractor_contact_contractor_id_contractor"),
            ondelete="CASCADE",
        ),
        sa.ForeignKeyConstraint(
            ["person_id"], ["person.id"], name=op.f("fk_contractor_contact_person_id_person"), ondelete="CASCADE"
        ),
        sa.PrimaryKeyConstraint("id", name=op.f("pk_contractor_contact")),
        sa.UniqueConstraint("person_id", name=op.f("uq_contractor_contact_person_id")),
    )
    op.create_table(
        "contractor_upload",
        sa.Column("id", sa.UUID(), nullable=False),
        sa.Column("contractor_id", sa.UUID(), nullable=False),
        sa.Column("person_id", sa.UUID(), nullable=False),
        sa.Column("property_id", sa.UUID(), nullable=False),
        sa.Column("kind", sa.String(length=10), nullable=False),
        sa.Column("contractor_visit_id", sa.UUID(), nullable=True),
        sa.Column("action_id", sa.UUID(), nullable=True),
        sa.Column("evidence_ids", postgresql.JSONB(), server_default="[]", nullable=False),
        sa.Column("note", sa.Text(), nullable=True),
        sa.Column("status", sa.String(length=10), server_default="pending", nullable=False),
        sa.Column("reviewed_by", sa.UUID(), nullable=True),
        sa.Column("reviewed_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("review_comment", sa.Text(), nullable=True),
        sa.Column("certificate_id", sa.UUID(), nullable=True),
        sa.Column("created_at", sa.DateTime(timezone=True), server_default=sa.text("now()"), nullable=False),
        sa.ForeignKeyConstraint(
            ["contractor_id"], ["contractor.id"], name=op.f("fk_contractor_upload_contractor_id_contractor")
        ),
        sa.ForeignKeyConstraint(["person_id"], ["person.id"], name=op.f("fk_contractor_upload_person_id_person")),
        sa.ForeignKeyConstraint(
            ["property_id"], ["property.id"], name=op.f("fk_contractor_upload_property_id_property")
        ),
        sa.ForeignKeyConstraint(
            ["contractor_visit_id"],
            ["contractor_visit.id"],
            name=op.f("fk_contractor_upload_contractor_visit_id_contractor_visit"),
        ),
        sa.ForeignKeyConstraint(["action_id"], ["action.id"], name=op.f("fk_contractor_upload_action_id_action")),
        sa.ForeignKeyConstraint(["reviewed_by"], ["person.id"], name=op.f("fk_contractor_upload_reviewed_by_person")),
        sa.ForeignKeyConstraint(
            ["certificate_id"], ["certificate.id"], name=op.f("fk_contractor_upload_certificate_id_certificate")
        ),
        sa.PrimaryKeyConstraint("id", name=op.f("pk_contractor_upload")),
    )
    op.create_index("ix_contractor_upload_status", "contractor_upload", ["status", "property_id"])


def downgrade() -> None:
    op.drop_index("ix_contractor_upload_status", table_name="contractor_upload")
    op.drop_table("contractor_upload")
    op.drop_table("contractor_contact")
