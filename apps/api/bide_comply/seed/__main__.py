"""pnpm seed            reference data (lists, library, gate template, alert rules, wording, theme)
pnpm seed:demo       the above plus the demo properties, people and records
pnpm db:reset        development only: drop everything, migrate, and load the demo
"""

import shutil
import subprocess
import sys

from sqlalchemy import text

from bide_comply.config import settings
from bide_comply.db import engine
from bide_comply.seed import demo, reference


def reset() -> None:
    if settings.environment != "development":
        sys.exit("db reset is for development only.")
    with engine.begin() as conn:
        conn.execute(text("DROP SCHEMA public CASCADE; CREATE SCHEMA public;"))
    shutil.rmtree(settings.storage_dir, ignore_errors=True)
    subprocess.run([sys.executable, "-m", "alembic", "upgrade", "head"], check=True)


def main() -> None:
    if "--reset" in sys.argv:
        reset()
    with engine.begin() as conn:
        reference.run(conn)
        if "--demo" in sys.argv or "--reset" in sys.argv:
            demo.run(conn)
    print("Seed done.")


if __name__ == "__main__":
    main()
