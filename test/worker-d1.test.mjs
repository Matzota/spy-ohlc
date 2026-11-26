import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { Miniflare, convertV4MiniflareOptions } from "miniflare";

const openingCandle = "2020-01-02 09:30:00";
const secondCandle = "2020-01-02 10:30:00";
const providerResponse = { values: [
  { datetime: openingCandle, open: "100", high: "103", low: "100", close: "101", volume: "" },
  { datetime: secondCandle, open: "100", high: "102.75", low: "100", close: "101", volume: "1000" },
  { datetime: "2020-01-02 08:30:00", open: "100", high: "105", low: "100", close: "101", volume: "" }
] };

// This test-only entry point awaits waitUntil jobs before the test inspects D1.
const harness = `
import worker from "./worker.js";
import { monitorDataQuality } from "./data-quality.js";

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname === "/test-zero") {
      await monitorDataQuality(env, "2020-01-02 11:30:00", 100, 100, 100, 1000, 0);
      await monitorDataQuality(env, "2020-01-02 12:30:00", 100, 102, 100, 1000, 0);
      return new Response("ok");
    }

    const jobs = [];
    const ctx = { waitUntil: job => jobs.push(job) };
    if (url.pathname === "/test-scheduled") {
      const scheduledTime = Date.parse(url.searchParams.get("at"));
      const RealDate = Date;
      globalThis.Date = class extends RealDate {
        constructor(...args) {
          super(...(args.length ? args : [scheduledTime]));
        }
        static now() {
          return scheduledTime;
        }
      };
      try {
        await worker.scheduled({ scheduledTime, cron: "*/30 * * * MON-FRI" }, env, ctx);
        await Promise.all(jobs);
        return new Response(null, { status: 204 });
      } finally {
        globalThis.Date = RealDate;
      }
    }

    const response = await worker.fetch(request, env, ctx);
    await Promise.all(jobs);
    return response;
  }
};
`;

// Preview schema supplied by the project owner. This fixture is only for tests.
const qualitySchema = `
CREATE TABLE spy_data_quality (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  datetime TEXT NOT NULL,
  anomaly_type TEXT NOT NULL,
  severity TEXT NOT NULL DEFAULT 'warning'
    CHECK (severity IN ('info', 'warning', 'critical')),
  observed_value REAL,
  reference_value REAL,
  description TEXT,
  source TEXT NOT NULL DEFAULT 'Twelve Data',
  status TEXT NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'valid', 'confirmed_error')),
  detected_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  reviewed_at TEXT,
  resolution TEXT,
  UNIQUE (datetime, anomaly_type)
)`;

async function createFixture(t) {
  const requests = [];
  const modules = [{ type: "ESModule", path: "harness.js", contents: harness }];
  for (const path of ["worker.js", "data-quality.js"]) {
    modules.push({
      type: "ESModule", path,
      contents: readFileSync(new URL(`../${path}`, import.meta.url), "utf8")
    });
  }
  const runtime = new Miniflare(convertV4MiniflareOptions({
    cf: false,
    workers: [{
      name: "preview-tests",
      modules,
      compatibilityDate: "2026-11-17",
      bindings: { TWELVE_DATA_API_KEY: "test-fixture" },
      d1Databases: ["DB"],
      outboundService(request) {
        requests.push(request.url);
        const url = new URL(request.url);
        assert.equal(url.origin + url.pathname, "https://api.twelvedata.com/time_series");
        assert.equal(url.searchParams.get("symbol"), "SPY");
        assert.equal(request.headers.get("Authorization"), "apikey test-fixture");
        return Response.json(providerResponse);
      }
    }]
  }));
  t.after(() => runtime.dispose());

  const db = await runtime.getD1Database("DB");
  await db.prepare(qualitySchema).run();
  await db.prepare(`
    CREATE TABLE spy_hourly (
      datetime TEXT PRIMARY KEY,
      open REAL, high REAL, low REAL, close REAL, volume INTEGER,
      saved_at TEXT DEFAULT CURRENT_TIMESTAMP
    )
  `).run();

  const query = async sql => (await db.prepare(sql).all()).results;
  return {
    db, query, requests,
    alerts: () => query("SELECT * FROM spy_data_quality ORDER BY id"),
    candles: () => query("SELECT datetime, open, high, low, close, volume FROM spy_hourly ORDER BY datetime"),
    fetch: path => runtime.dispatchFetch(`http://localhost${path}`)
  };
}

function assertRangeAlert(row, observed, threshold) {
  assert.equal(row.anomaly_type, "unusual_hourly_range");
  assert.equal(row.observed_value, observed);
  assert.equal(row.reference_value, threshold);
  assert.equal(row.description, `Hourly price range reached or exceeded ${threshold}%.`);
}

function assertOpeningAlerts(rows) {
  assert.equal(rows.length, 2);
  for (const row of rows) {
    assert.equal(row.datetime, openingCandle);
    assert.ok(row.id > 0);
    assert.equal(row.severity, "warning");
    assert.equal(row.source, "Twelve Data");
    assert.equal(row.status, "pending");
    assert.match(row.detected_at, /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/);
    assert.equal(row.reviewed_at, null);
    assert.equal(row.resolution, null);
  }
  const [volume, range] = rows;
  assert.equal(volume.anomaly_type, "invalid_volume");
  assert.equal(volume.observed_value, null);
  assert.equal(volume.reference_value, null);
  assert.equal(volume.description, "Missing or invalid hourly volume.");
  assertRangeAlert(range, 3, 3);
}

test("local D1 enforces the preview schema and supplies its defaults", async t => {
  const { db, query, alerts } = await createFixture(t);
  assert.equal((await query("PRAGMA table_info('spy_data_quality')")).length, 12);
  await db.prepare("INSERT INTO spy_data_quality(datetime, anomaly_type) VALUES ('fixture', 'defaults')").run();
  const [row] = await alerts();
  assert.deepEqual([row.severity, row.source, row.status], ["warning", "Twelve Data", "pending"]);
  assert.match(row.detected_at, /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/);
  await assert.rejects(db.prepare("UPDATE spy_data_quality SET severity = 'bad'").run(), /CHECK constraint/);
  await assert.rejects(db.prepare("UPDATE spy_data_quality SET status = 'bad'").run(), /CHECK constraint/);
});

test("HTTP ingestion persists consistent alerts and preserves them on reprocessing", async t => {
  const fixture = await createFixture(t);
  const response = await fixture.fetch("/ohlc");
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), providerResponse);
  assert.equal(fixture.requests.length, 1);
  assert.deepEqual((await fixture.candles()).map(row => row.datetime), [openingCandle, secondCandle]);
  const original = await fixture.alerts();
  assertOpeningAlerts(original);

  const repeated = await fixture.fetch("/ohlc");
  assert.equal(repeated.status, 200);
  await repeated.json();
  assert.deepEqual(await fixture.alerts(), original);

  const zero = await fixture.fetch("/test-zero");
  assert.equal(await zero.text(), "ok");
  const rows = (await fixture.alerts()).slice(original.length);
  assert.equal(rows.length, 2);
  assertRangeAlert(rows[0], 0, 0);
  assertRangeAlert(rows[1], 2, 0);
});

test("scheduled ingestion respects New York hours and deduplicates alerts", async t => {
  const fixture = await createFixture(t);
  async function runScheduled(at) {
    const response = await fixture.fetch(`/test-scheduled?at=${encodeURIComponent(at)}`);
    assert.equal(response.status, 204);
  }

  // January timestamps below are UTC; New York is UTC−05:00.
  await runScheduled("2020-01-02T14:29:00Z"); // Thursday, 09:29 ET
  await runScheduled("2020-01-02T21:31:00Z"); // Thursday, 16:31 ET
  await runScheduled("2020-01-04T15:32:00Z"); // Saturday, 10:32 ET
  assert.equal(fixture.requests.length, 0);
  assert.deepEqual(await fixture.candles(), []);
  assert.deepEqual(await fixture.alerts(), []);

  await runScheduled("2020-01-02T15:31:00Z"); // 10:31 ET, one minute after candle close
  assert.equal(fixture.requests.length, 1);
  assert.deepEqual(await fixture.candles(), []);
  assert.deepEqual(await fixture.alerts(), []);

  await runScheduled("2020-01-02T15:32:00Z"); // 10:32 ET, two minutes after candle close
  assert.equal(fixture.requests.length, 2);
  const candles = await fixture.candles();
  assert.deepEqual(candles, [
    { datetime: openingCandle, open: 100, high: 103, low: 100, close: 101, volume: null }
  ]);
  const original = await fixture.alerts();
  assertOpeningAlerts(original);

  await runScheduled("2020-01-02T16:32:00Z"); // 11:32 ET, second candle also eligible
  assert.equal(fixture.requests.length, 3);
  const bothCandles = [
    ...candles,
    { datetime: secondCandle, open: 100, high: 102.75, low: 100, close: 101, volume: 1000 }
  ];
  assert.deepEqual(await fixture.candles(), bothCandles);
  assert.deepEqual(await fixture.alerts(), original);

  await runScheduled("2020-01-02T16:32:00Z");
  assert.equal(fixture.requests.length, 4);
  assert.deepEqual(await fixture.candles(), bothCandles);
  assert.deepEqual(await fixture.alerts(), original);
});
