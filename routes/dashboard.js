// routes/dashboard.js
const express = require("express");
const router = express.Router();
const supabase = require("../utils/supabaseClient");
const authenticateUser = require("../middlewares/authMiddleware");

router.get("/overview", authenticateUser, async (req, res) => {
   const userId = req.user.id;

   try {
      const t0 = Date.now();

      const [apiariesRes, hivesRes, supersRes] = await Promise.all([
         // عدد المناحل
         supabase
            .from("apiaries")
            .select("apiary_id", { count: "exact", head: true })
            .eq("owner_user_id", userId),

         // عدد الخلايا
         supabase
            .from("hives")
            .select("hive_id", { count: "exact", head: true })
            .eq("owner_user_id", userId),

         // عدد العاسلات
         supabase
            .from("supers")
            .select("super_id", { count: "estimated", head: true })
            .eq("owner_user_id", userId),
      ]);

      console.log("🧠 dashboard overview ms =", Date.now() - t0);

      res.json({
         apiaries: apiariesRes.count || 0,
         hives: hivesRes.count || 0,
         supers: supersRes.count || 0,
      });
   } catch (err) {
      console.error("❌ Dashboard overview error:", err);
      res.status(500).json({ error: "Failed to load dashboard overview" });
   }
});

module.exports = router;
