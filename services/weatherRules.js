// services/weatherRules.js

function toHour(timeStr) {
   // "2026-02-27T14:00" -> 14
   return Number(timeStr.slice(11, 13));
}

function isSameDay(timeStr, dayStr) {
   // dayStr: "2026-02-27"
   return timeStr.startsWith(dayStr);
}

function clamp(n, min, max) {
   return Math.max(min, Math.min(max, n));
}

/**
 * ============================
 * INSPECTION (فتح الخلية)
 * ============================
 * Strong scoring with penalties (avoids 100 always).
 */
function scoreInspectionHour({ temp, wind, rainP }) {
   let score = 0;
   const reasons = [];

   // TEMP score (0..45)
   if (temp < 12) {
      score += 0;
      reasons.push("low_temp");
   } else if (temp < 14) {
      score += 18;
      reasons.push("cool_temp");
   } else if (temp < 16) {
      score += 30;
   } else if (temp < 20) {
      score += 40;
   } else {
      score += 45;
   }

   // WIND score (0..35)
   if (wind > 30) {
      score += 0;
      reasons.push("very_high_wind");
   } else if (wind > 25) {
      score += 10;
      reasons.push("high_wind");
   } else if (wind > 18) {
      score += 22;
      reasons.push("moderate_wind");
   } else if (wind > 12) {
      score += 30;
   } else {
      score += 35;
   }

   // RAIN score (0..20)
   if (rainP > 70) {
      score += 0;
      reasons.push("high_rain_risk");
   } else if (rainP > 50) {
      score += 6;
      reasons.push("rain_risk");
   } else if (rainP > 30) {
      score += 12;
      reasons.push("light_rain_risk");
   } else {
      score += 20;
   }

   // Soft cap to make 100 rare
   score = Math.round(score * 0.95); // max ~95
   score = clamp(score, 0, 100);

   return { score, reasons };
}

/**
 * Pick best inspection window for a day using hourly data.
 * Only within 11:00-16:00.
 * For dayIndex=0 (today), excludes past hours using weather.current.time (local).
 */
function pickBestInspectionWindowForDay(weather, dayIndex) {
   const day = weather?.daily?.time?.[dayIndex];
   const hourly = weather?.hourly;
   if (!day || !hourly?.time?.length) return null;

   const startHour = 11;
   const endHour = 16;

   const nowLocal = weather?.current?.time; // local time string e.g. "2026-02-26T22:00"
   let best = null;

   for (let i = 0; i < hourly.time.length; i++) {
      const t = hourly.time[i];

      // ✅ don't pick past hours for today
      if (dayIndex === 0 && nowLocal && t < nowLocal) continue;

      if (!isSameDay(t, day)) continue;

      const hour = toHour(t);
      if (hour < startHour || hour > endHour) continue;

      const temp = hourly.temperature_2m[i];
      const wind = hourly.wind_speed_10m[i];
      const rainP = hourly.precipitation_probability?.[i] ?? 0;

      const scored = scoreInspectionHour({ temp, wind, rainP });

      if (!best || scored.score > best.score) {
         best = {
            time: t,
            score: scored.score,
            reasons: scored.reasons,
            meta: { temp, wind, rainP },
         };
      }
   }

   return best;
}

/**
 * ============================
 * FEEDING (تغذية)
 * ============================
 * Less sensitive to temp, more to rain/wind.
 */
function scoreFeedingHour({ wind, rainP }) {
   let score = 0;
   const reasons = [];

   // WIND (0..45)
   if (wind > 30) {
      score += 0;
      reasons.push("very_high_wind");
   } else if (wind > 22) {
      score += 18;
      reasons.push("high_wind");
   } else if (wind > 16) {
      score += 30;
      reasons.push("moderate_wind");
   } else if (wind > 10) {
      score += 38;
   } else {
      score += 45;
   }

   // RAIN (0..55)
   if (rainP > 70) {
      score += 0;
      reasons.push("high_rain_risk");
   } else if (rainP > 50) {
      score += 18;
      reasons.push("rain_risk");
   } else if (rainP > 30) {
      score += 35;
      reasons.push("light_rain_risk");
   } else {
      score += 55;
   }

   // Soft cap
   score = Math.round(score * 0.93); // max ~93
   score = clamp(score, 0, 100);

   return { score, reasons };
}

/**
 * Pick best feeding window for a day using hourly data.
 * Wider range 10:00-18:00.
 * For today, excludes past hours (same logic).
 */
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

      // ✅ don't pick past hours for today
      if (dayIndex === 0 && nowLocal && t < nowLocal) continue;

      if (!isSameDay(t, day)) continue;

      const hour = toHour(t);
      if (hour < startHour || hour > endHour) continue;

      const wind = hourly.wind_speed_10m[i];
      const rainP = hourly.precipitation_probability?.[i] ?? 0;

      const scored = scoreFeedingHour({ wind, rainP });

      if (!best || scored.score > best.score) {
         best = {
            time: t,
            score: scored.score,
            reasons: scored.reasons,
            meta: { wind, rainP },
         };
      }
   }

   return best;
}

/**
 * Build insights:
 * - activities: per activity scores + best windows today/tomorrow
 * - advice: array of {code,severity,activity,params} (multilang-ready)
 */
function buildWeatherInsights(weather) {
   // ============================
   // Activities
   // ============================
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

   // ============================
   // Advice codes (NO TEXT here)
   // ============================
   const advice = [];

   // --- INSPECTION advice
   if (inspToday && inspToday.score >= 50) {
      advice.push({
         code: "weather.advice.inspection.best_window_today",
         severity: inspToday.score >= 80 ? "success" : "info",
         activity: "inspection",
         params: {
            time: inspToday.time.slice(11, 16),
            score: inspToday.score,
            // optional details if you want later in UI:
            temp: inspToday.meta?.temp,
            wind: inspToday.meta?.wind,
            rainProb: inspToday.meta?.rainP,
         },
      });
   } else if (inspTomorrow && inspTomorrow.score >= 50) {
      advice.push({
         code: "weather.advice.inspection.best_window_tomorrow",
         severity: inspTomorrow.score >= 80 ? "success" : "info",
         activity: "inspection",
         params: {
            time: inspTomorrow.time.slice(11, 16),
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

   // --- FEEDING advice (we show only if good enough)
   if (feedToday && feedToday.score >= 60) {
      advice.push({
         code: "weather.advice.feeding.best_window_today",
         severity: feedToday.score >= 80 ? "success" : "info",
         activity: "feeding",
         params: {
            time: feedToday.time.slice(11, 16),
            score: feedToday.score,
            wind: feedToday.meta?.wind,
            rainProb: feedToday.meta?.rainP,
         },
      });
   } else if (feedTomorrow && feedTomorrow.score >= 60) {
      advice.push({
         code: "weather.advice.feeding.best_window_tomorrow",
         severity: feedTomorrow.score >= 80 ? "success" : "info",
         activity: "feeding",
         params: {
            time: feedTomorrow.time.slice(11, 16),
            score: feedTomorrow.score,
            wind: feedTomorrow.meta?.wind,
            rainProb: feedTomorrow.meta?.rainP,
         },
      });
   }

   // --- Global alert example (from daily)
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
