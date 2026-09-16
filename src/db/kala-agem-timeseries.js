(function () {
  function env(name, fallback) {
    if (typeof process !== "undefined" && process.env && process.env[name]) {
      return process.env[name];
    }
    if (typeof _getEnv === "function") {
      var value = _getEnv(name);
      if (value) {
        return value;
      }
    }
    return fallback;
  }

  function numberEnv(name, fallback) {
    var raw = env(name, "");
    if (raw === "") {
      return fallback;
    }
    var value = Number(raw);
    if (!isFinite(value) || value < 0) {
      throw new Error(name + " must be a non-negative number.");
    }
    return value;
  }

  function daysToSeconds(days) {
    return Math.round(days * 24 * 60 * 60);
  }

  var dbName = env("KALA_AGEM_DB", env("MONGO_INITDB_DATABASE", "regene_kalaagem"));
  var appDb = db.getSiblingDB(dbName);
  var rawRetentionSeconds = daysToSeconds(numberEnv("KALA_AGEM_RAW_RETENTION_DAYS", 365));
  var eventRetentionSeconds = daysToSeconds(numberEnv("KALA_AGEM_EVENT_RETENTION_DAYS", 90));
  var rawSensorRetentionSeconds = daysToSeconds(numberEnv("KALA_AGEM_RAW_SENSOR_RETENTION_DAYS", 30));
  var keyRetentionGraceSeconds = daysToSeconds(numberEnv("KALA_AGEM_KEY_RETENTION_GRACE_DAYS", 7));
  var rawKeyRetentionSeconds = rawRetentionSeconds + keyRetentionGraceSeconds;
  var eventKeyRetentionSeconds = eventRetentionSeconds + keyRetentionGraceSeconds;
  var rawSensorKeyRetentionSeconds = rawSensorRetentionSeconds + keyRetentionGraceSeconds;

  print("Preparing AGEM/QRing v3 MongoDB schema in database: " + dbName);

  function collectionInfo(name) {
    var infos = appDb.getCollectionInfos({ name: name });
    return infos.length > 0 ? infos[0] : null;
  }

  function ensureRegularCollection(name) {
    var info = collectionInfo(name);
    if (info) {
      var options = info.options || {};
      if (options.timeseries || options.timeSeries) {
        throw new Error(name + " exists as a time-series collection; expected regular collection.");
      }
      print("Collection already exists: " + name + " (regular)");
      return;
    }
    appDb.createCollection(name);
    print("Created regular collection: " + name);
  }

  function ensureTimeSeriesRetention(name, expireAfterSeconds) {
    if (!expireAfterSeconds || expireAfterSeconds <= 0) {
      return;
    }
    var info = collectionInfo(name);
    var current = info && info.options ? info.options.expireAfterSeconds : undefined;
    if (current === expireAfterSeconds) {
      return;
    }
    var result = appDb.runCommand({ collMod: name, expireAfterSeconds: expireAfterSeconds });
    if (!result.ok) {
      throw new Error("Failed to set retention on " + name + ": " + tojson(result));
    }
    print("Set retention on " + name + ": " + expireAfterSeconds + " seconds");
  }

  function ensureTimeSeriesCollection(name, timeField, metaField, granularity, expireAfterSeconds) {
    var info = collectionInfo(name);
    if (info) {
      var options = info.options || {};
      var timeseries = options.timeseries || options.timeSeries;
      if (!timeseries) {
        throw new Error(name + " already exists as a regular collection; migrate or recreate it as time-series.");
      }
      if (timeseries.timeField !== timeField || timeseries.metaField !== metaField) {
        throw new Error(
          name + " time-series options mismatch. Expected timeField=" + timeField + ", metaField=" + metaField
        );
      }
      ensureTimeSeriesRetention(name, expireAfterSeconds);
      print("Collection already exists: " + name + " (time-series)");
      return;
    }

    var createOptions = {
      timeseries: {
        timeField: timeField,
        metaField: metaField,
        granularity: granularity,
      },
    };
    if (expireAfterSeconds && expireAfterSeconds > 0) {
      createOptions.expireAfterSeconds = expireAfterSeconds;
    }
    appDb.createCollection(name, createOptions);
    print("Created time-series collection: " + name);
  }

  function ensureIndex(collection, keys, options) {
    var name = appDb.getCollection(collection).createIndex(keys, options || {});
    print("Ensured index on " + collection + ": " + name);
  }

  function ensureTTLIndex(collection, keys, options) {
    options = options || {};
    var existing = appDb.getCollection(collection).getIndexes().filter(function (index) {
      return index.name === options.name;
    })[0];
    if (existing && existing.expireAfterSeconds !== options.expireAfterSeconds) {
      appDb.getCollection(collection).dropIndex(options.name);
      print("Dropped outdated TTL index: " + collection + "." + options.name);
    }
    ensureIndex(collection, keys, options);
  }

  // Long-lived / mutable domain collections.
  [
    "users",
    "devices",
    "user_devices",
    "daily_activity",
    "sleep_summary",
    "sleep_sessions",
    "wearable_syncs",
    "total_activities",
    "workouts",
  ].forEach(ensureRegularCollection);

  // High-volume immutable measurements.
  ensureTimeSeriesCollection("steps_15m", "ts_utc", "device_id", "minutes", rawRetentionSeconds);
  ensureTimeSeriesCollection("sleep_segments", "start_utc", "device_id", "minutes", rawRetentionSeconds);
  ensureTimeSeriesCollection("health_metrics", "ts_utc", "device_id", "seconds", rawRetentionSeconds);
  ensureTimeSeriesCollection("device_events", "ts_utc", "device_id", "seconds", eventRetentionSeconds);
  ensureTimeSeriesCollection("raw_sensor_samples", "ts_utc", "device_id", "seconds", rawSensorRetentionSeconds);

  // Legacy idempotency keys remain because v1 is still readable.
  [
    "steps_15m_keys",
    "sleep_segments_keys",
    "health_metric_keys",
    "device_event_keys",
    "health_metric_v3_keys",
    "sleep_segment_v3_keys",
    "device_event_v3_keys",
    "raw_sensor_sample_keys",
  ].forEach(ensureRegularCollection);

  // Device registry and active ownership.
  ensureIndex("devices", { device_uid: 1 }, { unique: true, name: "uniq_device_uid" });
  ensureIndex("devices", { last_seen_at: -1 }, { name: "idx_devices_last_seen_v3" });

  ensureIndex(
    "user_devices",
    { user_id: 1, is_primary: -1, paired_at: -1 },
    { name: "idx_user_devices_user_primary_paired" }
  );
  ensureIndex(
    "user_devices",
    { user_id: 1, device_id: 1 },
    {
      unique: true,
      name: "uniq_user_active_device_v3",
      partialFilterExpression: { unpaired_at: { $exists: false } },
    }
  );
  ensureIndex(
    "user_devices",
    { device_id: 1 },
    {
      unique: true,
      name: "uniq_device_active_owner_v3",
      partialFilterExpression: { unpaired_at: { $exists: false } },
    }
  );
  ensureIndex(
    "user_devices",
    { user_id: 1 },
    {
      unique: true,
      name: "uniq_user_primary_active_v3",
      partialFilterExpression: { unpaired_at: { $exists: false }, is_primary: true },
    }
  );

  // Daily summaries and snapshots.
  ensureIndex(
    "daily_activity",
    { device_id: 1, device_date: 1 },
    { unique: true, name: "uniq_daily_activity_device_date" }
  );
  ensureIndex(
    "sleep_summary",
    { device_id: 1, sleep_date: 1 },
    { unique: true, name: "uniq_sleep_summary_device_date" }
  );
  ensureIndex(
    "wearable_syncs",
    { device_uid: 1, sync_date: 1 },
    { unique: true, name: "uniq_wearable_sync_device_uid_date" }
  );
  ensureIndex(
    "wearable_syncs",
    { device_id: 1, sync_date: 1 },
    { name: "idx_wearable_sync_device_date" }
  );
  ensureIndex(
    "total_activities",
    { device_id: 1, device_date: 1, kind: 1 },
    { unique: true, name: "uniq_total_activities_device_date_kind" }
  );
  ensureIndex(
    "total_activities",
    { device_uid: 1, device_date: 1 },
    { name: "idx_total_activities_device_uid_date" }
  );

  // Sleep sessions allow main/night sleep and nap/lunch sleep on one day.
  ensureIndex(
    "sleep_sessions",
    { device_id: 1, session_id: 1 },
    { unique: true, name: "uniq_sleep_session_v3" }
  );
  ensureIndex(
    "sleep_sessions",
    { device_id: 1, sleep_date: 1, start_utc: 1 },
    { name: "idx_sleep_session_v3_device_date_start" }
  );

  // Workout sessions remain regular because they can be corrected/upserted.
  ensureIndex(
    "workouts",
    { device_id: 1, start_utc: 1 },
    { unique: true, name: "uniq_workouts_device_start" }
  );
  ensureIndex(
    "workouts",
    { device_id: 1, device_date: 1, start_utc: 1 },
    { name: "idx_workouts_v3_device_date_start" }
  );

  // Query indexes for time-series data. Unique semantics are implemented in key collections.
  ensureIndex(
    "steps_15m",
    { device_id: 1, device_date: 1, time_index: 1 },
    { name: "idx_steps_device_date_time" }
  );
  ensureIndex(
    "sleep_segments",
    { device_id: 1, sleep_date: 1, start_utc: 1 },
    { name: "idx_sleep_segments_device_date_start" }
  );
  ensureIndex(
    "sleep_segments",
    { device_id: 1, sleep_date: 1, session_id: 1, start_utc: 1 },
    { name: "idx_sleep_segment_v3_session_start" }
  );
  ensureIndex(
    "health_metrics",
    { device_id: 1, metric: 1, ts_utc: 1 },
    { name: "idx_health_metrics_device_metric_ts" }
  );
  ensureIndex(
    "health_metrics",
    { device_id: 1, device_date: 1, metric: 1, ts_utc: 1 },
    { name: "idx_health_metrics_v3_device_date_metric_ts" }
  );
  ensureIndex(
    "device_events",
    { device_id: 1, event_type: 1, ts_utc: 1 },
    { name: "idx_device_events_device_type_ts" }
  );
  ensureIndex(
    "device_events",
    { device_id: 1, device_date: 1, event_type: 1, ts_utc: 1 },
    { name: "idx_device_events_v3_device_date_type_ts" }
  );
  ensureIndex(
    "raw_sensor_samples",
    { device_id: 1, device_date: 1, session_id: 1, ts_utc: 1 },
    { name: "idx_raw_sensor_v3_device_date_session_ts" }
  );

  // Legacy keys.
  ensureIndex(
    "steps_15m_keys",
    { device_id: 1, ts_utc: 1 },
    { unique: true, name: "uniq_steps_device_ts" }
  );
  ensureTTLIndex(
    "steps_15m_keys",
    { created_at: 1 },
    { expireAfterSeconds: rawKeyRetentionSeconds, name: "ttl_steps_15m_keys_created_at" }
  );
  ensureIndex(
    "sleep_segments_keys",
    { device_id: 1, start_utc: 1 },
    { unique: true, name: "uniq_sleep_segments_device_start" }
  );
  ensureTTLIndex(
    "sleep_segments_keys",
    { created_at: 1 },
    { expireAfterSeconds: rawKeyRetentionSeconds, name: "ttl_sleep_segments_keys_created_at" }
  );
  ensureIndex(
    "health_metric_keys",
    { device_id: 1, metric: 1, ts_utc: 1, source: 1 },
    { unique: true, name: "uniq_health_metric_device_metric_ts_source" }
  );
  ensureTTLIndex(
    "health_metric_keys",
    { created_at: 1 },
    { expireAfterSeconds: rawKeyRetentionSeconds, name: "ttl_health_metric_keys_created_at" }
  );
  ensureIndex(
    "device_event_keys",
    { device_id: 1, event_type: 1, ts_utc: 1, source: 1 },
    { unique: true, name: "uniq_device_event_device_type_ts_source" }
  );
  ensureTTLIndex(
    "device_event_keys",
    { created_at: 1 },
    { expireAfterSeconds: eventKeyRetentionSeconds, name: "ttl_device_event_keys_created_at" }
  );

  // v3 keys preserve different measurement modes/sessions at identical timestamps.
  ensureIndex(
    "health_metric_v3_keys",
    { device_id: 1, metric: 1, ts_utc: 1, measurement_mode: 1, session_id: 1, source: 1 },
    { unique: true, name: "uniq_health_metric_v3" }
  );
  ensureTTLIndex(
    "health_metric_v3_keys",
    { created_at: 1 },
    { expireAfterSeconds: rawKeyRetentionSeconds, name: "ttl_health_metric_v3_keys_created_at" }
  );
  ensureIndex(
    "sleep_segment_v3_keys",
    { device_id: 1, session_id: 1, start_utc: 1 },
    { unique: true, name: "uniq_sleep_segment_v3" }
  );
  ensureTTLIndex(
    "sleep_segment_v3_keys",
    { created_at: 1 },
    { expireAfterSeconds: rawKeyRetentionSeconds, name: "ttl_sleep_segment_v3_keys_created_at" }
  );
  ensureIndex(
    "device_event_v3_keys",
    { device_id: 1, event_type: 1, ts_utc: 1, session_id: 1, source: 1 },
    { unique: true, name: "uniq_device_event_v3" }
  );
  ensureTTLIndex(
    "device_event_v3_keys",
    { created_at: 1 },
    { expireAfterSeconds: eventKeyRetentionSeconds, name: "ttl_device_event_v3_keys_created_at" }
  );
  ensureIndex(
    "raw_sensor_sample_keys",
    { device_id: 1, session_id: 1, ts_utc: 1, sample_index: 1, kind: 1 },
    { unique: true, name: "uniq_raw_sensor_sample_v3" }
  );
  ensureTTLIndex(
    "raw_sensor_sample_keys",
    { created_at: 1 },
    { expireAfterSeconds: rawSensorKeyRetentionSeconds, name: "ttl_raw_sensor_sample_keys_created_at" }
  );

  print("AGEM/QRing v3 MongoDB schema preparation completed.");
})();
