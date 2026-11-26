import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";
import { monitorDataQuality } from "../data-quality.js";
import worker from "../worker.js";

const datetime = "2020-01-02 09:30:00";

function createFixture(t) {
  const sqlite = new DatabaseSync(":memory:");
  t.after(() => sqlite.close());

  // Only the columns and constraints exercised by the Worker are modeled here.
  sqlite.exec(`
    CREATE TABLE spy_data_quality (
      datetime TEXT NOT NULL,
      anomaly_type TEXT NOT NULL,
      severity TEXT,
      observed_value REAL,
      reference_value REAL,
      description TEXT,
      status TEXT,
      PRIMARY KEY (datetime, anomaly_type)
    );
    CREATE TABLE spy_hourly (
      datetime TEXT PRIMARY KEY,
      open REAL,
      high REAL,
      low REAL,
      close REAL,
      volume INTEGER,
      saved_at TEXT DEFAULT CURRENT_TIMESTAMP
    );
  `);

  return {
    env: {
      DB: {
        prepare(sql) {
          const statement = sqlite.prepare(sql);
          return { bind: (...values) => ({ run: async () => statement.run(...values) }) };
        }
      }
    },
    readAlerts: () => sqlite.prepare("SELECT * FROM spy_data_quality ORDER BY anomaly_type")
      .all().map(row => ({ ...row }))
  };
}

const cases = [
  { threshold: 0, range: 0, detected: true },
  { threshold: 0, range: 1, detected: true },
  { threshold: 0, range: 2.25, detected: true },
  { threshold: 3, range: 2.75, detected: false },
  { threshold: 3, range: 3, detected: true },
  { threshold: 3, range: 3.25, detected: true },
];

function expectedRangeAlert(range, threshold) {
  return {
    datetime,
    anomaly_type: "unusual_hourly_range",
    severity: "warning",
    observed_value: range,
    reference_value: threshold,
    description: `Hourly price range reached or exceeded ${threshold}%.`,
    status: "pending"
  };
}

for (const { threshold, range, detected } of cases) {
  test(`range ${range}% with effective threshold ${threshold}%`, async t => {
    const { env, readAlerts } = createFixture(t);
    await monitorDataQuality(env, datetime, 100, 100 + range, 100, 1000, threshold);
    assert.deepEqual(readAlerts(), detected ? [expectedRangeAlert(range, threshold)] : []);
  });
}

test("a nonpositive open skips the range check even at 0%", async t => {
  const { env, readAlerts } = createFixture(t);
  await monitorDataQuality(env, datetime, 0, 100, 0, 1000, 0);
  assert.deepEqual(readAlerts(), []);
});

test("the Worker persists the default 3% reference and keeps the volume rule", async t => {
  const { env, readAlerts } = createFixture(t);
  env.TWELVE_DATA_API_KEY = "test-fixture";
  t.mock.method(globalThis, "fetch", async () => {
    assert.fail("The Worker must use the local fixture instead of the provider");
  });
  const responseFromCache = () => Response.json({
    values: [
      { datetime, open: "100", high: "103", low: "100", close: "101", volume: "" },
      {
        datetime: "2020-01-02 10:30:00",
        open: "100", high: "102.75", low: "100", close: "101", volume: "1000"
      }
    ]
  });
  Object.defineProperty(globalThis, "caches", {
    configurable: true,
    value: { default: { match: responseFromCache } }
  });
  t.after(() => { delete globalThis.caches; });

  const pending = [];
  const response = await worker.fetch(new Request("https://test.invalid/ohlc"), env, {
    waitUntil: operation => pending.push(operation)
  });
  assert.equal(response.status, 200);
  assert.equal(pending.length, 1);
  await Promise.all(pending);

  assert.deepEqual(readAlerts(), [
    {
      datetime,
      anomaly_type: "invalid_volume",
      severity: "warning",
      observed_value: null,
      reference_value: null,
      description: "Missing or invalid hourly volume.",
      status: "pending"
    },
    expectedRangeAlert(3, 3)
  ]);
});
