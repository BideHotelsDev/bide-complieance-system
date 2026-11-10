"""Bide Hub sign-outs, so a sign-in still on its device-code or authenticator step can't outlive them

Revision ID: c3e8a1f6d2b9
Revises: a9c4e2f7b1d5
Create Date: 2026-11-10 12:00:00.000000
"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects import postgresql

revision: str = "c3e8a1f6d2b9"
down_revision: str | None = "a9c4e2f7b1d5"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.create_table(
        "hub_logout",
        sa.Column("id", postgresql.UUID(as_uuid=True), nullable=False),
        sa.Column("sid", sa.String(length=64), nullable=True),
        sa.Column("sub", sa.String(length=64), nullable=True),
        sa.Column("logout_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("created_at", sa.DateTime(timezone=True), server_default=sa.text("now()"), nullable=False),
        sa.PrimaryKeyConstraint("id", name=op.f("pk_hub_logout")),
    )
    op.create_index("ix_hub_logout_sid", "hub_logout", ["sid"], unique=False)
    op.create_index("ix_hub_logout_sub", "hub_logout", ["sub"], unique=False)


def downgrade() -> None:
    op.drop_index("ix_hub_logout_sub", table_name="hub_logout")
    op.drop_index("ix_hub_logout_sid", table_name="hub_logout")
    op.drop_table("hub_logout")
