"""Bide brand: "Bide" in running text (lowercase "bide" is for the wordmark only)

Revision ID: e1b7c3d9a5f4
Revises: d4e8a1c6f203
Create Date: 2026-10-29 10:00:00.000000
"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

revision: str = "e1b7c3d9a5f4"
down_revision: str | None = "d4e8a1c6f203"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None

# (table, column, old, new). Exact phrases from the seed, so anything someone has reworded is left alone.
SWAPS = [
    ("class_weight", "name", "bide standard", "Bide standard"),
    ("template", "frequency_note", "Annual (bide standard)", "Annual (Bide standard)"),
    ("gate_template_item", "legal_basis", "bide standard", "Bide standard"),
    ("gate_item", "legal_basis", "bide standard", "Bide standard"),
    ("gate_template_item", "evidence_required", "Register live in bide Comply", "Register live in Bide Comply"),
    ("gate_item", "evidence_required", "Register live in bide Comply", "Register live in Bide Comply"),
]
# The privacy notice: capital B, and in the brand's active voice. Phrase by phrase, so a reworded notice keeps its edits.
NOTICE = [
    ("bide Comply records the checks", "Bide Comply records the checks"),
    ("so inspectors can see the work was done", "so inspectors can see you did the work"),
    ("anything held about you", "anything we hold about you"),
]


def _run(forward: bool) -> None:
    for table, column, old, new in SWAPS:
        a, b = (old, new) if forward else (new, old)
        op.execute(sa.text(f"UPDATE {table} SET {column} = :b WHERE {column} = :a").bindparams(a=a, b=b))  # noqa: S608
    for old, new in NOTICE:
        a, b = (old, new) if forward else (new, old)
        op.execute(
            sa.text(
                "UPDATE content_message SET body = replace(body, :a, :b), draft_body = replace(draft_body, :a, :b) "
                "WHERE key = 'privacy_notice'"
            ).bindparams(a=a, b=b)
        )


def upgrade() -> None:
    _run(True)


def downgrade() -> None:
    _run(False)
