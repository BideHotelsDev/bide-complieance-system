from alembic import context

from bide_comply.db import engine
from bide_comply.schema import metadata


def run_migrations_online() -> None:
    with engine.connect() as connection:
        context.configure(connection=connection, target_metadata=metadata, compare_type=True)
        with context.begin_transaction():
            context.run_migrations()


run_migrations_online()
