"""The authenticator app: the time step of the last code accepted, so a code can't be used twice

Revision ID: b3e7d1f9c2a4
Revises: a9c4e2f7b1d5
Create Date: 2026-11-08 12:00:00.000000
"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

revision: str = "b3e7d1f9c2a4"
down_revision: str | None = "a9c4e2f7b1d5"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.add_column("totp_secret", sa.Column("last_step", sa.BigInteger(), nullable=True))


def downgrade() -> None:
    op.drop_column("totp_secret", "last_step")
