const express = require("express");
const router = express.Router();
const pool = require("../db");
const authenticateUser = require("../middlewares/authMiddleware");

/**
 * GET /api/hive-performance/apiaries/:apiaryId
 *
 * Returns a flat list of rows combining:
 * - hive info (code, type, purpose)
 * - evaluation data (hive_evaluations)
 * - descriptor data (hive_descriptors) for the same hive + year
 *
 * 1 row = 1 evaluation.
 */
router.get("/apiaries/:apiaryId", authenticateUser, async (req, res) => {
  const userId = req.user.id;
  const { apiaryId } = req.params;

  try {
    const apiaryIdInt = parseInt(apiaryId, 10);
    if (!Number.isInteger(apiaryIdInt)) {
      return res.status(400).json({ error: "Invalid apiary id" });
    }

    // 🧠 We join:
    // - apiaries (ownership)
    // - hives (code/type/purpose)
    // - hive_evaluations (measured data)
    // - hive_descriptors (same hive + same year as eval_date if available)
    const { rows } = await pool.query(
      `
      SELECT
        -- apiary
        a.apiary_id,
        a.apiary_name,

        -- hive
        h.hive_id,
        h.hive_code,
        h.hive_type,
        h.hive_purpose,

        -- evaluation
        e.hive_evaluation_id,
        e.eval_date,
        e.season_label AS eval_season_label,
        e.eval_type,
        e.honey_yield_kg,
        e.brood_frames,
        e.food_frames,
        e.population_score,
        e.temperament_score,
        e.varroa_level,
        e.swarming_tendency,
        e.migration_used,
        e.feeding_done,
        e.treatment_type,
        e.notes AS eval_notes,

        -- descriptor (matched by hive + year of eval_date)
        d.hive_descriptor_id,
        d.year AS descriptor_year,
        d.season_label AS descriptor_season_label,
        d.queen_origin,
        d.queen_year,
        d.queen_line,
        d.reproduction_method,
        d.overwintering_result,
        d.treatment_strategy,
        d.hive_purpose_snapshot,
        d.notes AS descriptor_notes
      FROM hive_evaluations e
      JOIN apiaries a
        ON a.apiary_id = e.apiary_id
      JOIN hives h
        ON h.hive_id = e.hive_id
      LEFT JOIN hive_descriptors d
        ON d.hive_id = e.hive_id
       AND d.year = EXTRACT(YEAR FROM e.eval_date)
      WHERE e.apiary_id = $1
        AND a.owner_user_id = $2
      ORDER BY e.eval_date DESC, h.hive_code ASC;
      `,
      [apiaryIdInt, userId]
    );

    return res.json({ performance: rows });
  } catch (err) {
    console.error("🔴 GET /api/hive-performance/apiaries/:apiaryId error:", err);
    return res.status(500).json({ error: "Server error while fetching hive performance" });
  }
});

module.exports = router;
