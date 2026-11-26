const HOURLY_RANGE_THRESHOLD_PERCENT = 3;

export async function monitorDataQuality(
  env, dt, open, high, low, volume,
  thresholdPercent = HOURLY_RANGE_THRESHOLD_PERCENT
) {
  const alerts = [];

  if (!Number.isSafeInteger(volume) || volume <= 0) {
    alerts.push({
      type: "invalid_volume",
      severity: "warning",
      observed: Number.isFinite(volume) ? volume : null,
      reference: null,
      description: "Missing or invalid hourly volume."
    });
  }

  if (open > 0) {
    const rangePercent = ((high - low) / open) * 100;

    if (rangePercent >= thresholdPercent) {
      alerts.push({
        type: "unusual_hourly_range",
        severity: "warning",
        observed: rangePercent,
        reference: thresholdPercent,
        description: `Hourly price range reached or exceeded ${thresholdPercent}%.`
      });
    }
  }

  for (const alert of alerts) {
    await env.DB.prepare(`
      INSERT INTO spy_data_quality
        (datetime, anomaly_type, severity,
         observed_value, reference_value,
         description, status)
      VALUES (?, ?, ?, ?, ?, ?, 'pending')
      ON CONFLICT(datetime, anomaly_type)
      DO NOTHING
    `).bind(
      dt,
      alert.type,
      alert.severity,
      alert.observed,
      alert.reference,
      alert.description
    ).run();
  }
}
