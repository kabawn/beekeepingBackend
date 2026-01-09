// routes/inspections.js
const express = require("express");
const router = express.Router();
const supabase = require("../utils/supabaseClient");
const authenticateUser = require("../middlewares/authMiddleware");

// ✅ تسجيل فحص جديد لخلية
// ✅ تسجيل فحص جديد لخلية
// ✅ تسجيل فحص جديد لخلية (UPDATED)
router.post("/", authenticateUser, async (req, res) => {
   const {
      hive_id,
      inspection_date,
      queen_seen,
      eggs_seen,
      queen_cell_present,
      brood_quality,
      food_storage,
      sickness_signs,
      frame_count, // total frames at inspection time ✅

      // ✅ NEW fields
      bee_frames,
      brood_frames,
      larvae_present,
      varroa_level, // not_checked | low | medium | high

      revisit_needed,
      revisit_date,
      notes,
   } = req.body;

   if (!hive_id) return res.status(400).json({ error: "hive_id is required" });

   // ---------- helpers ----------
   const toIntOrNull = (v) => (v === undefined || v === null || v === "" ? null : Number(v));
   const isInt = (v) => Number.isInteger(v);

   const fc = toIntOrNull(frame_count);
   const bf = toIntOrNull(bee_frames);
   const brf = toIntOrNull(brood_frames);

   // ---------- validation ----------
   if (fc !== null && (!Number.isFinite(fc) || !isInt(fc) || fc < 0 || fc > 30)) {
      return res.status(400).json({ error: "frame_count must be an integer between 0 and 30" });
   }

   if (bf !== null && (!Number.isFinite(bf) || !isInt(bf) || bf < 0)) {
      return res.status(400).json({ error: "bee_frames must be a non-negative integer" });
   }

   if (brf !== null && (!Number.isFinite(brf) || !isInt(brf) || brf < 0)) {
      return res.status(400).json({ error: "brood_frames must be a non-negative integer" });
   }

   if (fc !== null && bf !== null && bf > fc) {
      return res.status(400).json({ error: "bee_frames cannot be greater than frame_count" });
   }

   if (fc !== null && brf !== null && brf > fc) {
      return res.status(400).json({ error: "brood_frames cannot be greater than frame_count" });
   }

   if (
      larvae_present !== undefined &&
      larvae_present !== null &&
      typeof larvae_present !== "boolean"
   ) {
      return res.status(400).json({ error: "larvae_present must be boolean" });
   }

   if (varroa_level !== undefined && varroa_level !== null) {
      const allowed = new Set(["not_checked", "low", "medium", "high"]);
      if (!allowed.has(varroa_level)) {
         return res.status(400).json({
            error: "varroa_level must be one of: not_checked, low, medium, high",
         });
      }
   }

   // sickness_signs: خلّيه boolean (وإذا جايك من فرونت قديم كنص، نحوله)
   let sicknessBool = sickness_signs;
   if (sickness_signs === "false") sicknessBool = false;
   if (sickness_signs === "true") sicknessBool = true;

   // ---------- insert ----------
   try {
      const { data, error } = await supabase
         .from("hive_inspections")
         .insert([
            {
               hive_id,
               inspection_date: inspection_date || new Date().toISOString().split("T")[0],
               queen_seen,
               eggs_seen,
               queen_cell_present,
               brood_quality,
               food_storage,
               sickness_signs: sicknessBool,
               frame_count: fc,

               // ✅ NEW fields
               bee_frames: bf,
               brood_frames: brf,
               larvae_present: larvae_present ?? null,
               varroa_level: varroa_level ?? null,

               revisit_needed,
               revisit_date,
               notes,
               user_id: req.user.id,
            },
         ])
         .select();

      if (error) return res.status(400).json({ error: error.message });

      res.status(201).json({
         message: "✅ Inspection recorded successfully",
         inspection: data[0],
      });
   } catch (err) {
      console.error(err);
      res.status(500).json({ error: "Unexpected server error" });
   }
});

// 📥 جلب كل الفحوصات لخلية معينة
// 📥 جلب كل الفحوصات لخلية معينة
router.get("/hive/:hive_id", authenticateUser, async (req, res) => {
   const { hive_id } = req.params;

   try {
      const { data: inspections, error } = await supabase
         .from("hive_inspections")
         .select(
            `
         *,
         hives(frame_capacity)
      `
         )
         .eq("hive_id", hive_id)
         .order("inspection_date", { ascending: false });

      if (error) {
         return res.status(400).json({ error: error.message });
      }

      // 🧮 Calculate missing frames
      const result = inspections.map((insp) => ({
         ...insp,
         missing_frames:
            insp.hives?.frame_capacity != null && insp.frame_count != null
               ? insp.hives.frame_capacity - insp.frame_count
               : null,
      }));

      res.status(200).json({ inspections: result });
   } catch (err) {
      console.error(err);
      res.status(500).json({ error: "Unexpected server error" });
   }
});

// 🔔 تنبيهات حسب الفلتر (today, overdue, upcoming, all) + بيانات الخلية والمنحل
// 🔔 GET /inspections/alerts/revisits?filter=today|overdue|upcoming
// 🔔 GET /inspections/alerts/revisits?filter=today|overdue|upcoming
router.get("/alerts/revisits", authenticateUser, async (req, res) => {
   const filter = req.query.filter || "upcoming"; // default to upcoming
   const today = new Date();
   const todayStr = today.toISOString().split("T")[0];

   const upcomingLimit = new Date(today);
   upcomingLimit.setDate(today.getDate() + 3); // next 3 days
   const upcomingLimitStr = upcomingLimit.toISOString().split("T")[0];

   try {
      let query = supabase
         .from("hive_inspections")
         .select(
            `
        inspection_id,
        hive_id,
        revisit_date,
        revisit_needed,
        hives (
          hive_code,
          apiary_id,
          apiaries (
            apiary_name,
            owner_user_id
          )
        )
      `
         )
         .eq("revisit_needed", true)
         // 🔒 Only alerts for hives whose apiary belongs to the logged-in user
         .eq("hives.apiaries.owner_user_id", req.user.id);

      // 🎯 Filter by date
      if (filter === "today") {
         query = query.eq("revisit_date", todayStr);
      } else if (filter === "overdue") {
         query = query.lt("revisit_date", todayStr);
      } else if (filter === "upcoming") {
         query = query.gte("revisit_date", todayStr).lte("revisit_date", upcomingLimitStr);
      }

      query = query.order("revisit_date", { ascending: true });

      const { data, error } = await query;

      if (error) {
         console.error("Error fetching revisit alerts:", error);
         return res.status(400).json({ error: error.message });
      }

      // 🧼 Optional: clean the response so you don't leak owner_user_id to frontend
      const alerts = (data || []).map((row) => ({
         inspection_id: row.inspection_id,
         hive_id: row.hive_id,
         revisit_date: row.revisit_date,
         revisit_needed: row.revisit_needed,
         hive_code: row.hives?.hive_code || null,
         apiary_id: row.hives?.apiary_id || null,
         apiary_name: row.hives?.apiaries?.apiary_name || null,
      }));

      return res.status(200).json({ alerts });
   } catch (err) {
      console.error("Unexpected error in /alerts/revisits:", err);
      return res.status(500).json({ error: "Unexpected server error" });
   }
});

// 🗑️ حذف فحص بناءً على المعرف
router.delete("/:id", authenticateUser, async (req, res) => {
   const { id } = req.params;

   try {
      const { error } = await supabase
         .from("hive_inspections")
         .delete()
         .eq("inspection_id", id)
         .eq("user_id", req.user.id); // Optional: ensure only the owner can delete

      if (error) {
         return res.status(400).json({ error: error.message });
      }

      res.status(200).json({ message: "🗑️ Inspection deleted successfully" });
   } catch (err) {
      console.error(err);
      res.status(500).json({ error: "Unexpected server error" });
   }
});

module.exports = router;
