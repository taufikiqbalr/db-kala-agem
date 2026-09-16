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
  var keyRetentionGraceSeconds = daysToSeconds(numberEnv("KALA_AGEM_KEY_RETENTION_GRACE_DAYS", 7));
  var rawKeyRetentionSeconds = rawRetentionSeconds + keyRetentionGraceSeconds;
  var eventKeyRetentionSeconds = eventRetentionSeconds + keyRetentionGraceSeconds;

  print("Preparing AGEM MongoDB schema in database: " + dbName);

  function collectionInfo(name) {
    var infos = appDb.getCollectionInfos({ name: name });
    return infos.length > 0 ? infos[0] : null;
  }

  function ensureRegularCollection(name) {
    var info = collectionInfo(name);
    if (info) {
      if (info.type && info.type !== "collection") {
        throw new Error(name + " exists but is not a regular collection.");
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
      print("Retention already set on " + name + ": " + expireAfterSeconds + " seconds");
      return;
    }

    var result = appDb.runCommand({
      collMod: name,
      expireAfterSeconds: expireAfterSeconds,
    });
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
        throw new Error(
          name +
            " already exists as a regular collection. MongoDB cannot convert it to time series; migrate or recreate the volume."
        );
      }
      if (timeseries.timeField !== timeField || timeseries.metaField !== metaField) {
        throw new Error(
          name +
            " exists with different time series options. Expected timeField=" +
            timeField +
            ", metaField=" +
            metaField +
            "."
        );
      }

      print("Collection already exists: " + name + " (time series)");
      ensureTimeSeriesRetention(name, expireAfterSeconds);
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
    print(
      "Created time series collection: " +
        name +
        " timeField=" +
        timeField +
        " metaField=" +
        metaField +
        " granularity=" +
        granularity
    );
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
      print("Dropped TTL index with outdated retention on " + collection + ": " + options.name);
    }

    ensureIndex(collection, keys, options);
  }

  ensureRegularCollection("users");
  ensureRegularCollection("devices");
  ensureRegularCollection("user_devices");
  ensureRegularCollection("daily_activity");
  ensureRegularCollection("sleep_summary");
  ensureRegularCollection("wearable_syncs");
  ensureRegularCollection("total_activities");
  ensureRegularCollection("workouts");

  ensureTimeSeriesCollection("steps_15m", "ts_utc", "device_id", "minutes", rawRetentionSeconds);
  ensureTimeSeriesCollection("sleep_segments", "start_utc", "device_id", "minutes", rawRetentionSeconds);
  ensureTimeSeriesCollection("health_metrics", "ts_utc", "device_id", "seconds", rawRetentionSeconds);
  ensureTimeSeriesCollection("device_events", "ts_utc", "device_id", "seconds", eventRetentionSeconds);

  // Time series collections cannot use unique indexes. These regular key
  // collections are for the backend to preserve idempotent ingest semantics.
  ensureRegularCollection("steps_15m_keys");
  ensureRegularCollection("sleep_segments_keys");
  ensureRegularCollection("health_metric_keys");
  ensureRegularCollection("device_event_keys");

  ensureIndex("devices", { device_uid: 1 }, { unique: true, name: "uniq_device_uid" });
  ensureIndex(
    "user_devices",
    { user_id: 1, is_primary: -1, paired_at: -1 },
    { name: "idx_user_devices_user_primary_paired" }
  );
  ensureIndex(
    "sleep_summary",
    { device_id: 1, sleep_date: 1 },
    { unique: true, name: "uniq_sleep_summary_device_date" }
  );
  ensureIndex(
    "daily_activity",
    { device_id: 1, device_date: 1 },
    { unique: true, name: "uniq_daily_activity_device_date" }
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
  ensureIndex(
    "workouts",
    { device_id: 1, start_utc: 1 },
    { unique: true, name: "uniq_workouts_device_start" }
  );

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
    "health_metrics",
    { device_id: 1, metric: 1, ts_utc: 1 },
    { name: "idx_health_metrics_device_metric_ts" }
  );
  ensureIndex(
    "device_events",
    { device_id: 1, event_type: 1, ts_utc: 1 },
    { name: "idx_device_events_device_type_ts" }
  );

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

  print("AGEM MongoDB schema preparation completed.");
})();
