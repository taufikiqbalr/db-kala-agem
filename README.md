# db-kala-agem — QRing SDK v3 MongoDB Schema

MongoDB schema and housekeeping repository for the AGEM/QRing wearable backend.

Default database:

```text
regene_kalaagem
```

The schema is aligned with the canonical backend endpoint:

```text
POST /v3/wearable/sync
```

The v3 design stores device-local historical data explicitly and no longer treats one monolithic daily snapshot as the authoritative source. `wearable_syncs` records sync metadata/coverage while normalized collections hold the domain data.

## Design principles

1. **Device-local day is explicit.** Historical SDK data is stored with `device_date` / `sleep_date` instead of deriving a day from the latest UTC timestamp.
2. **High-volume immutable data uses MongoDB time-series collections.**
3. **Mutable summaries/sessions use regular collections.**
4. **Time-series idempotency uses separate regular key collections.**
5. **Main sleep and nap/lunch sleep are separate sessions.**
6. **Manual/one-click/automatic measurements can coexist at the same timestamp.**
7. **Raw PPG/accelerometer-like samples have shorter retention than normalized health data.**
8. **A wearable has at most one active owner and a user has at most one active primary device.**

---

# Collection inventory

| Collection | Type | Purpose |
|---|---|---|
| `users` | regular | Local fallback user identity. Canonical identity may come from Regene. |
| `devices` | regular | Device registry, metadata, capabilities, current battery/charging state. |
| `user_devices` | regular | Pairing history with explicit `active` ownership constraints. |
| `daily_activity` | regular | Device-local daily activity totals. |
| `steps_15m` | time series | 15-minute activity buckets. |
| `health_metrics` | time series | Normalized HR/SpO2/BP/HRV/stress/temperature/RRI/battery measurements. |
| `sleep_sessions` | regular | Main sleep and nap/lunch sleep sessions. |
| `sleep_segments` | time series | Sleep stage timeline segments. |
| `sleep_summary` | regular | One derived daily sleep aggregate per device/date. |
| `workouts` | regular | Sport/training sessions. |
| `device_events` | time series | Sedentary, charging, gesture, sport-status and generic events. |
| `raw_sensor_samples` | time series | Optional high-volume raw diagnostic channels. |
| `total_activities` | regular | Daily goal/target/progress rows. |
| `wearable_syncs` | regular | Per-device/day latest v3 sync metadata and coverage. |
| `steps_15m_keys` | regular | Legacy/v1 + v3 activity-bucket idempotency. |
| `health_metric_keys` | regular | Legacy v1 health idempotency. |
| `sleep_segments_keys` | regular | Legacy v1 sleep-segment idempotency. |
| `device_event_keys` | regular | Legacy v1 event idempotency. |
| `health_metric_v3_keys` | regular | v3 measurement idempotency including mode/session/source. |
| `sleep_segment_v3_keys` | regular | v3 sleep-segment idempotency per session. |
| `device_event_v3_keys` | regular | v3 event idempotency including session/source. |
| `raw_sensor_sample_keys` | regular | v3 raw-sample idempotency. |

---

# Time-series configuration

| Collection | `timeField` | `metaField` | Granularity | Default retention |
|---|---|---|---|---:|
| `steps_15m` | `ts_utc` | `device_id` | minutes | 365 days |
| `sleep_segments` | `start_utc` | `device_id` | minutes | 365 days |
| `health_metrics` | `ts_utc` | `device_id` | seconds | 365 days |
| `device_events` | `ts_utc` | `device_id` | seconds | 90 days |
| `raw_sensor_samples` | `ts_utc` | `device_id` | seconds | 30 days |

Retention environment variables:

```text
KALA_AGEM_RAW_RETENTION_DAYS=365
KALA_AGEM_EVENT_RETENTION_DAYS=90
KALA_AGEM_RAW_SENSOR_RETENTION_DAYS=30
KALA_AGEM_KEY_RETENTION_GRACE_DAYS=7
```

Key collections keep duplicate-protection state for the corresponding retention period plus the grace period.

---

# `devices`

Regular device registry. Existing v1 fields remain compatible; v3 adds capability/state fields.

| Field | Type | Required | Notes |
|---|---|---:|---|
| `_id` | ObjectId | yes | Internal AGEM device ID. |
| `device_uid` | String | yes | Stable QRing/front-end device UID. Unique. |
| `vendor` | String | yes | Defaults to `QRing` for v3 auto-registration. |
| `model` | String | no | Example: `G69`. |
| `hw_rev` | String | no | Hardware revision. |
| `fw_rev` | String | no | Firmware revision. |
| `serial_number` | String | no | Manufacturer serial. |
| `sdk_version` | String | no | Frontend SDK version, e.g. `2025-08-26`. |
| `capabilities` | Object | no | Boolean capability map reported by SDK/device. |
| `battery_percent` | Int | no | Current battery 0..100. |
| `charging` | Boolean | no | Current charging state. |
| `first_seen_at` | Date | yes | First registration/sync. |
| `last_seen_at` | Date | no | Last successful v3 sync/device state time. |
| `state_updated_at` | Date | no | Last device-state update. |
| `created_at` | Date | yes | Creation time. |
| `updated_at` | Date | yes | Last metadata update. |

Indexes:

```text
uniq_device_uid                  UNIQUE(device_uid)
idx_devices_last_seen_v3        last_seen_at DESC
```

`capabilities` is intentionally schemaless because `SetTimeRsp` and `DeviceSupportFunctionRsp` can evolve between SDK/device models.

---

# `user_devices`

Pairing history. A row remains after unpairing. The canonical ownership state is the explicit `active` Boolean; `unpaired_at` remains as audit/history metadata.

| Field | Type | Notes |
|---|---|---|
| `_id` | ObjectId | Pairing record ID. |
| `user_id` | String | Canonical Regene/AGEM user ID. |
| `device_id` | String | AGEM `devices._id` as hex string. |
| `nickname` | String | Optional UI nickname. |
| `is_primary` | Boolean | Active primary device flag. |
| `active` | Boolean | `true` while the pairing owns the device; set `false` on unpair. |
| `paired_at` | Date | Pair time. |
| `unpaired_at` | Date | Audit timestamp written on unpair. |

Indexes:

```text
idx_user_devices_user_primary_paired
uniq_user_active_device_v3   UNIQUE(user_id, device_id) WHERE active=true
uniq_device_active_owner_v3  UNIQUE(device_id)          WHERE active=true
uniq_user_primary_active_v3  UNIQUE(user_id)            WHERE active=true AND is_primary=true
```

MongoDB partial indexes are intentionally based on equality (`active: true`), not `$exists:false`. During schema preparation, legacy rows are backfilled as follows:

```text
unpaired_at missing -> active=true
unpaired_at present -> active=false, is_primary=false
```

Migration note: if an existing deployment already contains multiple active owners for one device or multiple active primary devices for one user, resolve those duplicates before creating the unique partial indexes.

---

# `daily_activity`

One mutable summary per device-local date.

| Field | Type | Notes |
|---|---|---|
| `device_id` | String | AGEM device ID. |
| `device_date` | String | Device-local `YYYY-MM-DD`. |
| `tz_offset_min` | Int | Offset used when synced. |
| `total_steps` | Int | Daily total steps. |
| `running_steps` | Int | Daily running/aerobic steps. |
| `calories` | Int | Legacy compatibility; v3 writes the SDK raw calorie integer. |
| `calories_raw` | Int | Exact raw SDK integer. |
| `calories_kcal` | Double | Optional normalized kcal supplied by frontend. |
| `walk_distance_m` | Int | Distance in meters. |
| `sport_duration_s` | Int | Activity duration in seconds. |
| `sleep_duration_s` | Int | Daily sleep duration value from SDK daily total, seconds. |
| `source` | String | Usually `qring_sdk_v3`. |
| `synced_at` | Date | Last update. |

Unique key:

```text
device_id + device_date
```

The backend does not invent a calorie scaling rule. Preserve raw SDK values and optionally supply normalized kcal separately.

---

# `steps_15m`

Time-series representation of `BleStepDetails`.

```js
{
  timeseries: {
    timeField: "ts_utc",
    metaField: "device_id",
    granularity: "minutes"
  }
}
```

| Field | Type | Notes |
|---|---|---|
| `device_id` | String | Meta field. |
| `ts_utc` | Date | UTC instant corresponding to local bucket. |
| `device_date` | String | Explicit local date. |
| `time_index` | Int | `0..95`, 15-minute bucket. |
| `tz_offset_min` | Int | Device offset. |
| `walk_steps` | Int | Walking steps. |
| `run_steps` | Int | Running steps. |
| `calories` | Int | Legacy raw calorie field. |
| `calories_raw` | Int | Explicit raw SDK calorie value. |
| `calories_kcal` | Double | Optional normalized kcal. |
| `distance_m` | Int | Distance meters. |
| `sport_duration_s` | Int | Optional active duration when available from frontend-derived detail. |
| `source` | String | Ingest source. |
| `synced_at` | Date | Server ingest time. |

Query index:

```text
device_id + device_date + time_index
```

Daily UI grouping must use `device_date`, not UTC `$dateTrunc`.

---

# `health_metrics`

Flexible normalized health-measurement time series.

| Field | Type | Notes |
|---|---|---|
| `device_id` | String | Meta field. |
| `device_date` | String | Explicit local day. |
| `tz_offset_min` | Int | Device offset. |
| `ts_utc` | Date | Measurement instant. |
| `metric` | String | `heart_rate`, `spo2`, `blood_pressure`, `hrv`, `stress`, `temperature`, `rri`, `battery_level`, etc. |
| `value` | Double | Main normalized scalar. |
| `values` | Object | Multi-value normalized reading. |
| `raw_value` | Double | Original SDK raw scalar. |
| `raw_values` | Object | Original multi-channel values. |
| `unit` | String | Unit. |
| `measurement_mode` | String | `automatic`, `history_sync`, `manual`, `one_click`, `realtime`, `derived`, etc. |
| `session_id` | String | Correlation ID for one measurement session. |
| `sample_interval_s` | Int | Original interval if known. |
| `error_code` | Int | SDK measurement error/status. |
| `derived` | Boolean | Calculated vs directly measured. |
| `algorithm` | String | Derivation algorithm when applicable. |
| `source` | String | Source namespace. |
| `metadata` | Object | Vendor/model-specific fields. |
| `synced_at` | Date | Server ingest time. |

Example SpO2 hourly min/max:

```js
{
  metric: "spo2",
  values: { min: 95, max: 98 },
  unit: "%",
  measurement_mode: "history_sync",
  sample_interval_s: 3600
}
```

Example blood pressure:

```js
{
  metric: "blood_pressure",
  values: { systolic: 118, diastolic: 76, heart_rate: 72 },
  unit: "mmHg",
  measurement_mode: "manual",
  derived: false
}
```

v3 idempotency key:

```text
device_id + metric + ts_utc + measurement_mode + session_id + source
```

This intentionally allows automatic and manual measurements at the same timestamp.

---

# `sleep_sessions`

Regular collection for each sleep episode.

| Field | Type | Notes |
|---|---|---|
| `device_id` | String | Device. |
| `sleep_date` | String | Day bucket assigned by frontend/SDK sync. |
| `tz_offset_min` | Int | Device offset. |
| `session_id` | String | Stable session key. Generated from date/type/start if omitted. |
| `session_type` | String | `main`, `nap`, etc. |
| `protocol` | String | `legacy`, `new_sleep_protocol`, etc. |
| `start_utc` | Date | Session start. |
| `end_utc` | Date | Session end. |
| `total_sleep_s` | Int | Deep+light+REM when derived from segments. |
| `deep_s` | Int | Deep sleep. |
| `light_s` | Int | Light sleep. |
| `rem_s` | Int | REM. |
| `awake_s` | Int | Awake. |
| `waking_count` | Int | Wake episodes. |
| `stage_data` | Array<Int> | Optional legacy stage array. |
| `metadata` | Object | SDK details. |
| `source` | String | Source. |
| `synced_at` | Date | Sync time. |
| `created_at` / `updated_at` | Date | Lifecycle. |

Unique:

```text
device_id + session_id
```

This collection solves the old one-sleep-row-per-day limitation and supports both main and lunch/nap sleep.

---

# `sleep_segments`

Time-series stage timeline.

| Field | Type | Notes |
|---|---|---|
| `device_id` | String | Meta field. |
| `sleep_date` | String | Day bucket. |
| `tz_offset_min` | Int | Offset. |
| `session_id` | String | Parent sleep session. |
| `protocol` | String | Sleep protocol. |
| `start_utc` | Date | Time field. |
| `end_utc` | Date | Segment end. |
| `stage_code` | Int | Original SDK stage code when supplied. |
| `stage` | String | Normalized `deep`, `light`, `rem`, `awake`, `off_wrist`, etc. |
| `source` | String | Source. |
| `synced_at` | Date | Sync time. |

v3 idempotency:

```text
device_id + session_id + start_utc
```

---

# `sleep_summary`

Daily aggregate derived from all `sleep_sessions` for the same device/date.

Additional v3 fields:

```text
waking_count
sessions_count
```

The backend refreshes this row after sleep-session sync. A nap therefore augments the daily summary instead of overwriting main sleep.

---

# `workouts`

Regular upsertable collection matching QRing `SportPlusEntity` semantics.

Important fields:

```text
device_id
device_date
start_utc
end_utc
tz_offset_min
sport_type_id
sport_type_name
duration_s
distance_m
calories
avg_hr / min_hr / max_hr
avg_speed_cm_s / max_speed_cm_s
elevation_cm
uphill_cm / downhill_cm
avg_cadence_spm
sport_count
steps
locations[].rate_real
status
metadata
source
synced_at
```

Unique key remains:

```text
device_id + start_utc
```

---

# `device_events`

Time-series non-measurement events.

v3 fields:

```text
device_id
device_date
tz_offset_min
ts_utc
event_type
session_id
source
payload
synced_at
```

Suitable `event_type` values include:

```text
sedentary
charging_state
touch
gesture
sport_status
device_notify
not_wearing
```

v3 idempotency:

```text
device_id + event_type + ts_utc + session_id + source
```

---

# `raw_sensor_samples`

Short-retention diagnostic time series for raw PPG / accelerometer / vendor channels.

| Field | Type | Notes |
|---|---|---|
| `device_id` | String | Meta field. |
| `device_date` | String | Local day. |
| `tz_offset_min` | Int | Offset. |
| `ts_utc` | Date | Sample timestamp. |
| `session_id` | String | Manual/raw-session correlation. |
| `sample_index` | Int | Order within a timestamp/session. |
| `kind` | String | e.g. `ppg_accelerometer`. |
| `channels` | Object | Flexible numeric map. |
| `metadata` | Object | Optional SDK metadata. |
| `source` | String | Usually `qring_sdk_v3`. |
| `synced_at` | Date | Ingest time. |

The schema deliberately does not invent a formula for SDK `L/H` raw fields. Persist the original numeric channels unless the vendor definition for bit assembly is explicitly known.

Default TTL: **30 days**.

---

# `total_activities`

Daily target/progress records. v3 supports all QRing goal categories rather than only the first three positions.

Recommended kinds:

```text
steps
calories
distance
sport_duration
sleep_duration
```

Fields:

```text
device_id
device_uid
device_date
kind
index
value
target
unit
source
synced_at
```

Unique:

```text
device_id + device_date + kind
```

---

# `wearable_syncs`

v3 uses this as **sync metadata**, not as the source of truth for historical sensor arrays.

Typical v3 document:

```js
{
  device_id: "...",
  device_uid: "AA:BB:CC:DD:EE:FF",
  sync_date: "2026-09-16",
  tz_offset_min: 420,
  last_sync_id: "...",
  source: "qring_sdk_v3",
  coverage: {
    daily_activity: true,
    activity_buckets: 96,
    measurements: 120,
    sleep_sessions: 2,
    sleep_segments: 24,
    targets: 5,
    workouts: 1,
    events: 3,
    raw_samples: 0
  },
  received_at: ISODate(...),
  created_at: ISODate(...),
  updated_at: ISODate(...)
}
```

Unique:

```text
device_uid + sync_date
```

Legacy documents may still contain the old nested `payload`. Housekeeping continues pruning old nested raw arrays for safe migration, but new v3 clients read normalized collections.

---

# Date/time conventions

| Concept | Storage |
|---|---|
| Actual instant | UTC BSON `Date` |
| Device-local day | `YYYY-MM-DD` string |
| Device offset | `tz_offset_min` integer |
| 15-minute activity slot | `time_index` `0..95` |
| Measurement history array position | converted by frontend to `ts` or `minuteOfDay` |

Do not group daily wearable data by UTC midnight. Use `device_date` / `sleep_date`.

Example Jakarta:

```text
2026-09-17 00:00 +07:00
= 2026-09-16 17:00Z
```

Both values describe the same instant; the device-local grouping date is still `2026-09-17`.

---

# Initialization

Mongo image initialization links:

```text
/docker-entrypoint-initdb.d/00-mongo-init.js
/docker-entrypoint-initdb.d/10-kala-agem-timeseries.js
```

The schema script is idempotent for existing compatible collections/indexes.

Backend startup also executes:

```go
EnsureIndexes(ctx)
EnsureSDKV3Schema(ctx)
```

so the backend validates/creates the runtime schema when connecting to an existing environment.

---

# Housekeeping

`src/prepare_db.py` applies:

- creates/validates all regular and time-series collections used by v1/v3
- backfills the explicit `user_devices.active` flag from legacy `unpaired_at` history
- applies active-owner/primary unique partial indexes using equality filters
- applies `collMod` retention to time-series collections
- applies TTL indexes to legacy and v3 key collections
- applies 30-day raw-sensor retention
- prunes legacy `wearable_syncs.payload.*.readings` arrays for pre-overhaul documents

It does not delete long-lived summaries, sessions, workouts, devices, or pairings.

---

# Deployment compatibility

This schema is backward-readable with the old v1 collections, but v3 adds fields and collections. Existing v1 code can ignore extra BSON fields.

Potential migration blockers:

```text
uniq_user_active_device_v3
uniq_device_active_owner_v3
uniq_user_primary_active_v3
```

If old data violates those ownership rules, clean the duplicate active pairing records before creating the indexes. Schema preparation automatically derives `active` from existing `unpaired_at` values, but it intentionally does not guess how to resolve conflicting ownership.

---

# Product/SDK scope

The supplied G69 product specification lists heart rate, SpO2, body temperature, step counting, all-day sleep, HRV, female cycle, sedentary reminder, many sport modes, and AI health-monitoring/report features.

The supplied Android AAR additionally exposes generic SDK capabilities such as blood pressure, stress, one-click measurement, raw PPG-related values, device capability flags, battery/charging, and other optional model-dependent functions.

The database therefore stores capability flags dynamically and only persists a measurement when the frontend actually receives it from the device/SDK. Capability support must never be inferred from using the QRing SDK alone.

A dedicated female-cycle or AI-report schema is intentionally not invented here because the supplied SDK documentation does not expose a sufficiently explicit canonical payload for those product-level features.
