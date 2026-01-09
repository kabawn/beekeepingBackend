// routes/inspections.js
const express = require("express");
const router = express.Router();
const supabase = require("../utils/supabaseClient");
const authenticateUser = require("../middlewares/authMiddleware");

// ----------------------------
// BeeStats Coach (Rules Engine)
// ----------------------------

// Enumerations (codes only)
const STATUS = {
   GREEN: "green",
   YELLOW: "yellow",
   RED: "red",
};

// Helper: safe number (int) or null
const toIntOrNull = (v) => (v === undefined || v === null || v === "" ? null : Number(v));
const isInt = (v) => Number.isInteger(v);

function analyzeInspection(insp) {
   const {
      queen_seen,
      eggs_seen,
      larvae_present,
      queen_cell_present,
      brood_quality,
      food_storage,
      sickness_signs,
      frame_count,
      bee_frames,
      brood_frames,
      varroa_level,
   } = insp;

   const fc = Number.isFinite(Number(frame_count)) ? Number(frame_count) : null;
   const bf = Number.isFinite(Number(bee_frames)) ? Number(bee_frames) : null;
   const brf = Number.isFinite(Number(brood_frames)) ? Number(brood_frames) : null;

   const beeRatio = fc && bf != null ? bf / fc : null; // colony strength ratio
   const broodRatio = fc && brf != null ? brf / fc : null; // brood area ratio

   // Outputs (codes only)
   const reason_codes = [];
   const action_codes = [];

   let status = STATUS.GREEN;
   let suggested_revisit_days = 7;

   // ---------- Priority 0: invalid / missing critical data ----------
   // (We keep it gentle: if missing, do not mark red, just reduce confidence)
   if (fc === null) {
      reason_codes.push("DATA_MISSING_FRAME_COUNT");
   }
   if (bf === null) {
      reason_codes.push("DATA_MISSING_BEE_FRAMES");
   }
   if (brf === null) {
      reason_codes.push("DATA_MISSING_BROOD_FRAMES");
   }
   if (larvae_present === null || larvae_present === undefined) {
      reason_codes.push("DATA_MISSING_LARVAE");
   }
   if (varroa_level === null || varroa_level === undefined) {
      reason_codes.push("DATA_MISSING_VARROA");
   }

   // ---------- Priority 1: sickness ----------
   if (sickness_signs === true) {
      status = STATUS.RED;
      reason_codes.push("SICKNESS_SIGNS_REPORTED");
      action_codes.push("ACTION_TAKE_PHOTOS_AND_CONFIRM");
      action_codes.push("ACTION_AVOID_TOOL_FRAME_TRANSFER");
      action_codes.push("ACTION_CONTACT_ASSOCIATION_LAB");
      suggested_revisit_days = Math.min(suggested_revisit_days, 2);
   }

   // ---------- Priority 2: queen / brood continuity ----------
   // Eggs are the strongest indicator of a laying queen in the last ~3 days
   if (status !== STATUS.RED) {
      const noEggs = eggs_seen === false;
      const noLarvae = larvae_present === false;

      if (noEggs && noLarvae) {
         status = STATUS.RED;
         reason_codes.push("QUEEN_SUSPECT_NO_EGGS_NO_LARVAE");
         action_codes.push("ACTION_RECHECK_IN_3_4_DAYS");
         action_codes.push("ACTION_TEST_WITH_BROOD_FRAME_OR_PREPARE_QUEEN");
         action_codes.push("ACTION_AVOID_EXPANSION_UNTIL_STABLE");
         suggested_revisit_days = Math.min(suggested_revisit_days, 3);
      } else if (noEggs && larvae_present === true) {
         status = STATUS.YELLOW;
         reason_codes.push("QUEEN_SUSPECT_LARVAE_NO_EGGS");
         action_codes.push("ACTION_RECHECK_IN_5_6_DAYS");
         action_codes.push("ACTION_MONITOR_QUEEN_PERFORMANCE");
         suggested_revisit_days = Math.min(suggested_revisit_days, 5);
      }
   }

   // ---------- Priority 3: swarm / supersedure risk ----------
   // Queen cells can indicate swarm prep OR supersedure. We use strength + brood as proxy.
   if (status !== STATUS.RED && queen_cell_present === true) {
      const strongByFrames = bf != null ? bf >= 7 : false;
      const strongByRatio = beeRatio != null ? beeRatio >= 0.7 : false;
      const strong = strongByFrames || strongByRatio;

      const heavyBrood = brf != null ? brf >= 4 : broodRatio != null ? broodRatio >= 0.35 : false;

      if (strong && heavyBrood) {
         status = STATUS.RED;
         reason_codes.push("SWARM_RISK_HIGH");
         action_codes.push("ACTION_ADD_SPACE_OR_SPLIT");
         action_codes.push("ACTION_RECHECK_QUEEN_CELLS_SOON");
         action_codes.push("ACTION_IMPROVE_VENTILATION");
         suggested_revisit_days = Math.min(suggested_revisit_days, 3);
      } else {
         status = STATUS.YELLOW;
         reason_codes.push("QUEEN_CELLS_PRESENT_MONITOR");
         action_codes.push("ACTION_RECHECK_TO_IDENTIFY_SWARM_OR_SUPERSEDURE");
         action_codes.push("ACTION_ENSURE_SPACE_AND_FOOD");
         suggested_revisit_days = Math.min(suggested_revisit_days, 5);
      }
   }

   // ---------- Priority 4: varroa ----------
   if (varroa_level === "high") {
      status = STATUS.RED;
      reason_codes.push("VARROA_HIGH");
      action_codes.push("ACTION_PLAN_VARROA_TREATMENT");
      action_codes.push("ACTION_RECHECK_VARROA_AFTER_TREATMENT");
      suggested_revisit_days = Math.min(suggested_revisit_days, 3);
   } else if (status === STATUS.GREEN && varroa_level === "medium") {
      status = STATUS.YELLOW;
      reason_codes.push("VARROA_MEDIUM");
      action_codes.push("ACTION_MONITOR_VARROA_AND_PLAN_WINDOW");
      suggested_revisit_days = Math.min(suggested_revisit_days, 7);
   } else if (varroa_level === "low") {
      reason_codes.push("VARROA_LOW");
   } else if (varroa_level === "not_checked") {
      reason_codes.push("VARROA_NOT_CHECKED");
      action_codes.push("ACTION_CHECK_VARROA_NEXT_VISIT");
   }

   // ---------- Priority 5: food ----------
   const lowFood = ["Weak", "Poor", "Low"].includes(food_storage);
   if (lowFood) {
      if (status === STATUS.GREEN) status = STATUS.YELLOW;
      reason_codes.push("FOOD_LOW");
      action_codes.push("ACTION_FEED_APPROPRIATELY_SEASON");
      action_codes.push("ACTION_AVOID_EXPANSION_UNTIL_FOOD_OK");
      suggested_revisit_days = Math.min(suggested_revisit_days, 5);
   } else if (food_storage) {
      // useful as positive context
      if (["Good", "Excellent", "High"].includes(food_storage)) {
         reason_codes.push("FOOD_OK");
      }
   }

   // ---------- Secondary: strength / brood pattern hints ----------
   // Only if still green (no serious flags)
   if (status === STATUS.GREEN) {
      if (beeRatio != null && beeRatio < 0.4) {
         status = STATUS.YELLOW;
         reason_codes.push("COLONY_WEAK");
         action_codes.push("ACTION_AVOID_EXPANSION_SUPPORT_GROWTH");
         suggested_revisit_days = Math.min(suggested_revisit_days, 7);
      }

      if (broodRatio != null && broodRatio < 0.2 && eggs_seen === true) {
         status = STATUS.YELLOW;
         reason_codes.push("BROOD_SMALL_BUT_EGGS_PRESENT");
         action_codes.push("ACTION_MONITOR_BROOD_AND_NUTRITION");
         suggested_revisit_days = Math.min(suggested_revisit_days, 7);
      }
   }

   // Brood quality can add context (not decisive alone)
   if (brood_quality) {
      if (["Poor", "Weak"].includes(brood_quality)) {
         if (status === STATUS.GREEN) status = STATUS.YELLOW;
         reason_codes.push("BROOD_QUALITY_LOW");
         action_codes.push("ACTION_CHECK_QUEEN_AND_VARROA");
         suggested_revisit_days = Math.min(suggested_revisit_days, 6);
      } else if (["Good", "Excellent"].includes(brood_quality)) {
         reason_codes.push("BROOD_QUALITY_OK");
      }
   }

   // Ensure we return something sensible
   if (reason_codes.length === 0) {
      reason_codes.push("INSPECTION_STABLE");
   }

   if (action_codes.length === 0) {
      action_codes.push("ACTION_CONTINUE_WEEKLY_INSPECTIONS");
      action_codes.push("ACTION_KEEP_NOTES_CONSISTENT");
   }

   // Remove duplicate codes while keeping order
   const uniq = (arr) => [...new Set(arr)];

   return {
      status, // green | yellow | red
      reason_codes: uniq(reason_codes),
      action_codes: uniq(action_codes),
      metrics: {
         bee_ratio: beeRatio,
         brood_ratio: broodRatio,
         frame_count: fc,
         bee_frames: bf,
         brood_frames: brf,
      },
      suggested_revisit_days,
   };
}

// ----------------------------
// ✅ POST /inspections
// ----------------------------
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
      frame_count,

      // NEW
      bee_frames,
      brood_frames,
      larvae_present,
      varroa_level,

      revisit_needed,
      revisit_date,
      notes,
   } = req.body;

   if (!hive_id) return res.status(400).json({ error: "hive_id is required" });

   // ---------- parse ints ----------
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

   // 🔥 Important beekeeping logic: brood frames generally cannot exceed bee-covered frames
   if (bf !== null && brf !== null && brf > bf) {
      return res.status(400).json({ error: "brood_frames cannot be greater than bee_frames" });
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

   // sickness_signs: allow legacy "true"/"false" strings, but store boolean
   let sicknessBool = sickness_signs;
   if (sickness_signs === "false") sicknessBool = false;
   if (sickness_signs === "true") sicknessBool = true;
   if (sicknessBool !== undefined && sicknessBool !== null && typeof sicknessBool !== "boolean") {
      return res.status(400).json({ error: "sickness_signs must be boolean" });
   }

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

      const inspection = data[0];
      const analysis = analyzeInspection(inspection);

      return res.status(201).json({
         message: "✅ Inspection recorded successfully",
         inspection,
         analysis,
      });
   } catch (err) {
      console.error(err);
      return res.status(500).json({ error: "Unexpected server error" });
   }
});

// ----------------------------
// ✅ GET /inspections/hive/:hive_id
// ----------------------------
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

      if (error) return res.status(400).json({ error: error.message });

      const result = (inspections || []).map((insp) => ({
         ...insp,
         missing_frames:
            insp.hives?.frame_capacity != null && insp.frame_count != null
               ? insp.hives.frame_capacity - insp.frame_count
               : null,

         // Optional helpful ratios for UI (no translation needed)
         bee_ratio:
            insp.frame_count && insp.bee_frames != null ? insp.bee_frames / insp.frame_count : null,
         brood_ratio:
            insp.frame_count && insp.brood_frames != null
               ? insp.brood_frames / insp.frame_count
               : null,
      }));

      return res.status(200).json({ inspections: result });
   } catch (err) {
      console.error(err);
      return res.status(500).json({ error: "Unexpected server error" });
   }
});

// ----------------------------
// ✅ GET /inspections/alerts/revisits
// ----------------------------
router.get("/alerts/revisits", authenticateUser, async (req, res) => {
   const filter = req.query.filter || "upcoming";
   const today = new Date();
   const todayStr = today.toISOString().split("T")[0];

   const upcomingLimit = new Date(today);
   upcomingLimit.setDate(today.getDate() + 3);
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
         .eq("hives.apiaries.owner_user_id", req.user.id);

      if (filter === "today") {
         query = query.eq("revisit_date", todayStr);
      } else if (filter === "overdue") {
         query = query.lt("revisit_date", todayStr);
      } else if (filter === "upcoming") {
         query = query.gte("revisit_date", todayStr).lte("revisit_date", upcomingLimitStr);
      }

      query = query.order("revisit_date", { ascending: true });

      const { data, error } = await query;

      if (error) return res.status(400).json({ error: error.message });

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

// ----------------------------
// ✅ DELETE /inspections/:id
// ----------------------------
router.delete("/:id", authenticateUser, async (req, res) => {
   const { id } = req.params;

   try {
      const { error } = await supabase
         .from("hive_inspections")
         .delete()
         .eq("inspection_id", id)
         .eq("user_id", req.user.id);

      if (error) return res.status(400).json({ error: error.message });

      return res.status(200).json({ message: "🗑️ Inspection deleted successfully" });
   } catch (err) {
      console.error(err);
      return res.status(500).json({ error: "Unexpected server error" });
   }
});

module.exports = router;
