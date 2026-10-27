from collections.abc import Iterator
from typing import Annotated

from fastapi import Depends
from sqlalchemy import Connection, create_engine

from bide_comply.config import settings


def make_engine(url: str):
    # Some hosts still hand out the old "postgres://" scheme, which SQLAlchemy doesn't accept, and plain
    # "postgresql://" would pick psycopg2. Both are pointed at psycopg 3.
    for prefix in ("postgres://", "postgresql://"):
        if url.startswith(prefix):
            url = "postgresql+psycopg://" + url.removeprefix(prefix)
    # Sessions run in UTC; conversion to London time happens in code (clock.py), never in SQL.
    return create_engine(url, pool_pre_ping=True, connect_args={"options": "-c timezone=UTC"})


engine = make_engine(settings.database_url)


def get_conn() -> Iterator[Connection]:
    # One transaction per request: everything a request writes, including its audit events, commits together.
    # A handler may commit early on purpose (e.g. to keep a failed sign-in attempt counted before raising).
    with engine.connect() as conn:
        try:
            yield conn
        except Exception:
            conn.rollback()
            raise
        else:
            conn.commit()


ConnDep = Annotated[Connection, Depends(get_conn)]
