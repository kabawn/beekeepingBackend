// routes/weather.js
const express = require("express");
const router = express.Router();

const supabase = require("../utils/supabaseClient");
const authenticateUser = require("../middlewares/authMiddleware");

const { fetchWeather } = require("../services/weather.service");
const { buildWeatherInsights } = require("../services/weatherRules");
const { getCached, setCached } = require("../services/weatherCache");

function parseLatLng(locationStr) {
   if (!locationStr) return null;
   const [latStr, lngStr] = String(locationStr)
      .split(",")
      .map((s) => s.trim());

   const lat = Number(latStr);
   const lng = Number(lngStr);

   if (!Number.isFinite(lat) || !Number.isFinite(lng)) return null;
   return { lat, lng };
}

// GET /api/weather/:apiaryId
router.get("/:apiaryId", authenticateUser, async (req, res) => {
   try {
      const apiaryId = Number(req.params.apiaryId);
      if (!Number.isFinite(apiaryId)) {
         return res.status(400).json({ error: "Invalid apiaryId" });
      }

      // ✅ Cache per apiary per user (30 min)
      const userId = req.user?.id || "anonymous";
      const cacheKey = `weather:apiary:${apiaryId}:user:${userId}`;
      const cached = getCached(cacheKey);
      if (cached) return res.json(cached);

      // 1) Fetch apiary location
      const { data: apiary, error: apiErr } = await supabase
         .from("apiaries")
         .select("apiary_id, location, owner_user_id")
         .eq("apiary_id", apiaryId)
         .single();

      if (apiErr || !apiary) {
         return res.status(404).json({ error: apiErr?.message || "Apiary not found" });
      }

      // Optional extra protection (لو RLS مش كافي)
      if (apiary.owner_user_id && req.user?.id && apiary.owner_user_id !== req.user.id) {
         return res.status(403).json({ error: "Forbidden" });
      }

      const coords = parseLatLng(apiary.location);
      if (!coords) {
         return res.status(400).json({ error: "Invalid location format. Expected 'lat,lng'" });
      }

      // 2) Fetch weather from provider
      const weather = await fetchWeather(coords.lat, coords.lng);

      // 3) Insights (scores + best windows + advice codes)
      const insights = buildWeatherInsights(weather);

      const payload = {
         apiary_id: apiary.apiary_id,
         location: apiary.location,
         fetched_at: new Date().toISOString(),
         weather,
         ...insights, // activities + advice
      };

      setCached(cacheKey, payload, 30 * 60 * 1000); // 30 min
      return res.json(payload);
   } catch (e) {
      console.error("Weather endpoint error:", e);
      return res.status(500).json({ error: "Internal server error" });
   }
});

module.exports = router;
