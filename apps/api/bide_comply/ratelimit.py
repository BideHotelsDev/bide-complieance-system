"""Rate limits for sign-in, codes and exports, per user and per IP (§9.5).

Counts live in Redis so every API instance shares them; if Redis isn't reachable the limiter falls back to a
per-process window, which still stops a single client hammering one instance.
"""

import time
from collections import defaultdict

from fastapi import Request
from fastapi.responses import JSONResponse

from bide_comply.config import settings

# path prefix -> (requests, seconds)
RULES: list[tuple[str, tuple[int, int]]] = [
    ("/api/auth/code", (10, 600)),
    ("/api/auth/totp", (10, 600)),
    ("/api/auth/magic", (5, 900)),
    ("/api/auth/dev", (60, 60)),
    ("/api/auth/google", (30, 600)),
    ("/api/auth/refresh", (120, 600)),
    ("/api/reports/packs", (10, 3600)),
    ("/api/export", (30, 3600)),
    ("/api/privacy/export", (10, 3600)),
]

_local: dict[str, list[float]] = defaultdict(list)
_redis = None


def _client():
    global _redis
    if _redis is None:
        try:
            import redis

            _redis = redis.Redis.from_url(settings.redis_url, socket_connect_timeout=0.3, socket_timeout=0.3)
            _redis.ping()
        except Exception:  # noqa: BLE001 - no Redis: use the in-process window
            _redis = False
    return _redis or None


def _hit(key: str, limit: int, window: int) -> bool:
    r = _client()
    if r is not None:
        try:
            bucket = f"rl:{key}:{int(time.time() // window)}"
            n = r.incr(bucket)
            if n == 1:
                r.expire(bucket, window)
            return n <= limit
        except Exception:  # noqa: BLE001
            pass
    now = time.time()
    q = [t for t in _local[key] if now - t < window]
    q.append(now)
    _local[key] = q
    return len(q) <= limit


async def middleware(request: Request, call_next):
    if request.method != "GET" or request.url.path.startswith("/api/auth/google"):
        path = request.url.path
        rule = next((r for p, r in RULES if path.startswith(p)), None)
        if rule:
            ip = request.client.host if request.client else "?"
            who = request.cookies.get("bc_refresh", "")[:16] or request.cookies.get("bc_device", "")[:16]
            prefix = next(p for p, _ in RULES if path.startswith(p))
            for key in (f"ip:{ip}:{prefix}", f"who:{who}:{prefix}" if who else None):
                if key and not _hit(key, *rule):
                    return JSONResponse(
                        {"code": "rate_limited", "message": "Too many tries. Wait a few minutes and try again."},
                        status_code=429,
                        headers={"Retry-After": str(rule[1])},
                    )
    return await call_next(request)
