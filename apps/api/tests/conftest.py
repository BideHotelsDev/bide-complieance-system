"""Tests run against a throwaway Postgres database with the demo data loaded.

Locally that's the dev server from `pnpm dev:infra` (port 5434); in CI it's the Postgres service. TEST_DATABASE_URL
overrides the target. The database is recreated once per test session.
"""

import os
import uuid

TEST_DB = os.environ.get("TEST_DATABASE_URL", "postgresql+psycopg://postgres@localhost:5434/bide_comply_test")
os.environ["DATABASE_URL"] = TEST_DB
os.environ["DEV_LOGIN"] = "true"
os.environ["ENVIRONMENT"] = "development"
os.environ["STORAGE_DIR"] = "/tmp/bide-comply-test-storage"
os.environ["REDIS_URL"] = "redis://127.0.0.1:1/0"  # unreachable on purpose: jobs run inline in tests

import pytest  # noqa: E402
from fastapi.testclient import TestClient  # noqa: E402
from sqlalchemy import create_engine, text  # noqa: E402


def _recreate_database() -> None:
    base, name = TEST_DB.rsplit("/", 1)
    admin = create_engine(f"{base}/postgres", isolation_level="AUTOCOMMIT")
    with admin.connect() as c:
        c.execute(text(f"DROP DATABASE IF EXISTS {name} WITH (FORCE)"))
        c.execute(text(f"CREATE DATABASE {name}"))
    admin.dispose()


@pytest.fixture(scope="session", autouse=True)
def database():
    _recreate_database()
    import shutil
    import subprocess
    import sys

    shutil.rmtree("/tmp/bide-comply-test-storage", ignore_errors=True)
    subprocess.run([sys.executable, "-m", "alembic", "upgrade", "head"], check=True, env=os.environ.copy())
    from bide_comply.db import engine
    from bide_comply.seed import demo, reference

    with engine.begin() as conn:
        reference.run(conn)
        demo.run(conn)
    yield


@pytest.fixture(scope="session")
def app():
    from bide_comply.main import app as fastapi_app

    return fastapi_app


@pytest.fixture(scope="session")
def people(app):
    with TestClient(app) as c:
        return {p["name"]: p["id"] for p in c.get("/api/auth/dev/people").json()}


class As:
    """A signed-in test client for one person."""

    def __init__(self, app, person_id: str, client_app: str = "web"):
        self.c = TestClient(app)
        self.c.headers.update({"X-Requested-With": "bide-comply"})
        r = self.c.post("/api/auth/dev", json={"person_id": person_id, "app": client_app})
        assert r.status_code == 200, r.text

    def __getattr__(self, name):
        return getattr(self.c, name)


@pytest.fixture(scope="session")
def login(app, people):
    cache: dict[str, As] = {}

    def _login(name: str, client_app: str = "web") -> As:
        key = f"{name}:{client_app}"
        if key not in cache:
            cache[key] = As(app, people[name], client_app)
        return cache[key]

    return _login


def jpeg() -> bytes:
    import io

    from PIL import Image

    buf = io.BytesIO()
    Image.new("RGB", (64, 48), (120, 130, 140)).save(buf, "JPEG")
    # A unique pixel so duplicate-photo detection doesn't flag repeated test uploads.
    return buf.getvalue()[:-2] + uuid.uuid4().bytes[:0] + buf.getvalue()[-2:]


def upload_photo(client, property_id: str | None = None, task_id: str | None = None) -> str:
    import io

    from PIL import Image

    buf = io.BytesIO()
    Image.new("RGB", (64, 48), tuple(uuid.uuid4().bytes[:3])).save(buf, "JPEG")
    data = buf.getvalue()
    slot = client.post("/api/uploads", json={"content_type": "image/jpeg", "size": len(data), "captured_with": "camera",
                                              "property_id": property_id, "task_id": task_id}).json()
    put = client.put(slot["upload"]["url"], content=data, headers={"Content-Type": "image/jpeg"})
    assert put.status_code == 200, put.text
    done = client.post(f"/api/uploads/{slot['evidence_id']}/complete", json={"task_id": task_id})
    assert done.status_code == 200, done.text
    return slot["evidence_id"]
