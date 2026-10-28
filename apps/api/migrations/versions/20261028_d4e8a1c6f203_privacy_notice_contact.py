"""privacy notice names whoever is the system owner ({contact}) instead of "Samantha"

Revision ID: d4e8a1c6f203
Revises: c7d1f0a2b9e4
Create Date: 2026-10-28 22:00:00.000000
"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

revision: str = "d4e8a1c6f203"
down_revision: str | None = "c7d1f0a2b9e4"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None

OLD, NEW = "Ask Samantha for a copy", "Ask {contact} for a copy"


SWAP = "UPDATE content_message SET body = replace(body, :a, :b), draft_body = replace(draft_body, :a, :b) WHERE key = 'privacy_notice'"


def upgrade() -> None:
    # Only the phrase is swapped, so a notice someone has reworded keeps the rest of their wording.
    op.execute(sa.text(SWAP).bindparams(a=OLD, b=NEW))
    op.execute(
        "UPDATE content_message SET placeholders = placeholders || '[\"contact\"]'::jsonb "
        "WHERE key = 'privacy_notice' AND NOT placeholders ? 'contact'"
    )


def downgrade() -> None:
    op.execute(sa.text(SWAP).bindparams(a=NEW, b=OLD))
    op.execute("UPDATE content_message SET placeholders = placeholders - 'contact' WHERE key = 'privacy_notice'")
