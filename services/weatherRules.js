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

function scoreToStatus(score) {
   if (score === null || score === undefined || score <= 0) return "forbidden";
   if (score >= 80) return "optimal";
   if (score >= 55) return "acceptable";
   return "forbidden";
}

function getDayHourlyRows(weather, dayIndex) {
   const day = weather?.daily?.time?.[dayIndex];
   const hourly = weather?.hourly;
   if (!day || !hourly?.time?.length) return [];

   const rows = [];

   for (let i = 0; i < hourly.time.length; i++) {
      const t = hourly.time[i];
      if (!isSameDay(t, day)) continue;

      rows.push({
         time: t,
         hhmm: fmtHHMM(t),
         temp: hourly.temperature_2m?.[i] ?? null,
         wind: hourly.wind_speed_10m?.[i] ?? null,
         rainP: hourly.precipitation_probability?.[i] ?? 0,
         rain: hourly.precipitation?.[i] ?? 0,
         humidity: hourly.relative_humidity_2m?.[i] ?? null,
         weatherCode: hourly.weather_code?.[i] ?? null,
      });
   }

   return rows;
}

function buildHourlyActivityStatuses(rows) {
   return rows.map((row) => {
      const inspection = scoreInspectionHour({
         temp: row.temp,
         wind: row.wind,
         rainP: row.rainP,
         rain: row.rain,
         time: row.time,
      });

      const feeding = scoreFeedingHour({
         temp: row.temp,
         wind: row.wind,
         rainP: row.rainP,
         rain: row.rain,
         time: row.time,
      });

      return {
         ...row,
         inspection_score: inspection.score,
         inspection_status: scoreToStatus(inspection.score),
         inspection_reasons: inspection.reasons,

         feeding_score: feeding.score,
         feeding_status: scoreToStatus(feeding.score),
         feeding_reasons: feeding.reasons,
      };
   });
}

function computeOverallStatus({ inspection, tempMax, windMax, rainSum }) {
   if (!inspection || inspection.score < 55) return "forbidden";
   if ((rainSum ?? 0) > 3) return "forbidden";
   if ((windMax ?? 0) > 22) return "forbidden";
   if ((tempMax ?? 0) < 12) return "forbidden";

   if (inspection.score >= 80 && (rainSum ?? 0) < 1 && (windMax ?? 0) <= 15) {
      return "optimal";
   }

   return "acceptable";
}

function summarizeDayFromHourly(weather, dayIndex) {
   const rows = buildHourlyActivityStatuses(getDayHourlyRows(weather, dayIndex));
   const day = weather?.daily?.time?.[dayIndex];
   if (!day) return null;

   const inspectionRows = rows.filter((r) => r.inspection_score >= 55);
   const feedingRows = rows.filter((r) => r.feeding_score >= 55);

   const bestInspection =
      inspectionRows.sort((a, b) => b.inspection_score - a.inspection_score)[0] || null;
   const bestFeeding = feedingRows.sort((a, b) => b.feeding_score - a.feeding_score)[0] || null;

   const tempMin = weather?.daily?.temperature_2m_min?.[dayIndex] ?? null;
   const tempMax = weather?.daily?.temperature_2m_max?.[dayIndex] ?? null;
   const windMax = weather?.daily?.wind_speed_10m_max?.[dayIndex] ?? null;
   const rainProbabilityMax = weather?.daily?.precipitation_probability_max?.[dayIndex] ?? null;
   const rainSum = weather?.daily?.precipitation_sum?.[dayIndex] ?? null;
   const weatherCode = weather?.daily?.weather_code?.[dayIndex] ?? null;

   const overallStatus = computeOverallStatus({
      inspection: bestInspection ? { score: bestInspection.inspection_score } : null,
      tempMax,
      windMax,
      rainSum,
   });

   return {
      date: day,
      overall_status: overallStatus,
      inspection: {
         status: scoreToStatus(bestInspection?.inspection_score ?? 0),
         best_window_time: bestInspection?.hhmm ?? null,
         score: bestInspection?.inspection_score ?? null,
      },

      feeding: {
         status: scoreToStatus(bestFeeding?.feeding_score ?? 0),
         best_window_time: bestFeeding?.hhmm ?? null,
         score: bestFeeding?.feeding_score ?? null,
      },

      temp_min: tempMin,
      temp_max: tempMax,
      wind_max: windMax,
      rain_probability_max: rainProbabilityMax,
      rain_sum: rainSum,
      weather_code: weatherCode,
   };
}

function buildWeeklyWeatherInsights(weather) {
   const days = [];
   const dailyTimes = weather?.daily?.time || [];

   for (let dayIndex = 0; dayIndex < dailyTimes.length; dayIndex++) {
      const daySummary = summarizeDayFromHourly(weather, dayIndex);
      if (daySummary) days.push(daySummary);
   }

   return { days };
}

function buildDayDetails(weather, targetDate) {
   const dailyTimes = weather?.daily?.time || [];
   const dayIndex = dailyTimes.findIndex((d) => d === targetDate);
   if (dayIndex === -1) return null;

   const summary = summarizeDayFromHourly(weather, dayIndex);
   const hourly = buildHourlyActivityStatuses(getDayHourlyRows(weather, dayIndex));

   return {
      ...summary,
      hourly,
   };
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
function scoreInspectionHour({ temp, wind, rainP, rain, time }) {
   const reasons = [];

   const T = typeof temp === "string" ? Number(temp) : temp;
   const W = typeof wind === "string" ? Number(wind) : wind;
   const RP = typeof rainP === "string" ? Number(rainP) : rainP;
   const R = typeof rain === "string" ? Number(rain) : rain;

   const tempN = Number.isFinite(T) ? T : null;
   const windN = Number.isFinite(W) ? W : null;
   const rainProbN = Number.isFinite(RP) ? RP : 0;
   const rainN = Number.isFinite(R) ? R : 0;

   // ✅ ساعات الكشف فقط
   const h = toHour(time);
   if (!Number.isFinite(h) || h < 10 || h > 18) {
      return { score: 0, reasons: ["outside_inspection_hours"] };
   }

   // ✅ BLOCKS
   if (windN !== null && windN >= 18) return { score: 0, reasons: ["high_wind_block"] };
   if (rainProbN >= 60 || rainN > 0.2) return { score: 0, reasons: ["rain_block"] };

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

   // WIND (0..30)
   if (windN === null) {
      score += 18;
      reasons.push("unknown_wind");
   } else if (windN > 12) {
      score += 22;
      reasons.push("windy");
   } else if (windN > 7) {
      score += 26;
   } else {
      score += 30;
   }

   // RAIN (0..20)
   if (rainProbN > 50 || rainN > 0.1) {
      score += 6;
      reasons.push("rain_risk");
   } else if (rainProbN > 30) {
      score += 12;
      reasons.push("light_rain_risk");
   } else {
      score += 20;
   }

   score = Math.round(score * 0.95);
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
 * Realistic:
 * - wind >= 30 => BLOCK
 * - rainP >= 70 => BLOCK
 * - strong penalty after 16 km/h
 */
function scoreFeedingHour({ temp, wind, rainP, rain, time }) {
   const reasons = [];

   const T = typeof temp === "string" ? Number(temp) : temp;
   const W = typeof wind === "string" ? Number(wind) : wind;
   const RP = typeof rainP === "string" ? Number(rainP) : rainP;
   const R = typeof rain === "string" ? Number(rain) : rain;

   const tempN = Number.isFinite(T) ? T : null;
   const windN = Number.isFinite(W) ? W : null;
   const rainProbN = Number.isFinite(RP) ? RP : 0;
   const rainN = Number.isFinite(R) ? R : 0;

   // ✅ ساعات التغذية فقط
   const h = toHour(time);
   if (!Number.isFinite(h) || h < 17 || h > 21) {
      return { score: 0, reasons: ["outside_feeding_hours"] };
   }

   // ✅ BLOCKS
   if (windN !== null && windN >= 30) return { score: 0, reasons: ["very_high_wind_block"] };
   if (rainProbN >= 70 || rainN > 0.3) return { score: 0, reasons: ["rain_block"] };

   let score = 85;

   // WIND penalty
   if (windN === null) {
      score -= 10;
      reasons.push("unknown_wind");
   } else if (windN > 20) {
      score -= 35;
      reasons.push("high_wind");
   } else if (windN > 16) {
      score -= 20;
      reasons.push("moderate_wind");
   } else if (windN > 10) {
      score -= 10;
      reasons.push("windy");
   }

   // RAIN penalty
   if (rainProbN > 50 || rainN > 0.2) {
      score -= 35;
      reasons.push("rain_risk");
   } else if (rainProbN > 30) {
      score -= 18;
      reasons.push("light_rain_risk");
   }

   // TEMP penalty
   if (tempN !== null && tempN < 8) {
      score -= 18;
      reasons.push("low_temp");
   }

   score = clamp(Math.round(score), 0, 100);
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

module.exports = {
   buildWeatherInsights,
   buildWeeklyWeatherInsights,
   buildDayDetails,
};
