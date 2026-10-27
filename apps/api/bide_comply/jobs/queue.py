"""Enqueue a worker job from a request. Returns False when Redis isn't reachable, so the caller can fall back."""

import asyncio
import logging

from bide_comply.config import settings

log = logging.getLogger("bide_comply.queue")


def redis_settings():
    from arq.connections import RedisSettings

    return RedisSettings.from_dsn(settings.redis_url)


def enqueue(job: str, *args) -> bool:
    from arq import create_pool

    async def go() -> None:
        pool = await create_pool(redis_settings(), retry=0)
        try:
            await pool.enqueue_job(job, *args)
        finally:
            await pool.aclose()

    try:
        asyncio.run(go())
        return True
    except Exception as e:  # noqa: BLE001 - any connection problem means "no queue"
        log.warning("queue unavailable (%s); running %s inline", e, job)
        return False
