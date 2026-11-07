"""Sign in with Bide: the person's Bide Hub id, and the Hub session each sign-in came from

Revision ID: f2a6c8e1d3b7
Revises: e1b7c3d9a5f4
Create Date: 2026-11-07 12:00:00.000000
"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

revision: str = "f2a6c8e1d3b7"
down_revision: str | None = "e1b7c3d9a5f4"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.add_column("person", sa.Column("bide_hub_sub", sa.String(length=64), nullable=True))
    op.create_unique_constraint(op.f("uq_person_bide_hub_sub"), "person", ["bide_hub_sub"])
    op.add_column("auth_session", sa.Column("hub_sid", sa.String(length=64), nullable=True))
    op.create_index("ix_auth_session_hub_sid", "auth_session", ["hub_sid"], unique=False)


def downgrade() -> None:
    op.drop_index("ix_auth_session_hub_sid", table_name="auth_session")
    op.drop_column("auth_session", "hub_sid")
    op.drop_constraint(op.f("uq_person_bide_hub_sub"), "person", type_="unique")
    op.drop_column("person", "bide_hub_sub")
