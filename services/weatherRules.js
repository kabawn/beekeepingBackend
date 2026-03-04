// services/weatherRules.js

function toHour(timeStr) {
  return Number(String(timeStr).slice(11, 13));
}

function isSameDay(timeStr, dayStr) {
  return String(timeStr).startsWith(String(dayStr));
}

function clamp(n, min, max) {
  return Math.max(min, Math.min(max, n));
}

function fmtHHMM(timeStr) {
  return timeStr ? String(timeStr).slice(11, 16) : "";
}

function hasReason(reasons, code) {
  return Array.isArray(reasons) && reasons.includes(code);
}

/**
 * ============================
 * INSPECTION (فتح الخلية)
 * ============================
 * Realistic:
 * - wind >= 20 => BLOCK
 * - rainP >= 60 => BLOCK
 * - score based on temp + wind + rain
 */
function scoreInspectionHour({ temp, wind, rainP }) {
  const reasons = [];

  const T = typeof temp === "string" ? Number(temp) : temp;
  const W = typeof wind === "string" ? Number(wind) : wind;
  const R = typeof rainP === "string" ? Number(rainP) : rainP;

  const tempN = Number.isFinite(T) ? T : null;
  const windN = Number.isFinite(W) ? W : null;
  const rainN = Number.isFinite(R) ? R : 0;

  // HARD BLOCKS
  if (windN !== null && windN >= 18) return { score: 0, reasons: ["high_wind_block"] };
  if (rainN >= 60) return { score: 0, reasons: ["rain_block"] };

  let score = 0;

  // TEMP (0..50)
  if (tempN === null) {
    score += 20;
    reasons.push("unknown_temp");
  } else if (tempN < 12) {
    score += 0;
    reasons.push("low_temp");
  } else if (tempN < 14) {
    score += 18;
    reasons.push("cool_temp");
  } else if (tempN < 16) {
    score += 30;
  } else if (tempN < 20) {
    score += 42;
  } else {
    score += 50;
  }

  // WIND (0..30) (here wind < 20 always)
  if (windN === null) {
    score += 18;
    reasons.push("unknown_wind");
  } else if (windN > 18) {
    score += 10;
    reasons.push("moderate_wind");
  } else if (windN > 12) {
    score += 22;
  } else if (windN > 7) {
    score += 26;
  } else {
    score += 30;
  }

  // RAIN (0..20) (here rain < 60 always)
  if (rainN > 50) {
    score += 6;
    reasons.push("rain_risk");
  } else if (rainN > 30) {
    score += 12;
    reasons.push("light_rain_risk");
  } else {
    score += 20;
  }

  score = Math.round(score * 0.95); // cap (max ~95)
  score = clamp(score, 0, 100);
  return { score, reasons };
}

function pickBestInspectionWindowForDay(weather, dayIndex) {
  const day = weather?.daily?.time?.[dayIndex];
  const hourly = weather?.hourly;
  if (!day || !hourly?.time?.length) return null;

  const startHour = 11;
  const endHour = 16;

  const nowLocal = weather?.current?.time;
  let best = null;

  for (let i = 0; i < hourly.time.length; i++) {
    const t = hourly.time[i];

    if (dayIndex === 0 && nowLocal && t < nowLocal) continue;
    if (!isSameDay(t, day)) continue;

    const hour = toHour(t);
    if (hour < startHour || hour > endHour) continue;

    const temp = hourly.temperature_2m?.[i];
    const wind = hourly.wind_speed_10m?.[i];
    const rainP = hourly.precipitation_probability?.[i] ?? 0;

    const scored = scoreInspectionHour({ temp, wind, rainP });

    // ✅ skip blocked hours
    if (scored.score === 0) continue;

    if (!best || scored.score > best.score) {
      best = { time: t, score: scored.score, reasons: scored.reasons, meta: { temp, wind, rainP } };
    }
  }

  return best;
}

/**
 * ============================
 * FEEDING (تغذية)
 * ============================
 * Realistic:
 * - wind >= 30 => BLOCK
 * - rainP >= 70 => BLOCK
 * - strong penalty after 16 km/h
 */
function scoreFeedingHour({ wind, rainP }) {
  const reasons = [];

  const W = typeof wind === "string" ? Number(wind) : wind;
  const R = typeof rainP === "string" ? Number(rainP) : rainP;

  const windN = Number.isFinite(W) ? W : null;
  const rainN = Number.isFinite(R) ? R : 0;

  // HARD BLOCKS (feeding less strict than inspection)
  if (windN !== null && windN >= 30) return { score: 0, reasons: ["very_high_wind_block"] };
  if (rainN >= 70) return { score: 0, reasons: ["rain_block"] };

  let score = 0;

  // WIND (0..45) — tuned
  if (windN === null) {
    score += 25;
    reasons.push("unknown_wind");
  } else if (windN > 25) {
    score += 8;
    reasons.push("high_wind");
  } else if (windN > 20) {
    score += 14;
    reasons.push("high_wind");
  } else if (windN > 16) {
    score += 22;
    reasons.push("moderate_wind");
  } else if (windN > 10) {
    score += 34;
  } else {
    score += 45;
  }

  // RAIN (0..55)
  if (rainN > 60) {
    score += 10;
    reasons.push("rain_risk");
  } else if (rainN > 40) {
    score += 25;
    reasons.push("light_rain_risk");
  } else if (rainN > 25) {
    score += 40;
    reasons.push("light_rain_risk");
  } else {
    score += 55;
  }

  score = Math.round(score * 0.93); // cap
  score = clamp(score, 0, 100);
  return { score, reasons };
}

function pickBestFeedingWindowForDay(weather, dayIndex) {
  const day = weather?.daily?.time?.[dayIndex];
  const hourly = weather?.hourly;
  if (!day || !hourly?.time?.length) return null;

  const startHour = 10;
  const endHour = 18;

  const nowLocal = weather?.current?.time;
  let best = null;

  for (let i = 0; i < hourly.time.length; i++) {
    const t = hourly.time[i];

    if (dayIndex === 0 && nowLocal && t < nowLocal) continue;
    if (!isSameDay(t, day)) continue;

    const hour = toHour(t);
    if (hour < startHour || hour > endHour) continue;

    const wind = hourly.wind_speed_10m?.[i];
    const rainP = hourly.precipitation_probability?.[i] ?? 0;

    const scored = scoreFeedingHour({ wind, rainP });

    // ✅ skip blocked hours
    if (scored.score === 0) continue;

    if (!best || scored.score > best.score) {
      best = { time: t, score: scored.score, reasons: scored.reasons, meta: { wind, rainP } };
    }
  }

  return best;
}

// Advice code selector
function inspectionAdviceCode(best, when) {
  if (!best) return "weather.advice.inspection.no_good_window_48h";

  const warn =
    hasReason(best.reasons, "moderate_wind") ||
    hasReason(best.reasons, "rain_risk") ||
    hasReason(best.reasons, "light_rain_risk");

  if (warn) {
    return when === "today"
      ? "weather.advice.inspection.best_window_today_with_warning"
      : "weather.advice.inspection.best_window_tomorrow_with_warning";
  }

  return when === "today"
    ? "weather.advice.inspection.best_window_today"
    : "weather.advice.inspection.best_window_tomorrow";
}

function feedingAdviceCode(best, when) {
  if (!best) return null;

  const warn =
    hasReason(best.reasons, "high_wind") ||
    hasReason(best.reasons, "moderate_wind") ||
    hasReason(best.reasons, "rain_risk") ||
    hasReason(best.reasons, "light_rain_risk");

  if (warn) {
    return when === "today"
      ? "weather.advice.feeding.best_window_today_with_warning"
      : "weather.advice.feeding.best_window_tomorrow_with_warning";
  }

  return when === "today"
    ? "weather.advice.feeding.best_window_today"
    : "weather.advice.feeding.best_window_tomorrow";
}

/**
 * Build insights
 */
function buildWeatherInsights(weather) {
  const inspToday = pickBestInspectionWindowForDay(weather, 0);
  const inspTomorrow = pickBestInspectionWindowForDay(weather, 1);

  const feedToday = pickBestFeedingWindowForDay(weather, 0);
  const feedTomorrow = pickBestFeedingWindowForDay(weather, 1);

  const activities = {
    inspection: {
      score_today: inspToday?.score ?? null,
      best_window_today: inspToday,
      score_tomorrow: inspTomorrow?.score ?? null,
      best_window_tomorrow: inspTomorrow,
    },
    feeding: {
      score_today: feedToday?.score ?? null,
      best_window_today: feedToday,
      score_tomorrow: feedTomorrow?.score ?? null,
      best_window_tomorrow: feedTomorrow,
    },
  };

  const advice = [];

  // INSPECTION
  if (inspToday && inspToday.score >= 55) {
    advice.push({
      code: inspectionAdviceCode(inspToday, "today"),
      severity: inspToday.score >= 80 ? "success" : "info",
      activity: "inspection",
      params: {
        time: fmtHHMM(inspToday.time),
        score: inspToday.score,
        temp: inspToday.meta?.temp,
        wind: inspToday.meta?.wind,
        rainProb: inspToday.meta?.rainP,
      },
    });
  } else if (inspTomorrow && inspTomorrow.score >= 55) {
    advice.push({
      code: inspectionAdviceCode(inspTomorrow, "tomorrow"),
      severity: inspTomorrow.score >= 80 ? "success" : "info",
      activity: "inspection",
      params: {
        time: fmtHHMM(inspTomorrow.time),
        score: inspTomorrow.score,
        temp: inspTomorrow.meta?.temp,
        wind: inspTomorrow.meta?.wind,
        rainProb: inspTomorrow.meta?.rainP,
      },
    });
  } else {
    advice.push({
      code: "weather.advice.inspection.no_good_window_48h",
      severity: "warning",
      activity: "inspection",
      params: {},
    });
  }

  // FEEDING
  if (feedToday && feedToday.score >= 60) {
    advice.push({
      code: feedingAdviceCode(feedToday, "today"),
      severity: feedToday.score >= 80 ? "success" : "info",
      activity: "feeding",
      params: {
        time: fmtHHMM(feedToday.time),
        score: feedToday.score,
        wind: feedToday.meta?.wind,
        rainProb: feedToday.meta?.rainP,
      },
    });
  } else if (feedTomorrow && feedTomorrow.score >= 60) {
    advice.push({
      code: feedingAdviceCode(feedTomorrow, "tomorrow"),
      severity: feedTomorrow.score >= 80 ? "success" : "info",
      activity: "feeding",
      params: {
        time: fmtHHMM(feedTomorrow.time),
        score: feedTomorrow.score,
        wind: feedTomorrow.meta?.wind,
        rainProb: feedTomorrow.meta?.rainP,
      },
    });
  }

  // Global alert: rain tomorrow
  const rainMaxTomorrow = weather?.daily?.precipitation_probability_max?.[1];
  if (typeof rainMaxTomorrow === "number" && rainMaxTomorrow >= 60) {
    advice.push({
      code: "weather.alert.rain_tomorrow",
      severity: "warning",
      activity: "general",
      params: { rainProb: rainMaxTomorrow },
    });
  }

  return { activities, advice };
}

module.exports = { buildWeatherInsights };