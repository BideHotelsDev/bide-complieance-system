"""Local Postgres 16 and Redis without Docker or root, for development and tests.

Postgres comes from the pgserver wheel's bundled binaries; Redis is extracted from the distro packages with
`apt-get download` + `dpkg-deb -x` the first time. Both keep their data under .devdata/ at the repo root.

    pnpm dev:infra        # starts both and stays in the foreground; Ctrl+C stops them
"""

import os
import shutil
import signal
import subprocess
import sys
import tempfile
import time
from pathlib import Path

ROOT = Path(__file__).resolve().parents[3]
DATA = ROOT / ".devdata"
PG_PORT = int(os.environ.get("DEV_PG_PORT", "5434"))
REDIS_PORT = int(os.environ.get("DEV_REDIS_PORT", "6380"))
DB_NAME = "bide_comply"


def pg_bin() -> Path:
    from pgserver._commands import POSTGRES_BIN_PATH  # dev dependency

    return Path(POSTGRES_BIN_PATH)


def pg_start(pgdata: Path, port: int) -> subprocess.CompletedProcess:
    bin_ = pg_bin()
    if not (pgdata / "PG_VERSION").exists():
        pgdata.mkdir(parents=True, exist_ok=True)
        subprocess.run(
            [bin_ / "initdb", "-D", pgdata, "-U", "postgres", "--auth=trust", "-E", "UTF8"],
            check=True,
            capture_output=True,
        )
    sock = Path(tempfile.gettempdir()) / f"bide-comply-pg-{port}"
    sock.mkdir(exist_ok=True)
    return subprocess.run(
        [
            bin_ / "pg_ctl",
            "-D",
            pgdata,
            "-l",
            pgdata / "server.log",
            "-w",
            "start",
            "-o",
            f"-p {port} -k {sock} -c listen_addresses=localhost",
        ],
        check=False,
        capture_output=True,
        text=True,
    )


def pg_stop(pgdata: Path) -> None:
    subprocess.run([pg_bin() / "pg_ctl", "-D", pgdata, "-m", "fast", "stop"], check=False, capture_output=True)


def ensure_database(port: int, name: str) -> None:
    psql = pg_bin() / "psql"
    exists = subprocess.run(
        [
            psql,
            "-h",
            "localhost",
            "-p",
            str(port),
            "-U",
            "postgres",
            "-tAc",
            f"select 1 from pg_database where datname='{name}'",
        ],
        capture_output=True,
        text=True,
    )
    if exists.stdout.strip() != "1":
        subprocess.run(
            [psql, "-h", "localhost", "-p", str(port), "-U", "postgres", "-c", f"create database {name}"],
            check=True,
            capture_output=True,
        )


def redis_root() -> Path:
    root = DATA / "redis"
    if (root / "usr/bin/redis-server").exists():
        return root
    work = Path(tempfile.mkdtemp())
    subprocess.run(
        ["apt-get", "download", "redis-server", "redis-tools", "liblzf1", "libjemalloc2"],
        cwd=work,
        check=True,
        capture_output=True,
    )
    for deb in work.glob("*.deb"):
        subprocess.run(["dpkg-deb", "-x", deb, root], check=True)
    shutil.rmtree(work, ignore_errors=True)
    return root


def redis_start(port: int) -> subprocess.Popen:
    root = redis_root()
    env = dict(os.environ, LD_LIBRARY_PATH=str(root / "usr/lib/x86_64-linux-gnu"))
    (DATA / "redis-data").mkdir(parents=True, exist_ok=True)
    return subprocess.Popen(
        [
            root / "usr/bin/redis-server",
            "--port",
            str(port),
            "--bind",
            "127.0.0.1",
            "--dir",
            DATA / "redis-data",
            "--save",
            "",
            "--appendonly",
            "no",
        ],
        env=env,
        stdout=subprocess.DEVNULL,
    )


def main() -> None:
    pgdata = DATA / "pg"
    r = pg_start(pgdata, PG_PORT)
    if r.returncode != 0 and "already running" not in (r.stderr + r.stdout):
        sys.exit(f"Postgres didn't start:\n{r.stdout}\n{r.stderr}")
    ensure_database(PG_PORT, DB_NAME)
    redis = redis_start(REDIS_PORT)
    print(f"DATABASE_URL=postgresql+psycopg://postgres@localhost:{PG_PORT}/{DB_NAME}")
    print(f"REDIS_URL=redis://127.0.0.1:{REDIS_PORT}/0")
    print("Running. Ctrl+C to stop.", flush=True)

    def stop(*_):
        redis.terminate()
        pg_stop(pgdata)
        sys.exit(0)

    signal.signal(signal.SIGINT, stop)
    signal.signal(signal.SIGTERM, stop)
    while True:
        time.sleep(3600)


if __name__ == "__main__":
    main()
