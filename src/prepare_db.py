#!/usr/bin/env python3
# -*- coding: utf-8 -*-

import os
import time
from datetime import datetime, timedelta, timezone
from urllib.parse import parse_qsl, quote, urlencode, urlsplit, urlunsplit

from pymongo import ASCENDING, MongoClient
from pymongo.errors import OperationFailure


SECONDS_PER_DAY = 24 * 60 * 60

RAW_TIME_SERIES_COLLECTIONS = (
    ("steps_15m", "KALA_AGEM_RAW_RETENTION_DAYS", 365),
    ("sleep_segments", "KALA_AGEM_RAW_RETENTION_DAYS", 365),
    ("health_metrics", "KALA_AGEM_RAW_RETENTION_DAYS", 365),
    ("device_events", "KALA_AGEM_EVENT_RETENTION_DAYS", 90),
    ("raw_sensor_samples", "KALA_AGEM_RAW_SENSOR_RETENTION_DAYS", 30),
)

KEY_COLLECTIONS = (
    ("steps_15m_keys", "ttl_steps_15m_keys_created_at", "KALA_AGEM_RAW_RETENTION_DAYS", 365),
    ("sleep_segments_keys", "ttl_sleep_segments_keys_created_at", "KALA_AGEM_RAW_RETENTION_DAYS", 365),
    ("health_metric_keys", "ttl_health_metric_keys_created_at", "KALA_AGEM_RAW_RETENTION_DAYS", 365),
    ("device_event_keys", "ttl_device_event_keys_created_at", "KALA_AGEM_EVENT_RETENTION_DAYS", 90),
    ("health_metric_v3_keys", "ttl_health_metric_v3_keys_created_at", "KALA_AGEM_RAW_RETENTION_DAYS", 365),
    ("sleep_segment_v3_keys", "ttl_sleep_segment_v3_keys_created_at", "KALA_AGEM_RAW_RETENTION_DAYS", 365),
    ("device_event_v3_keys", "ttl_device_event_v3_keys_created_at", "KALA_AGEM_EVENT_RETENTION_DAYS", 90),
    ("raw_sensor_sample_keys", "ttl_raw_sensor_sample_keys_created_at", "KALA_AGEM_RAW_SENSOR_RETENTION_DAYS", 30),
)

# Legacy v3 snapshots created before the SDK-aligned overhaul may contain large
# nested raw arrays. New v3 writes normalized collections and only keeps sync
# metadata in wearable_syncs, but this prune remains for safe migration.
SNAPSHOT_READING_FIELDS = (
    "payload.hrv.readings",
    "payload.heartRate.readings",
    "payload.spo2.readings",
    "payload.temperature.readings",
    "payload.stress.readings",
    "payload.activity.readings",
    "payload.sleep.segments",
    "payload.bloodPressure.readings",
)


def read_text_file(path):
    if not path:
        return ""
    try:
        with open(path, "r", encoding="utf-8") as handle:
            return handle.read().strip()
    except FileNotFoundError:
        return ""


def read_secret(name_or_path):
    value = (name_or_path or "").strip()
    if not value:
        return ""
    if os.path.isabs(value):
        return read_text_file(value)
    return read_text_file(os.path.join("/run/secrets", value))


def parse_env_content(raw):
    values = {}
    for line in raw.splitlines():
        line = line.strip()
        if not line or line.startswith("#") or (line.startswith("[") and line.endswith("]")):
            continue
        if "=" not in line:
            continue
        key, value = line.split("=", 1)
        values[key.strip()] = value.strip().strip("\"'")
    return values


def extract_mongo_uri(raw):
    raw = (raw or "").strip()
    if raw.startswith(("mongodb://", "mongodb+srv://")):
        return raw
    values = parse_env_content(raw)
    return (values.get("MONGODB_URI") or values.get("MONGO_URI") or "").strip()


def configured_mongo_uri():
    uri = (os.getenv("MONGODB_URI") or os.getenv("MONGO_URI") or "").strip()
    if uri:
        return uri

    for key in ("MONGODB_URI_FILE", "MONGODB_SECRET_PATH"):
        uri = extract_mongo_uri(read_text_file(os.getenv(key, "").strip()))
        if uri:
            return uri

    uri = extract_mongo_uri(read_secret(os.getenv("MONGODB_URI_SECRET", "").strip()))
    if uri:
        return uri

    host = os.getenv("MONGODB_HOST", "").strip()
    port = os.getenv("MONGODB_PORT", "27017").strip()
    db_name = os.getenv("KALA_AGEM_DB", "regene_kalaagem").strip()
    if host:
        return f"mongodb://{host}:{port}/{db_name}?authSource=admin"
    return ""


def root_secret_value(secret_key, file_key):
    explicit_file = os.getenv(file_key, "").strip()
    if explicit_file:
        return read_text_file(explicit_file)
    return read_secret(os.getenv(secret_key, "").strip())


def root_mongo_uri(app_uri):
    root_user = root_secret_value("MONGODB_ROOT_USER_SECRET", "MONGODB_ROOT_USER_FILE")
    root_password = root_secret_value("MONGODB_ROOT_PASSWORD_SECRET", "MONGODB_ROOT_PASSWORD_FILE")
    if not root_user or not root_password:
        return app_uri

    parsed = urlsplit(app_uri)
    host_part = parsed.netloc.rsplit("@", 1)[-1]
    db_name = os.getenv("KALA_AGEM_DB", "regene_kalaagem").strip()
    path = parsed.path if parsed.path and parsed.path != "/" else f"/{db_name}"
    query = dict(parse_qsl(parsed.query, keep_blank_values=True))
    query["authSource"] = "admin"
    netloc = f"{quote(root_user, safe='')}:{quote(root_password, safe='')}@{host_part}"
    return urlunsplit((parsed.scheme or "mongodb", netloc, path, urlencode(query), ""))


def retention_seconds(env_name, default_days):
    raw = os.getenv(env_name, "").strip()
    days = default_days if raw == "" else float(raw)
    if days < 0:
        raise ValueError(f"{env_name} must be non-negative")
    return int(round(days * SECONDS_PER_DAY))


def key_retention_seconds(env_name, default_days):
    grace = retention_seconds("KALA_AGEM_KEY_RETENTION_GRACE_DAYS", 7)
    return retention_seconds(env_name, default_days) + grace


def wait_for_mongo(client):
    last_error = None
    for attempt in range(1, 31):
        try:
            client.admin.command("ping")
            return
        except Exception as exc:
            last_error = exc
            print(f"MongoDB is not ready yet, attempt {attempt}/30")
            time.sleep(2)
    raise SystemExit(f"MongoDB did not become ready: {last_error}")


def apply_time_series_retention(db, collection_name, expire_after_seconds):
    if expire_after_seconds <= 0:
        print(f"Retention disabled for {collection_name}")
        return
    if collection_name not in db.list_collection_names():
        print(f"Collection missing, skipping retention: {collection_name}")
        return

    db.command("collMod", collection_name, expireAfterSeconds=expire_after_seconds)
    print(f"Retention set: {collection_name} expireAfterSeconds={expire_after_seconds}")


def ensure_ttl_index(db, collection_name, index_name, expire_after_seconds):
    if expire_after_seconds <= 0:
        print(f"TTL disabled for {collection_name}.{index_name}")
        return
    if collection_name not in db.list_collection_names():
        print(f"Collection missing, skipping TTL index: {collection_name}")
        return

    collection = db[collection_name]
    existing = next((idx for idx in collection.list_indexes() if idx["name"] == index_name), None)
    if existing and existing.get("expireAfterSeconds") != expire_after_seconds:
        collection.drop_index(index_name)
        print(f"Dropped outdated TTL index: {collection_name}.{index_name}")

    collection.create_index(
        [("created_at", ASCENDING)],
        name=index_name,
        expireAfterSeconds=expire_after_seconds,
    )
    print(f"TTL index set: {collection_name}.{index_name} expireAfterSeconds={expire_after_seconds}")


def prune_legacy_snapshot_readings(db):
    retention = retention_seconds("KALA_AGEM_SNAPSHOT_READING_RETENTION_DAYS", 180)
    if retention <= 0 or "wearable_syncs" not in db.list_collection_names():
        return

    cutoff = (datetime.now(timezone.utc) - timedelta(seconds=retention)).date().isoformat()
    result = db.wearable_syncs.update_many(
        {
            "sync_date": {"$lt": cutoff},
            "$or": [{field: {"$exists": True}} for field in SNAPSHOT_READING_FIELDS],
        },
        {
            "$unset": {field: "" for field in SNAPSHOT_READING_FIELDS},
            "$set": {"payload_readings_pruned_at": datetime.now(timezone.utc)},
        },
    )
    print(
        "Legacy snapshot readings pruned: "
        f"cutoff_sync_date={cutoff} matched={result.matched_count} modified={result.modified_count}"
    )


def prepare_db():
    app_uri = configured_mongo_uri()
    if not app_uri:
        print("No MongoDB URI configured; skipping AGEM housekeeping.")
        return

    db_name = os.getenv("KALA_AGEM_DB", "regene_kalaagem").strip()
    client = MongoClient(root_mongo_uri(app_uri), serverSelectionTimeoutMS=5000)
    wait_for_mongo(client)
    db = client[db_name]

    print(f"Preparing AGEM/QRing v3 housekeeping in database: {db_name}")
    try:
        for collection_name, env_name, default_days in RAW_TIME_SERIES_COLLECTIONS:
            apply_time_series_retention(db, collection_name, retention_seconds(env_name, default_days))

        for collection_name, index_name, env_name, default_days in KEY_COLLECTIONS:
            ensure_ttl_index(db, collection_name, index_name, key_retention_seconds(env_name, default_days))

        prune_legacy_snapshot_readings(db)
    except OperationFailure as exc:
        message = exc.details.get("errmsg", str(exc)) if exc.details else str(exc)
        raise SystemExit(f"MongoDB housekeeping failed: {message}") from exc
    finally:
        client.close()

    print("AGEM/QRing v3 housekeeping completed successfully.")


prepare_db()
