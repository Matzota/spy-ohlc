
const ALLOWED_ORIGIN = "https://matzota.github.io";
const CACHE_KEY = new Request("https://spy-ohlc-cache.internal/ohlc");

const HEADERS = {
  "Access-Control-Allow-Origin": ALLOWED_ORIGIN,
  "Access-Control-Allow-Methods": "GET, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type",
  "Content-Type": "application/json; charset=utf-8",
  "X-Content-Type-Options": "nosniff"
};

const json = (data, status = 200) =>
  new Response(JSON.stringify(data), {
    status,
    headers: HEADERS
  });

async function providerData(env) {
  if (!env.TWELVE_DATA_API_KEY) {
    throw new Error("Missing TWELVE_DATA_API_KEY");
  }

  const api = new URL("https://api.twelvedata.com/time_series");

  for (const [key, value] of Object.entries({
    symbol: "SPY",
    interval: "1h",
    outputsize: "10",
    timezone: "America/New_York",
    previous_close: "true"
  })) {
    api.searchParams.set(key, value);
  }

  const response = await fetch(api.toString(), {
    headers: {
      Authorization: `apikey ${env.TWELVE_DATA_API_KEY}`,
      Accept: "application/json"
    },
    redirect: "follow"
  });

  const raw = await response.text();
  let data;

  try {
    data = JSON.parse(raw);
  } catch {
    throw new Error(
      `Invalid provider JSON (${response.status})`
    );
  }

  if (
    !response.ok ||
    data.status === "error" ||
    data.code ||
    !Array.isArray(data.values)
  ) {
    throw new Error(
      `Twelve Data error (${response.status}): ${
        data.message || data.code || "Missing OHLC values"
      }`
    );
  }

  return data;
}

// Hora actual de Nueva York
function newYorkNow(now = new Date()) {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: "America/New_York",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hourCycle: "h23"
  }).formatToParts(now);

  const p = Object.fromEntries(
    parts
      .filter(x => x.type !== "literal")
      .map(x => [x.type, x.value])
  );

  return `${p.year}-${p.month}-${p.day} ${p.hour}:${p.minute}:${p.second}`;
}

// Solo velas cerradas de la sesion regular
function isClosedRegularSessionCandle(datetime, nowNY) {
  const m =
    /^(\d{4}-\d{2}-\d{2}) (\d{2}):(\d{2})(?::\d{2})?$/
      .exec(datetime);

  if (!m) return false;

  const [, day, hh, mm] = m;
  const hour = Number(hh);
  const minute = Number(mm);
  const start = hour * 60 + minute;

  // Velas: 9:30, 10:30 ... 15:30 ET
  if (
    minute !== 30 ||
    start < 570 ||
    start > 930 ||
    (start - 570) % 60 !== 0
  ) {
    return false;
  }

  // La ultima vela termina a las 16:00
  const end = Math.min(start + 60, 960);

  const nowDate = nowNY.slice(0, 10);

  if (day < nowDate) return true;
  if (day > nowDate) return false;

  const nowMinutes =
    Number(nowNY.slice(11, 13)) * 60 +
    Number(nowNY.slice(14, 16));

  // Esperar 2 minutos despues del cierre
  return nowMinutes >= end + 2;
}

async function saveCandles(env, data) {
  if (!env.DB) {
    throw new Error("Missing D1 binding DB");
  }

  let count = 0;
  const nowNY = newYorkNow();

  for (const item of data.values) {
    const dt = String(item.datetime || "").trim();

    if (!isClosedRegularSessionCandle(dt, nowNY)) {
      continue;
    }

    const [open, high, low, close] =
      ["open", "high", "low", "close"].map(
        key => Number(item[key])
      );

    if (
      ![open, high, low, close].every(Number.isFinite)
    ) {
      continue;
    }

    if (
      high < Math.max(open, close, low) ||
      low > Math.min(open, close)
    ) {
      continue;
    }

    const volume =
      item.volume == null || item.volume === ""
        ? null
        : Number(item.volume);

    await env.DB.prepare(`
      INSERT INTO spy_hourly
        (datetime, open, high, low, close, volume)
      VALUES (?, ?, ?, ?, ?, ?)
      ON CONFLICT(datetime) DO UPDATE SET
        open = excluded.open,
        high = excluded.high,
        low = excluded.low,
        close = excluded.close,
        volume = excluded.volume,
        saved_at = CURRENT_TIMESTAMP
    `).bind(
      dt,
      open,
      high,
      low,
      close,
      Number.isSafeInteger(volume) ? volume : null
    ).run();

    count++;
  }

  return count;
}

async function status(env) {
  if (!env.DB) {
    return json({
      storage_enabled: false,
      error: "Missing DB binding"
    }, 503);
  }

  const result = await env.DB.prepare(`
    SELECT
      COUNT(*) AS candles,
      COUNT(DISTINCT substr(datetime, 1, 10))
        AS sessions,
      MIN(datetime) AS earliest_datetime,
      MAX(datetime) AS latest_datetime
    FROM spy_hourly
  `).first();

  return json({
    storage_enabled: true,
    candles: result.candles,
    sessions: result.sessions,
    earliest_datetime: result.earliest_datetime,
    latest_datetime: result.latest_datetime
  });
}

export default {
  async fetch(request, env, ctx) {
    if (request.method === "OPTIONS") {
      return new Response(null, {
        status: 204,
        headers: HEADERS
      });
    }

    if (request.method !== "GET") {
      return json({
        error: "Method not allowed"
      }, 405);
    }

    const path = new URL(request.url).pathname;

    if (path === "/history/status") {
      try {
        return await status(env);
      } catch (error) {
        console.error("D1 status error", error);
        return json({
          error: "History unavailable"
        }, 503);
      }
    }

    if (path !== "/ohlc") {
      return json({
        status: "ok",
        service: "SPY OHLC API",
        endpoints: [
          "/ohlc",
          "/history/status"
        ]
      });
    }

    if (!env.TWELVE_DATA_API_KEY) {
      return json({
        error: "Missing API key"
      }, 500);
    }

    try {
      let data;

      try {
        const cached =
          await caches.default.match(CACHE_KEY);

        if (cached) {
          data = await cached.json();
        }
      } catch (error) {
        console.error("Cache read error", error);
      }

      if (!data) {
        data = await providerData(env);

        const response = new Response(
          JSON.stringify(data),
          {
            headers: {
              ...HEADERS,
              "Cache-Control":
                "public, max-age=120"
            }
          }
        );

        ctx.waitUntil(
          caches.default.put(CACHE_KEY, response)
            .catch(error =>
              console.error(
                "Cache write error",
                error
              )
            )
        );
      }

      if (env.DB) {
        ctx.waitUntil(
          saveCandles(env, data)
            .catch(error =>
              console.error(
                "D1 save error",
                error
              )
            )
        );
      }

      return json(data);

    } catch (error) {
      console.error(
        "SPY OHLC request failed",
        error
      );

      return json({
        error: "Request failed",
        detail: String(error.message || error)
      }, 502);
    }
  },

  async scheduled(event, env, ctx) {
    ctx.waitUntil(
      (async () => {
        const data = await providerData(env);
        const count = await saveCandles(env, data);

        console.log(
          `SPY closed candles saved/updated: ${count}`
        );
      })().catch(error =>
        console.error(
          "Scheduled capture failed",
          error
        )
      )
    );
  }
};
