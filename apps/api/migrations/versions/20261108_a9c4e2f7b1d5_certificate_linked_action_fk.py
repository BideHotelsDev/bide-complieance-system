"""The certificate -> action foreign key the initial schema declared but never created

The initial migration put it inside create_table with use_alter=True, which Alembic skips, so `alembic check` reports
it missing. NOT VALID: new and changed rows are checked, existing rows aren't scanned, so an old dangling id can't
stop the deploy.

Revision ID: a9c4e2f7b1d5
Revises: f2a6c8e1d3b7
Create Date: 2026-11-08 06:00:00.000000
"""

from collections.abc import Sequence

from alembic import op

revision: str = "a9c4e2f7b1d5"
down_revision: str | None = "f2a6c8e1d3b7"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.create_foreign_key(
        op.f("fk_certificate_linked_action_id_action"),
        "certificate",
        "action",
        ["linked_action_id"],
        ["id"],
        postgresql_not_valid=True,
    )


def downgrade() -> None:
    op.drop_constraint(op.f("fk_certificate_linked_action_id_action"), "certificate", type_="foreignkey")
