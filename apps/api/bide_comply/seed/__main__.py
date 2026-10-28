"""pnpm seed            reference data (lists, library, gate template, alert rules, wording, theme)
pnpm seed:demo       the above plus the demo properties, people and records
pnpm db:reset        development only: drop everything, migrate, and load the demo
--admin "Name <email>"   also make this person a Super Admin (comma-separate several)

Every run also adds the BOOTSTRAP_ADMINS while nobody is a Super Admin (seed/admins.py).
"""

import shutil
import subprocess
import sys

from sqlalchemy import text

from bide_comply.config import settings
from bide_comply.db import engine
from bide_comply.seed import admins, demo, reference


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
        admins.run(conn)
        if "--admin" in sys.argv:
            i = sys.argv.index("--admin")
            if i + 1 >= len(sys.argv):
                sys.exit('--admin needs "Name <email>".')
            admins.run(conn, sys.argv[i + 1], force=True)
    print("Seed done.")


if __name__ == "__main__":
    main()
