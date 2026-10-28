#!/bin/sh
# Container entrypoint. Only the api role runs migrations, so the two services never race.
set -e

if [ "$SERVICE_ROLE" = "worker" ]; then
    exec arq bide_comply.worker.WorkerSettings
fi

# The database may not be reachable for a moment after a deploy: retry for up to a minute rather than crash.
tries=0
until alembic upgrade head; do
    tries=$((tries + 1))
    if [ "$tries" -ge 30 ]; then
        echo "database still unreachable after $tries tries; giving up" >&2
        exit 1
    fi
    echo "database not ready; retrying in 2s ($tries/30)" >&2
    sleep 2
done
# SEED_DEMO=true (staging) also loads the demo properties and people; it skips itself once they exist.
python -m bide_comply.seed ${SEED_DEMO:+--demo}
exec uvicorn bide_comply.main:app --host 0.0.0.0 --port "${PORT:-8000}" --proxy-headers --forwarded-allow-ips '*'
