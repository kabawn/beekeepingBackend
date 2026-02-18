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

// -------- Helpers --------
const toIntOrNull = (v) => (v === undefined || v === null || v === "" ? null : Number(v));
const isInt = (v) => Number.isInteger(v);
const uniq = (arr) => [...new Set(arr)];
const clamp = (n, min, max) => Math.max(min, Math.min(max, n));

function safeNum(v) {
   const n = Number(v);
   return Number.isFinite(n) ? n : null;
}

function daysBetween(a, b) {
   // a, b are "YYYY-MM-DD"
   if (!a || !b) return null;
   const da = new Date(a);
   const db = new Date(b);
   const diff = (da - db) / (1000 * 60 * 60 * 24);
   return Number.isFinite(diff) ? diff : null;
}

function normalizeFood(food_storage) {
   if (!food_storage) return null;
   const v = String(food_storage).toLowerCase();
   if (["weak", "poor", "low", "faible", "pauvre"].includes(v)) return "low";
   if (["good", "ok", "medium", "correct", "moyen"].includes(v)) return "ok";
   if (["excellent", "high", "strong", "fort"].includes(v)) return "high";
   return "ok";
}

function normalizeBroodQuality(brood_quality) {
   if (!brood_quality) return null;
   const v = String(brood_quality).toLowerCase();
   if (["poor", "weak", "bad", "faible", "mauvais"].includes(v)) return "low";
   if (["good", "ok", "medium", "correct", "moyen"].includes(v)) return "ok";
   if (["excellent", "great", "high", "fort"].includes(v)) return "high";
   return "ok";
}

function normalizeVarroa(varroa_level) {
   if (!varroa_level) return null;
   const v = String(varroa_level).toLowerCase();
   const allowed = new Set(["not_checked", "low", "medium", "high"]);
   return allowed.has(v) ? v : null;
}

// ----------------------------
// Scoring / Confidence Model
// ----------------------------
const REASON_PENALTY = {
   // Critical
   SICKNESS_SIGNS_REPORTED: 60,
   QUEEN_SUSPECT_NO_EGGS_NO_LARVAE: 55,
   SWARM_RISK_HIGH: 50,
   VARROA_HIGH: 45,

   // Medium
   QUEEN_SUSPECT_LARVAE_NO_EGGS: 25,
   QUEEN_CELLS_PRESENT_MONITOR: 20,
   VARROA_MEDIUM: 20,
   FOOD_LOW: 20,
   COLONY_WEAK: 15,
   BROOD_QUALITY_LOW: 15,
   BROOD_SMALL_BUT_EGGS_PRESENT: 10,

   // Positive/neutral (no penalty)
   VARROA_LOW: 0,
   FOOD_OK: 0,
   BROOD_QUALITY_OK: 0,
   INSPECTION_STABLE: 0,

   // Missing data (tiny penalty)
   DATA_MISSING_FRAME_COUNT: 5,
   DATA_MISSING_BEE_FRAMES: 5,
   DATA_MISSING_BROOD_FRAMES: 5,
   DATA_MISSING_LARVAE: 5,
   DATA_MISSING_VARROA: 5,
};

// Missing-data reasons used to compute confidence
const MISSING_DATA_REASONS = new Set([
   "DATA_MISSING_FRAME_COUNT",
   "DATA_MISSING_BEE_FRAMES",
   "DATA_MISSING_BROOD_FRAMES",
   "DATA_MISSING_LARVAE",
   "DATA_MISSING_VARROA",
]);

function computeScore(status, reason_codes) {
   let score = 100;
   for (const r of reason_codes || []) {
      score -= REASON_PENALTY[r] ?? 0;
   }
   score = clamp(score, 0, 100);

   // enforce bands by status (UI-friendly)
   if (status === STATUS.RED) score = Math.min(score, 49);
   if (status === STATUS.YELLOW) score = Math.min(score, 79);
   if (status === STATUS.GREEN) score = Math.max(score, 80);

   return score;
}

function computeConfidence(reason_codes) {
   // Start high, subtract a bit per missing critical metric
   let c = 1.0;
   const missing = (reason_codes || []).filter((r) => MISSING_DATA_REASONS.has(r)).length;
   c -= missing * 0.12;
   return clamp(Number(c.toFixed(2)), 0.35, 1.0);
}

// ----------------------------
// Smart chips generator (codes only)
// ----------------------------
function buildSmartChips(analysis) {
   // Return small UI-ready chips as codes (no language here)
   const chips = [];

   if (analysis.status === STATUS.GREEN) chips.push("CHIP_STABLE");
   if (analysis.status === STATUS.YELLOW) chips.push("CHIP_NEEDS_ATTENTION");
   if (analysis.status === STATUS.RED) chips.push("CHIP_URGENT");

   // pick up to 3 strong reasons to display
   const priority = [
      "SICKNESS_SIGNS_REPORTED",
      "QUEEN_SUSPECT_NO_EGGS_NO_LARVAE",
      "SWARM_RISK_HIGH",
      "VARROA_HIGH",
      "FOOD_LOW",
      "QUEEN_SUSPECT_LARVAE_NO_EGGS",
      "VARROA_MEDIUM",
      "COLONY_WEAK",
      "BROOD_QUALITY_LOW",
      "BROOD_SMALL_BUT_EGGS_PRESENT",
      "VARROA_NOT_CHECKED",
   ];

   for (const p of priority) {
      if (analysis.reason_codes.includes(p)) chips.push(`CHIP_${p}`);
      if (chips.length >= 5) break;
   }

   return uniq(chips);
}

// ----------------------------
// Main analysis function
// ----------------------------
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

   const fc = safeNum(frame_count);
   const bf = safeNum(bee_frames);
   const brf = safeNum(brood_frames);

   const beeRatio = fc && bf != null ? bf / fc : null;
   const broodRatio = fc && brf != null ? brf / fc : null;

   const food = normalizeFood(food_storage);
   const broodQ = normalizeBroodQuality(brood_quality);
   const varroa = normalizeVarroa(varroa_level);

   const reason_codes = [];
   const action_codes = [];

   let status = STATUS.GREEN;
   let suggested_revisit_days = 7;

   // ---------- Missing data (affects confidence, not always status) ----------
   if (fc === null) reason_codes.push("DATA_MISSING_FRAME_COUNT");
   if (bf === null) reason_codes.push("DATA_MISSING_BEE_FRAMES");
   if (brf === null) reason_codes.push("DATA_MISSING_BROOD_FRAMES");
   if (larvae_present === null || larvae_present === undefined)
      reason_codes.push("DATA_MISSING_LARVAE");
   if (varroa === null || varroa === undefined) reason_codes.push("DATA_MISSING_VARROA");

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
   if (status !== STATUS.RED) {
      const noEggs = eggs_seen === false;
      const noLarvae = larvae_present === false;

      // Eggs + larvae missing is strong warning (queen issue or just too early)
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
         // Use existing action codes (avoid unknown keys)
         action_codes.push("ACTION_RECHECK_QUEEN_CELLS_SOON");
         action_codes.push("ACTION_ADD_SPACE_OR_SPLIT");
         action_codes.push("ACTION_FEED_APPROPRIATELY_SEASON");
         suggested_revisit_days = Math.min(suggested_revisit_days, 5);
      }
   }

   // ---------- Priority 4: varroa ----------
   if (varroa === "high") {
      status = STATUS.RED;
      reason_codes.push("VARROA_HIGH");
      action_codes.push("ACTION_PLAN_VARROA_TREATMENT");
      action_codes.push("ACTION_RECHECK_VARROA_AFTER_TREATMENT");
      suggested_revisit_days = Math.min(suggested_revisit_days, 3);
   } else if (status === STATUS.GREEN && varroa === "medium") {
      status = STATUS.YELLOW;
      reason_codes.push("VARROA_MEDIUM");
      action_codes.push("ACTION_MONITOR_VARROA_AND_PLAN_WINDOW");
      suggested_revisit_days = Math.min(suggested_revisit_days, 7);
   } else if (varroa === "low") {
      reason_codes.push("VARROA_LOW");
   } else if (varroa === "not_checked") {
      reason_codes.push("VARROA_NOT_CHECKED");
      action_codes.push("ACTION_CHECK_VARROA_NEXT_VISIT");
   }

   // ---------- Priority 5: food ----------
   if (food === "low") {
      if (status === STATUS.GREEN) status = STATUS.YELLOW;
      reason_codes.push("FOOD_LOW");
      action_codes.push("ACTION_FEED_APPROPRIATELY_SEASON");
      action_codes.push("ACTION_AVOID_EXPANSION_UNTIL_FOOD_OK");
      suggested_revisit_days = Math.min(suggested_revisit_days, 5);
   } else if (food === "high" || food === "ok") {
      reason_codes.push("FOOD_OK");
   }

   // ---------- Secondary: strength / brood pattern hints ----------
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

   // Brood quality context
   if (broodQ === "low") {
      if (status === STATUS.GREEN) status = STATUS.YELLOW;
      reason_codes.push("BROOD_QUALITY_LOW");
      action_codes.push("ACTION_CHECK_QUEEN_AND_VARROA");
      suggested_revisit_days = Math.min(suggested_revisit_days, 6);
   } else if (broodQ === "high" || broodQ === "ok") {
      reason_codes.push("BROOD_QUALITY_OK");
   }

   if (reason_codes.length === 0) reason_codes.push("INSPECTION_STABLE");

   if (action_codes.length === 0) {
      action_codes.push("ACTION_CONTINUE_WEEKLY_INSPECTIONS");
      action_codes.push("ACTION_KEEP_NOTES_CONSISTENT");
   }

   const reasonU = uniq(reason_codes);
   const actionU = uniq(action_codes);

   const score = computeScore(status, reasonU);
   const confidence = computeConfidence(reasonU);

   const analysis = {
      status, // green | yellow | red
      score, // 0..100
      confidence, // 0.35..1
      reason_codes: reasonU,
      action_codes: actionU,
      metrics: {
         bee_ratio: beeRatio,
         brood_ratio: broodRatio,
         frame_count: fc,
         bee_frames: bf,
         brood_frames: brf,
      },
      suggested_revisit_days,
   };

   return {
      ...analysis,
      chips: buildSmartChips(analysis), // UI helper
      smart_summary: {
         // codes only - UI translates
         top_reasons: reasonU.slice(0, 3),
         top_actions: actionU.slice(0, 3),
      },
   };
}

// ----------------------------
// Hive summary (across inspections)
// ----------------------------
function buildHiveSummary(inspectionsSortedDesc) {
   // inspectionsSortedDesc is latest first
   const list = inspectionsSortedDesc || [];
   if (list.length === 0) {
      return {
         has_data: false,
         latest_date: null,
         latest_status: null,
         latest_score: null,
         trend: null,
         counters: { green: 0, yellow: 0, red: 0 },
         next_revisit_date: null,
         smart: {
            headline_code: "HIVE_NO_INSPECTIONS",
            chips: ["CHIP_NO_DATA"],
            top_reasons: [],
            top_actions: [],
         },
      };
   }

   const latest = list[0];
   const prev = list[1];

   const counters = { green: 0, yellow: 0, red: 0 };
   for (const x of list) {
      const st = x.analysis?.status;
      if (st === STATUS.GREEN) counters.green++;
      else if (st === STATUS.YELLOW) counters.yellow++;
      else if (st === STATUS.RED) counters.red++;
   }

   // Trend based on score difference
   let trend = null;
   if (latest?.analysis?.score != null && prev?.analysis?.score != null) {
      const diff = latest.analysis.score - prev.analysis.score;
      trend = diff > 5 ? "improving" : diff < -5 ? "declining" : "stable";
   }

   // Next revisit: pick nearest future revisit_date among revisit_needed = true
   let nextRevisit = null;
   const todayStr = new Date().toISOString().split("T")[0];
   for (const x of list) {
      if (x.revisit_needed && x.revisit_date) {
         // keep only today or future
         if (x.revisit_date >= todayStr) {
            if (!nextRevisit || x.revisit_date < nextRevisit) nextRevisit = x.revisit_date;
         }
      }
   }

   // Headline code
   let headline_code = "HIVE_STABLE";
   if (latest.analysis?.status === STATUS.RED) headline_code = "HIVE_URGENT";
   else if (latest.analysis?.status === STATUS.YELLOW) headline_code = "HIVE_NEEDS_ATTENTION";

   // If declining trend, override headline
   if (trend === "declining" && latest.analysis?.status !== STATUS.RED) {
      headline_code = "HIVE_TREND_DECLINING";
   }

   return {
      has_data: true,
      latest_date: latest.inspection_date,
      latest_status: latest.analysis?.status ?? null,
      latest_score: latest.analysis?.score ?? null,
      latest_confidence: latest.analysis?.confidence ?? null,
      trend,
      counters,
      next_revisit_date: nextRevisit,
      smart: {
         headline_code,
         chips: latest.analysis?.chips ?? [],
         top_reasons: latest.analysis?.smart_summary?.top_reasons ?? [],
         top_actions: latest.analysis?.smart_summary?.top_actions ?? [],
      },
   };
}
// ----------------------------
// ✅ GET /inspections
// Returns: inspections[] (with analysis + ratios) for current user
// Optional query params:
//   - limit (default 100, max 500)
//   - offset (default 0)
// ----------------------------
router.get("/", authenticateUser, async (req, res) => {
  const userId = req.user.id;

  const limit = Math.min(parseInt(req.query.limit ?? "100", 10) || 100, 500);
  const offset = parseInt(req.query.offset ?? "0", 10) || 0;

  try {
    const { data: inspections, error } = await supabase
      .from("hive_inspections")
      .select(
        `
          *,
          hives (
            hive_code,
            frame_capacity,
            apiary_id,
            apiaries (
              apiary_name,
              owner_user_id
            )
          )
        `
      )
      .eq("user_id", userId)
      // ✅ filtre ownership redondant (sécurité), au cas où
      .eq("hives.apiaries.owner_user_id", userId)
      .order("inspection_date", { ascending: false })
      .range(offset, offset + limit - 1);

    if (error) return res.status(400).json({ error: error.message });

    const computed = (inspections || []).map((insp) => {
      const analysis = analyzeInspection(insp);

      const frameCapacity = insp.hives?.frame_capacity ?? null;
      const missingFrames =
        frameCapacity != null && insp.frame_count != null
          ? frameCapacity - insp.frame_count
          : null;

      const bee_ratio =
        insp.frame_count && insp.bee_frames != null
          ? insp.bee_frames / insp.frame_count
          : null;

      const brood_ratio =
        insp.frame_count && insp.brood_frames != null
          ? insp.brood_frames / insp.frame_count
          : null;

      return {
        ...insp,

        // ✅ champs “computed” cohérents avec /inspections/hive/:hive_id
        missing_frames: missingFrames,
        bee_ratio,
        brood_ratio,
        analysis,

        // ✅ champs utiles front (évite d’aller chercher deep nested)
        hive_code: insp.hives?.hive_code ?? null,
        apiary_id: insp.hives?.apiary_id ?? null,
        apiary_name: insp.hives?.apiaries?.apiary_name ?? null,
      };
    });

    // Optionnel : trend comme sur /hive/:hive_id (mais ici c’est global, donc trend moins pertinent)
    // -> je ne le calcule pas pour éviter une interprétation bizarre cross-hives.

    return res.status(200).json({
      inspections: computed,
      pagination: { limit, offset, returned: computed.length },
    });
  } catch (err) {
    console.error("Unexpected error in GET /inspections:", err);
    return res.status(500).json({ error: "Unexpected server error" });
  }
});


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

   // parse ints
   const fc = toIntOrNull(frame_count);
   const bf = toIntOrNull(bee_frames);
   const brf = toIntOrNull(brood_frames);

   // validation
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
   // beekeeping logic: brood frames cannot exceed bee-covered frames
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
      if (!allowed.has(String(varroa_level))) {
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

      // attach analysis (not stored, computed)
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
// Returns: inspections[] (with analysis + ratios) + summary
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
         .eq("user_id", req.user.id)

         .order("inspection_date", { ascending: false });

      if (error) return res.status(400).json({ error: error.message });

      const computed = (inspections || []).map((insp) => {
         const analysis = analyzeInspection(insp);

         const frameCapacity = insp.hives?.frame_capacity ?? null;
         const missingFrames =
            frameCapacity != null && insp.frame_count != null
               ? frameCapacity - insp.frame_count
               : null;

         const bee_ratio =
            insp.frame_count && insp.bee_frames != null ? insp.bee_frames / insp.frame_count : null;

         const brood_ratio =
            insp.frame_count && insp.brood_frames != null
               ? insp.brood_frames / insp.frame_count
               : null;

         return {
            ...insp,
            missing_frames: missingFrames,
            bee_ratio,
            brood_ratio,
            analysis,
         };
      });

      // Trend per item (latest vs previous)
      for (let i = 0; i < computed.length; i++) {
         const current = computed[i];
         const prev = computed[i + 1];
         if (!prev?.analysis?.score) {
            current.smart_trend = null;
            current.smart_score_delta = null;
            continue;
         }
         const diff = current.analysis.score - prev.analysis.score;
         current.smart_score_delta = Number(diff.toFixed(0));
         current.smart_trend = diff > 5 ? "improving" : diff < -5 ? "declining" : "stable";
      }

      const summary = buildHiveSummary(computed);

      return res.status(200).json({
         inspections: computed,
         summary, // NEW (doesn't break existing clients)
      });
   } catch (err) {
      console.error(err);
      return res.status(500).json({ error: "Unexpected server error" });
   }
});

// ----------------------------
// ✅ GET /inspections/hive/:hive_id/summary
// Small endpoint if you want the summary alone
// ----------------------------
router.get("/hive/:hive_id/summary", authenticateUser, async (req, res) => {
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
         .eq("user_id", req.user.id)

         .order("inspection_date", { ascending: false })
         .limit(30);

      if (error) return res.status(400).json({ error: error.message });

      const computed = (inspections || []).map((insp) => ({
         ...insp,
         analysis: analyzeInspection(insp),
      }));

      const summary = buildHiveSummary(computed);
      return res.status(200).json({ summary });
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
         .eq("user_id", req.user.id); // ✅ يمنع أي تسريب 100%

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
