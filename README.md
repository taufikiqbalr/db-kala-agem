# db-kala-agem

MongoDB database service for the AGEM wearable backend. 

This database does not use SQL tables. The table equivalent is a MongoDB
collection, and each row equivalent is a BSON document.

Default application database name:

```text
regene_kalaagem
```

## Collection Types

| Collection | Type | Purpose |
| --- | --- | --- |
| `users` | Regular collection | Local AGEM fallback/cache user identity records. Canonical users can live in Regene `users`. |
| `devices` | Regular collection | Wearable device registry. |
| `user_devices` | Regular collection | User to device pairing records. |
| `steps_15m` | Time series collection | 15-minute step/activity measurements. |
| `steps_15m_keys` | Regular collection | Unique ingest keys for `steps_15m` idempotency. |
| `daily_activity` | Regular collection | Daily totals from the qring SDK `BleStepTotal` object. |
| `health_metrics` | Time series collection | Generic qring sensor readings such as heart rate, SpO2, BP, HRV, stress, temperature, and raw PPG. |
| `health_metric_keys` | Regular collection | Unique ingest keys for `health_metrics` idempotency. |
| `device_events` | Time series collection | Generic qring device notifications and raw event payloads. |
| `device_event_keys` | Regular collection | Unique ingest keys for `device_events` idempotency. |
| `sleep_summary` | Regular collection | One nightly sleep summary per device and sleep date. |
| `sleep_segments` | Time series collection | Sleep stage timeline measurements. |
| `sleep_segments_keys` | Regular collection | Unique ingest keys for `sleep_segments` idempotency. |
| `wearable_syncs` | Regular collection | Latest preserved QRing-style sync snapshot per `device_uid + sync_date`. |
| `total_activities` | Regular collection | Daily target progress rows from the sync payload `totalActivities` array. |
| `workouts` | Regular collection | Workout session records. Kept regular because the API supports patch/delete. |

## Time Series Settings

| Collection | `timeField` | `metaField` | Granularity | Notes |
| --- | --- | --- | --- | --- |
| `steps_15m` | `ts_utc` | `device_id` | `minutes` | One measurement per 15-minute device bucket. |
| `health_metrics` | `ts_utc` | `device_id` | `seconds` | Flexible sensor readings from automatic/manual qring SDK data. |
| `device_events` | `ts_utc` | `device_id` | `seconds` | Flexible device notifications and raw SDK event payloads. |
| `sleep_segments` | `start_utc` | `device_id` | `minutes` | One measurement per sleep stage segment. |

`device_id` is stable and commonly used in queries, so it is used as the
MongoDB time series `metaField`.

Important constraints:

| Constraint | Impact |
| --- | --- |
| Existing regular collections cannot be converted to time series. | The deployment switches to new `*-timeseries-data` volumes so Mongo starts with empty time series collections. |
| Time series collections cannot use unique indexes. | Idempotency should use the regular `*_keys` collections. |
| Time series measurement fields are not suitable for patch/upsert updates. | Backend writes should insert measurements and use key collections to avoid duplicates. |

## Retention And Housekeeping

Retention is enabled only for raw timestamped data and idempotency key
collections. Daily summary collections remain long-lived so API range views do
not lose historical chart data.

| Data | Collections | Default retention |
| --- | --- | --- |
| Raw wearable measurements | `steps_15m`, `sleep_segments`, `health_metrics` | 365 days |
| Raw device events | `device_events` | 90 days |
| Raw measurement idempotency keys | `steps_15m_keys`, `sleep_segments_keys`, `health_metric_keys` | 372 days |
| Device event idempotency keys | `device_event_keys` | 97 days |
| Daily summaries and snapshots | `daily_activity`, `sleep_summary`, `total_activities`, `wearable_syncs` | no TTL |
| Raw arrays preserved inside snapshots | `wearable_syncs.payload.*.readings`, `wearable_syncs.payload.sleep.segments` | pruned after 180 days |
| Identity and pairing data | `users`, `devices`, `user_devices` | no TTL |

The key collections use the raw retention plus a 7 day grace period. This keeps
duplicate protection slightly longer than the corresponding time series data.

Implementation details:

| Mechanism | Applies to |
| --- | --- |
| MongoDB time series `expireAfterSeconds` | `steps_15m`, `sleep_segments`, `health_metrics`, `device_events` |
| TTL indexes on `created_at` | `steps_15m_keys`, `sleep_segments_keys`, `health_metric_keys`, `device_event_keys` |
| Snapshot pruning update | Removes raw nested arrays from old `wearable_syncs` documents while preserving summary fields. |
| DB helper housekeeping | Applies `collMod` and TTL indexes to existing deployments during Drone deploy. |

## Type Conventions

| Type | Meaning |
| --- | --- |
| `ObjectId` | MongoDB document ID. |
| `String` | BSON string. |
| `Int32/Int64` | BSON integer. |
| `Double` | BSON floating-point number. |
| `Date` | BSON datetime stored in UTC. API input/output uses RFC3339. |
| `Boolean` | BSON boolean. |
| `Object` | Embedded BSON document. |
| `Array` | BSON array. |
| `Null` | Optional value may be missing or stored as `null`, depending on write path. |

Date strings:

| Field style | Example | Notes |
| --- | --- | --- |
| RFC3339 timestamp | `2026-05-19T08:00:00Z` | Used for UTC instants. |
| Device-local date | `2026-05-19` | Used for `device_date` and `sleep_date`. |

## users

Regular collection for local fallback user profile records. In deployed AGEM
environments, canonical user identity can be read from the Regene `users`
collection through the `nasabah_regene_*` secret. This collection remains for
local development and older AGEM-only records.

| Field | BSON type | Required | Notes |
| --- | --- | --- | --- |
| `_id` | `ObjectId` | yes | Primary document ID. API returns this as `id`. |
| `email` | `String` | no | User email. |
| `phone` | `String` | no | User phone number. |
| `created_at` | `Date` | yes | Created timestamp in UTC. |
| `updated_at` | `Date` | yes | Last updated timestamp in UTC. |

Indexes:

| Name | Fields | Unique |
| --- | --- | --- |
| `_id_` | `_id` | yes |

## devices

Regular collection for wearable device records.

| Field | BSON type | Required | Notes |
| --- | --- | --- | --- |
| `_id` | `ObjectId` | yes | Primary document ID. API returns this as `id`. |
| `vendor` | `String` | yes | Device vendor. |
| `model` | `String` | no | Device model. |
| `hw_rev` | `String` | no | Hardware revision. |
| `fw_rev` | `String` | no | Firmware revision. |
| `serial_number` | `String` | no | Manufacturer serial number. |
| `device_uid` | `String` | yes | Stable wearable identifier, for example remote ID or MAC address. |
| `first_seen_at` | `Date` | yes | First registration timestamp in UTC. |
| `last_seen_at` | `Date` | no | Last seen timestamp in UTC. |
| `created_at` | `Date` | yes | Created timestamp in UTC. |
| `updated_at` | `Date` | yes | Last updated timestamp in UTC. |

Indexes:

| Name | Fields | Unique |
| --- | --- | --- |
| `_id_` | `_id` | yes |
| `uniq_device_uid` | `device_uid` | yes |

## user_devices

Regular collection for pairings between users and devices.

| Field | BSON type | Required | Notes |
| --- | --- | --- | --- |
| `_id` | `ObjectId` | yes | Primary document ID. API returns this as `id`. |
| `user_id` | `String` | yes | User ID. When AGEM is configured with `nasabah_regene_*`, this references Regene `users._id` as a hex string. |
| `device_id` | `String` | yes | Device ID as returned by the API. |
| `nickname` | `String` | no | User-facing device nickname. |
| `is_primary` | `Boolean` | yes | Marks the primary device for a user. |
| `paired_at` | `Date` | yes | Pairing timestamp in UTC. |
| `unpaired_at` | `Date` | no | Unpairing timestamp in UTC. |

Indexes:

| Name | Fields | Unique |
| --- | --- | --- |
| `_id_` | `_id` | yes |
| `idx_user_devices_user_primary_paired` | `user_id`, `is_primary`, `paired_at` | no |

Behavior:

| Operation | Rule |
| --- | --- |
| Pair or update as primary | Other pairings for the same `user_id` should be set to `is_primary=false`. |
| Unpair | `unpaired_at` is set; the record can remain for history. |

## steps_15m

Time series collection for 15-minute step/activity measurements.

Time series options:

```js
{
  timeseries: {
    timeField: "ts_utc",
    metaField: "device_id",
    granularity: "minutes"
  }
}
```

| Field | BSON type | Required | Notes |
| --- | --- | --- | --- |
| `_id` | `ObjectId` | generated | MongoDB document ID. Time series collections do not create the normal `_id_` index. |
| `device_id` | `String` | yes | Time series `metaField`; device ID as returned by the API. |
| `ts_utc` | `Date` | yes | Time series `timeField`; UTC timestamp for the 15-minute bucket. |
| `device_date` | `String` | yes | Device-local date, `YYYY-MM-DD`. |
| `time_index` | `Int32/Int64` | yes | 15-minute slot index, usually `0..95`. |
| `tz_offset_min` | `Int32/Int64` | yes | Device timezone offset in minutes. |
| `walk_steps` | `Int32/Int64` | yes | Walking steps for the bucket. |
| `run_steps` | `Int32/Int64` | yes | Running steps for the bucket. |
| `calories` | `Int32/Int64` | yes | Calories for the bucket. |
| `distance_m` | `Int32/Int64` | yes | Distance in meters for the bucket. |
| `sport_duration_s` | `Int32/Int64` | no | Active duration in seconds for timestamped v3 activity readings. |
| `source` | `String` | yes | Defaults to `device` when omitted. v3 activity readings use `wearable_sync_activity_reading`. |
| `synced_at` | `Date` | yes | Backend sync timestamp in UTC. |

Indexes:

| Name | Fields | Unique | Notes |
| --- | --- | --- | --- |
| MongoDB generated | `device_id`, `ts_utc` | no | Default time series meta/time index in MongoDB 6.3+. |
| `idx_steps_device_date_time` | `device_id`, `device_date`, `time_index` | no | Supports listing by device-local date. |

Daily aggregation fields:

| Output field | Calculation |
| --- | --- |
| `day_utc` | `$dateTrunc(ts_utc, day, UTC)` |
| `total_steps` | Sum of `walk_steps + run_steps`. |
| `running_steps` | Sum of `run_steps`. |
| `calories` | Sum of `calories`. |
| `distance_m` | Sum of `distance_m`. |
| `last_synced_at` | Max `synced_at` for the day. |

## steps_15m_keys

Regular support collection for idempotent step ingest.

| Field | BSON type | Required | Notes |
| --- | --- | --- | --- |
| `_id` | `ObjectId` | yes | Primary document ID. |
| `device_id` | `String` | yes | Device ID. |
| `ts_utc` | `Date` | yes | Same timestamp used by `steps_15m.ts_utc`. |
| `created_at` | `Date` | recommended | First accepted ingest timestamp. |

Indexes:

| Name | Fields | Unique |
| --- | --- | --- |
| `_id_` | `_id` | yes |
| `uniq_steps_device_ts` | `device_id`, `ts_utc` | yes |

## daily_activity

Regular collection for one qring daily activity total per device-local date.
This stores fields from `BleStepTotal` / `TodaySportDataRsp` that are not
represented by individual 15-minute step buckets.

| Field | BSON type | Required | Notes |
| --- | --- | --- | --- |
| `_id` | `ObjectId` | yes | Primary document ID. |
| `device_id` | `String` | yes | Device ID as returned by the API. |
| `device_date` | `String` | yes | Device-local date, `YYYY-MM-DD`. |
| `tz_offset_min` | `Int32/Int64` | yes | Device timezone offset in minutes. |
| `total_steps` | `Int32/Int64` | yes | Daily total steps from the device. |
| `running_steps` | `Int32/Int64` | yes | Daily running/aerobic steps. |
| `calories` | `Int32/Int64` | yes | Daily calorie total from the device. |
| `walk_distance_m` | `Int32/Int64` | yes | Daily walking distance in meters. |
| `sport_duration_s` | `Int32/Int64` | yes | Movement duration in seconds. |
| `sleep_duration_s` | `Int32/Int64` | yes | Sleep duration in seconds when supplied by the device daily total. |
| `source` | `String` | yes | Defaults to `device` when omitted. v3 daily activity summaries use `wearable_sync`. |
| `synced_at` | `Date` | yes | Backend sync timestamp in UTC. |

Indexes:

| Name | Fields | Unique |
| --- | --- | --- |
| `_id_` | `_id` | yes |
| `uniq_daily_activity_device_date` | `device_id`, `device_date` | yes |

## health_metrics

Time series collection for qring sensor data that is not already modeled by
steps, sleep, or workouts. It is intentionally flexible so the Android side can
store automatic readings, manual readings, one-click measurements, and raw SDK
packets without a schema change for every vendor class.

Time series options:

```js
{
  timeseries: {
    timeField: "ts_utc",
    metaField: "device_id",
    granularity: "seconds"
  }
}
```

| Field | BSON type | Required | Notes |
| --- | --- | --- | --- |
| `_id` | `ObjectId` | generated | MongoDB document ID. |
| `device_id` | `String` | yes | Time series `metaField`; device ID as returned by the API. |
| `ts_utc` | `Date` | yes | Time series `timeField`; measurement timestamp in UTC. |
| `metric` | `String` | yes | Metric name, for example `heart_rate`, `spo2`, `blood_oxygen`, `blood_pressure`, `hrv`, `stress`, `temperature`, `rri`, `raw_ppg`, or `battery_level`. |
| `value` | `Double` or `Null` | no | Scalar reading, such as heart rate or SpO2. |
| `values` | `Object` | no | Multi-value numeric reading, such as `{systolic, diastolic, heart_rate}`, `{average, min, max, readings_count}`, or raw PPG channel values. |
| `unit` | `String` | no | Measurement unit, for example `bpm`, `%`, `mmHg`, `celsius`, or `ms`. |
| `source` | `String` | yes | Defaults to `device` when omitted. v3 summary points use `wearable_sync`; v3 raw readings use `wearable_sync_reading`. |
| `metadata` | `Object` | no | SDK-specific details such as class name, offset, range, time index, or quality flags. |
| `synced_at` | `Date` | yes | Backend sync timestamp in UTC. |

Indexes:

| Name | Fields | Unique | Notes |
| --- | --- | --- | --- |
| MongoDB generated | `device_id`, `ts_utc` | no | Default time series meta/time index in MongoDB 6.3+. |
| `idx_health_metrics_device_metric_ts` | `device_id`, `metric`, `ts_utc` | no | Supports listing one metric by time range. |

## health_metric_keys

Regular support collection for idempotent health metric ingest.

| Field | BSON type | Required | Notes |
| --- | --- | --- | --- |
| `_id` | `ObjectId` | yes | Primary document ID. |
| `device_id` | `String` | yes | Device ID. |
| `metric` | `String` | yes | Same metric name used by `health_metrics.metric`. |
| `ts_utc` | `Date` | yes | Same timestamp used by `health_metrics.ts_utc`. |
| `source` | `String` | yes | Source namespace for idempotency. |
| `created_at` | `Date` | recommended | First accepted ingest timestamp. |

Indexes:

| Name | Fields | Unique |
| --- | --- | --- |
| `_id_` | `_id` | yes |
| `uniq_health_metric_device_metric_ts_source` | `device_id`, `metric`, `ts_utc`, `source` | yes |

## device_events

Time series collection for qring notifications and events that are not direct
health measurements. Examples include battery notifications, touch events,
sedentary state changes, and raw `DeviceNotifyRsp` payloads.

Time series options:

```js
{
  timeseries: {
    timeField: "ts_utc",
    metaField: "device_id",
    granularity: "seconds"
  }
}
```

| Field | BSON type | Required | Notes |
| --- | --- | --- | --- |
| `_id` | `ObjectId` | generated | MongoDB document ID. |
| `device_id` | `String` | yes | Time series `metaField`; device ID as returned by the API. |
| `ts_utc` | `Date` | yes | Time series `timeField`; event timestamp in UTC. |
| `event_type` | `String` | yes | Event namespace, for example `battery`, `touch`, `sedentary`, or `device_notify`. |
| `source` | `String` | yes | Defaults to `device` when omitted. |
| `payload` | `Object` | no | Raw or normalized SDK payload. |
| `synced_at` | `Date` | yes | Backend sync timestamp in UTC. |

Indexes:

| Name | Fields | Unique | Notes |
| --- | --- | --- | --- |
| MongoDB generated | `device_id`, `ts_utc` | no | Default time series meta/time index in MongoDB 6.3+. |
| `idx_device_events_device_type_ts` | `device_id`, `event_type`, `ts_utc` | no | Supports listing one event type by time range. |

## device_event_keys

Regular support collection for idempotent device event ingest.

| Field | BSON type | Required | Notes |
| --- | --- | --- | --- |
| `_id` | `ObjectId` | yes | Primary document ID. |
| `device_id` | `String` | yes | Device ID. |
| `event_type` | `String` | yes | Same event type used by `device_events.event_type`. |
| `ts_utc` | `Date` | yes | Same timestamp used by `device_events.ts_utc`. |
| `source` | `String` | yes | Source namespace for idempotency. |
| `created_at` | `Date` | recommended | First accepted ingest timestamp. |

Indexes:

| Name | Fields | Unique |
| --- | --- | --- |
| `_id_` | `_id` | yes |
| `uniq_device_event_device_type_ts_source` | `device_id`, `event_type`, `ts_utc`, `source` | yes |

## sleep_summary

Regular collection for nightly sleep summary records.

| Field | BSON type | Required | Notes |
| --- | --- | --- | --- |
| `_id` | `ObjectId` | yes | Primary document ID. |
| `device_id` | `String` | yes | Device ID as returned by the API. |
| `sleep_date` | `String` | yes | Device-local sleep date, `YYYY-MM-DD`. |
| `tz_offset_min` | `Int32/Int64` | yes | Device timezone offset in minutes. |
| `sleep_start_utc` | `Date` or `Null` | no | Optional sleep start timestamp in UTC. |
| `wake_utc` | `Date` or `Null` | no | Optional wake timestamp in UTC. |
| `total_sleep_s` | `Int32/Int64` | yes | Total sleep duration in seconds. |
| `deep_s` | `Int32/Int64` | yes | Deep sleep duration in seconds. |
| `light_s` | `Int32/Int64` | yes | Light sleep duration in seconds. |
| `awake_s` | `Int32/Int64` | yes | Awake duration in seconds. |
| `rem_s` | `Int32/Int64` | yes | REM duration in seconds. |
| `score` | `Int32/Int64` | no | Sleep score from the QRing-style sync payload. |
| `stage_data` | `Array<Int32/Int64>` | no | Raw stage code array when no per-stage timestamps are available. |
| `source` | `String` | yes | Defaults to `device` when omitted. v3 sleep summaries use `wearable_sync`. |
| `synced_at` | `Date` | yes | Backend sync timestamp in UTC. |

Indexes:

| Name | Fields | Unique |
| --- | --- | --- |
| `_id_` | `_id` | yes |
| `uniq_sleep_summary_device_date` | `device_id`, `sleep_date` | yes |

## sleep_segments

Time series collection for sleep stage timeline measurements.

Time series options:

```js
{
  timeseries: {
    timeField: "start_utc",
    metaField: "device_id",
    granularity: "minutes"
  }
}
```

| Field | BSON type | Required | Notes |
| --- | --- | --- | --- |
| `_id` | `ObjectId` | generated | MongoDB document ID. Time series collections do not create the normal `_id_` index. |
| `device_id` | `String` | yes | Time series `metaField`; device ID as returned by the API. |
| `start_utc` | `Date` | yes | Time series `timeField`; segment start timestamp in UTC. |
| `end_utc` | `Date` | yes | Segment end timestamp in UTC. |
| `sleep_date` | `String` | yes | Device-local sleep date, `YYYY-MM-DD`. |
| `tz_offset_min` | `Int32/Int64` | yes | Device timezone offset in minutes. |
| `stage` | `String` | yes | Defaults to `unknown` when omitted. |
| `source` | `String` | yes | Defaults to `device` when omitted. v3 timestamped sleep segments use `wearable_sync_sleep_segment`. |
| `synced_at` | `Date` | yes | Backend sync timestamp in UTC. |

Stage values by convention:

```text
deep, light, rem, awake, off_wrist, unknown
```

Indexes:

| Name | Fields | Unique | Notes |
| --- | --- | --- | --- |
| MongoDB generated | `device_id`, `start_utc` | no | Default time series meta/time index in MongoDB 6.3+. |
| `idx_sleep_segments_device_date_start` | `device_id`, `sleep_date`, `start_utc` | no | Supports listing by sleep date. |

## sleep_segments_keys

Regular support collection for idempotent sleep segment ingest.

| Field | BSON type | Required | Notes |
| --- | --- | --- | --- |
| `_id` | `ObjectId` | yes | Primary document ID. |
| `device_id` | `String` | yes | Device ID. |
| `start_utc` | `Date` | yes | Same timestamp used by `sleep_segments.start_utc`. |
| `created_at` | `Date` | recommended | First accepted ingest timestamp. |

Indexes:

| Name | Fields | Unique |
| --- | --- | --- |
| `_id_` | `_id` | yes |
| `uniq_sleep_segments_device_start` | `device_id`, `start_utc` | yes |

## wearable_syncs

Regular collection for preserved v3 wearable sync snapshots. It stores only the
recognized QRing-style sections, keeping the frontend/device nested shape for
range reads while normalized records are written to other collections.

| Field | BSON type | Required | Notes |
| --- | --- | --- | --- |
| `_id` | `ObjectId` | yes | Primary document ID. |
| `device_id` | `String` | yes | Device ID as returned by the API. |
| `device_uid` | `String` | yes | Stable wearable identifier from `deviceUid` / `device_uid`. |
| `sync_date` | `String` | yes | Derived device sync date, `YYYY-MM-DD`. |
| `payload` | `Object` | yes | Recognized nested sync payload sections. |
| `payload.tzOffsetMin` | `Int32/Int64` | no | Optional timezone offset used to derive date buckets for timestamped activity readings. |
| `payload.hrv` | `Object` | no | HRV snapshot fields: `current`, `average`, `readingsCount`, `lastUpdated`. |
| `payload.heartRate` | `Object` | no | Heart-rate snapshot fields: `current`, `average`, `min`, `max`, `readingsCount`, `lastUpdated`. |
| `payload.spo2` | `Object` | no | SpO2 snapshot fields. |
| `payload.temperature` | `Object` | no | Temperature snapshot fields including optional `raw`. |
| `payload.stress` | `Object` | no | Stress snapshot fields. |
| `payload.*.readings` | `Array<Object>` | no | Optional timestamped readings preserved from HRV, heart rate, SpO2, temperature, stress, activity, and blood pressure sections. |
| `payload.activity` | `Object` | no | Activity fields: `steps`, `calories`, `distance`, `activeTime`, `lastUpdated`, optional `readings`. |
| `payload.sleep` | `Object` | no | Sleep fields including minutes, `score`, `sleepStart`, `sleepEnd`, `stageData`, and optional timestamped `segments`. |
| `payload.bloodPressure` | `Object` | no | BP fields: `systolic`, `diastolic`, `heartRate`, `measurementTime`, `lastUpdated`, optional `readings`. |
| `payload.totalActivities` | `Array<Object>` | no | Target rows in the original array order. `kind` is preserved when supplied. |
| `source` | `String` | yes | Stores `wearable_sync`. |
| `received_at` | `Date` | yes | Backend receive timestamp in UTC. |
| `created_at` | `Date` | yes | First snapshot creation timestamp. |
| `updated_at` | `Date` | yes | Last snapshot update timestamp. |

Indexes:

| Name | Fields | Unique |
| --- | --- | --- |
| `_id_` | `_id` | yes |
| `uniq_wearable_sync_device_uid_date` | `device_uid`, `sync_date` | yes |
| `idx_wearable_sync_device_date` | `device_id`, `sync_date` | no |

## total_activities

Regular collection for the v3 sync payload `totalActivities` array. The backend
maps indexes `0`, `1`, and `2` to `steps`, `calories`, and `distance`;
additional indexes are stored as `unknown_<index>`.

| Field | BSON type | Required | Notes |
| --- | --- | --- | --- |
| `_id` | `ObjectId` | yes | Primary document ID. |
| `device_id` | `String` | yes | Device ID as returned by the API. |
| `device_uid` | `String` | yes | Stable wearable identifier. |
| `device_date` | `String` | yes | Sync date, `YYYY-MM-DD`. |
| `kind` | `String` | yes | Explicit `kind` from the payload when supplied; otherwise `steps`, `calories`, `distance`, or `unknown_<index>`. |
| `index` | `Int32/Int64` | yes | Original array index. |
| `value` | `Double` or `Null` | no | Current progress value. |
| `target` | `Double` or `Null` | no | Target value. |
| `source` | `String` | yes | Stores `wearable_sync` unless overridden by a future writer. |
| `synced_at` | `Date` | yes | Backend sync timestamp in UTC. |

Indexes:

| Name | Fields | Unique |
| --- | --- | --- |
| `_id_` | `_id` | yes |
| `uniq_total_activities_device_date_kind` | `device_id`, `device_date`, `kind` | yes |
| `idx_total_activities_device_uid_date` | `device_uid`, `device_date` | no |

## workouts

Regular collection for workout session records.

This collection stays regular because the current API supports patching and
deleting workouts by `device_id + start_utc`, while MongoDB time series
collections are not a good fit for mutable measurement documents.

| Field | BSON type | Required | Notes |
| --- | --- | --- | --- |
| `_id` | `ObjectId` | yes | Primary document ID. |
| `device_id` | `String` | yes | Device ID as returned by the API. |
| `start_utc` | `Date` | yes | Workout start timestamp in UTC. |
| `end_utc` | `Date` or `Null` | no | Optional workout end timestamp in UTC. |
| `tz_offset_min` | `Int32/Int64` | yes | Device timezone offset in minutes. |
| `sport_type_id` | `Int32/Int64` or `Null` | no | Sport type identifier from device/app. |
| `duration_s` | `Int32/Int64` or `Null` | no | Workout duration in seconds. |
| `distance_m` | `Int32/Int64` or `Null` | no | Distance in meters. |
| `calories` | `Double` or `Null` | no | Calories burned. The qring `SportPlusEntity.mCalories` field is a floating-point value. |
| `avg_hr` | `Int32/Int64` or `Null` | no | Average heart rate. |
| `max_hr` | `Int32/Int64` or `Null` | no | Maximum heart rate. |
| `min_hr` | `Int32/Int64` or `Null` | no | Minimum heart rate. |
| `avg_speed_cm_s` | `Int32/Int64` or `Null` | no | Average speed in centimeters per second. |
| `max_speed_cm_s` | `Int32/Int64` or `Null` | no | Maximum speed in centimeters per second. |
| `elevation_cm` | `Int32/Int64` or `Null` | no | Average altitude/elevation in centimeters. |
| `uphill_cm` | `Int32/Int64` or `Null` | no | Cumulative climb in centimeters. |
| `downhill_cm` | `Int32/Int64` or `Null` | no | Cumulative downhill in centimeters. |
| `avg_cadence_spm` | `Int32/Int64` or `Null` | no | Average cadence in steps per minute. |
| `sport_count` | `Int32/Int64` or `Null` | no | Exercise count from the SDK record. |
| `steps` | `Int32/Int64` or `Null` | no | Steps inside the workout. |
| `locations` | `Array<Object>` | no | Optional workout detail samples. Current normalized field is `rate_real`. |
| `source` | `String` | yes | Defaults to `device` when omitted. |
| `synced_at` | `Date` | yes | Backend sync timestamp in UTC. |

Indexes:

| Name | Fields | Unique |
| --- | --- | --- |
| `_id_` | `_id` | yes |
| `uniq_workouts_device_start` | `device_id`, `start_utc` | yes |

## Source Values

The backend accepts source strings from API clients. Current conventions:

```text
device, derived, manual, import, wearable_sync, wearable_sync_reading,
wearable_sync_activity_reading, wearable_sync_sleep_segment
```

If `source` is omitted for wearable ingest routes, the backend stores `device`.

## Initialization Flow

The Mongo container prepares `/docker-entrypoint-initdb.d` before starting the
official Mongo entrypoint:

| Init file | Source | Purpose |
| --- | --- | --- |
| `00-mongo-init.js` | Docker secret selected by `INIT_DB` | Creates users/roles from deployment secret. |
| `10-kala-agem-timeseries.js` | Repo file `src/db/kala-agem-timeseries.js` | Creates AGEM collections, time series collections, and indexes. |

Environment:

| Variable | Default | Notes |
| --- | --- | --- |
| `KALA_AGEM_DB` | `regene_kalaagem` | Application database name used by the schema script. |
| `INIT_DB` | required | Docker secret name containing the deployment init JavaScript. |
| `KALA_AGEM_RAW_RETENTION_DAYS` | `365` | Retention for raw wearable time series data. |
| `KALA_AGEM_EVENT_RETENTION_DAYS` | `90` | Retention for raw device event time series data. |
| `KALA_AGEM_KEY_RETENTION_GRACE_DAYS` | `7` | Extra TTL grace period for idempotency key collections. |
| `KALA_AGEM_SNAPSHOT_READING_RETENTION_DAYS` | `180` | Age after which raw arrays inside `wearable_syncs` snapshots are pruned. |

Deployment ports:

| Environment | Mongo service | Published port | Active volume | Old volume |
| --- | --- | --- | --- | --- |
| test | `mongo-kala-agem-test` | `57215` | `mongo-kala-agem-test-timeseries-data` | `mongo-kala-agem-test-data` |
| dev | `mongo-kala-agem-dev` | `47215` | `mongo-kala-agem-dev-timeseries-data` | `mongo-kala-agem-dev-data` |

The schema script runs only when MongoDB initializes an empty `/data/db`.
Drone removes the old service, attempts to remove the old regular-collection
volume, and then creates the service with the new `*-timeseries-data` volume.
If Docker cannot remove the old volume because it lives on another Swarm node,
the new time series volume is still used and the old volume is left unused for
manual cleanup or rollback.
