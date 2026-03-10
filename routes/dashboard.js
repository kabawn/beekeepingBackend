// routes/dashboard.js
const express = require("express");
const router = express.Router();
const supabase = require("../utils/supabaseClient");
const authenticateUser = require("../middlewares/authMiddleware");

router.get("/overview", authenticateUser, async (req, res) => {
   const userId = req.user.id;

   try {
      const t0 = Date.now();

      // apiaries
      const { data: apiaries, count: apiariesCount } = await supabase
         .from("apiaries")
         .select("apiary_id", { count: "exact" })
         .eq("owner_user_id", userId);

      const apiaryIds = (apiaries || []).map((a) => a.apiary_id);

      // hives
      let hivesCount = 0;
      if (apiaryIds.length) {
         const { count } = await supabase
            .from("hives")
            .select("hive_id", { count: "exact", head: true })
            .in("apiary_id", apiaryIds);

         hivesCount = count || 0;
      }

      // supers (مرتبطة مباشرة بالمستخدم)
      const { count: supersCount } = await supabase
         .from("supers")
         .select("super_id", { count: "exact", head: true })
         .eq("owner_user_id", userId);

      // alerts (global revisits count)
      const { count: alertsCount, error: alertsErr } = await supabase
      .from("hive_inspections")
      .select("inspection_id", { count: "exact", head: true })
      .eq("user_id", userId)
      .eq("revisit_needed", true);

      if (alertsErr) {
      console.error("Alerts count error:", alertsErr);
      }

      // harvests (SUM net_honey_kg since Jan 1 current year)
      const now = new Date();
      const firstDayOfYear = new Date(now.getFullYear(), 0, 1)
      .toISOString()
      .split("T")[0];

      const { data: harvestRows, error: harvestErr } = await supabase
      .from("harvests")
      .select("net_honey_kg")
      .eq("user_id", userId)
      .gte("harvest_date", firstDayOfYear);

      if (harvestErr) {
      console.error("Harvests sum error:", harvestErr);
      }

      const harvestsKg =
      (harvestRows || []).reduce(
         (sum, r) => sum + (Number(r.net_honey_kg) || 0),
         0
      );

      const harvestsTotalKg = Math.round(harvestsKg * 100) / 100;

      res.json({
         apiaries: apiariesCount || 0,
         hives: hivesCount,
         supers: supersCount || 0,
         alerts: alertsCount || 0,
         harvests: harvestsTotalKg || 0,
      });
   } catch (err) {
      console.error("❌ Dashboard overview error:", err);
      res.status(500).json({ error: "Failed to load dashboard overview" });
   }
});

module.exports = router;
