#!/bin/bash
set -e

if [ -z "${INIT_DB:-}" ]; then
    echo "INIT_DB is required and must contain the Docker secret name for the init script." >&2
    exit 1
fi

INIT_DB_SECRET="/run/secrets/${INIT_DB}"
if [ ! -r "$INIT_DB_SECRET" ]; then
    echo "Mongo init secret is missing or unreadable: $INIT_DB_SECRET" >&2
    exit 1
fi

mkdir -p /docker-entrypoint-initdb.d
ln -sf "$INIT_DB_SECRET" /docker-entrypoint-initdb.d/00-mongo-init.js

SCHEMA_SCRIPT="/app/src/db/kala-agem-timeseries.js"
if [ ! -r "$SCHEMA_SCRIPT" ]; then
    echo "Mongo schema script is missing or unreadable: $SCHEMA_SCRIPT" >&2
    exit 1
fi

ln -sf "$SCHEMA_SCRIPT" /docker-entrypoint-initdb.d/10-kala-agem-timeseries.js
