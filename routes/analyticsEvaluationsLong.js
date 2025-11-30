// routes/analyticsEvaluationsLong.js
const express = require("express");
const router = express.Router();
const pool = require("../db");
const authenticateUser = require("../middlewares/authMiddleware");

/**
 * GET /analytics/evaluations-long
 *
 * Generic "long" format for all users:
 * Date | Rucher | Caisse | Souche | Colonie | Evaluation | Valeur | Info complement
 *
 * Optional query params:
 *  - year        → filter by eval year
 *  - apiary_id   → filter by apiary
 *  - hive_id     → filter by hive
 */
router.get("/evaluations-long", authenticateUser, async (req, res) => {
  const userId = req.user.id;
  const { year, apiary_id, hive_id } = req.query;

  try {
    // 1️⃣ Build WHERE dynamically
    const params = [userId];
    let where = `a.owner_user_id = $1`;

    if (apiary_id) {
      params.push(apiary_id);
      where += ` AND e.apiary_id = $${params.length}`;
    }

    if (hive_id) {
      params.push(hive_id);
      where += ` AND e.hive_id = $${params.length}`;
    }

    if (year) {
      params.push(year);
      where += ` AND EXTRACT(YEAR FROM e.eval_date) = $${params.length}`;
    }

    // 2️⃣ Latest hive_descriptors per hive/year (for queen line / origin → Souche)
    const query = `
      WITH latest_descriptors AS (
        SELECT DISTINCT ON (hive_id, year)
               hive_id,
               year,
               season_label,
               queen_origin,
               queen_year,
               queen_line,
               reproduction_method,
               overwintering_result,
               treatment_strategy,
               hive_purpose_snapshot
        FROM hive_descriptors
        ORDER BY hive_id, year, created_at DESC
      )
      SELECT
        e.eval_date,
        e.season_label      AS eval_season_label,
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
        e.notes,
        a.apiary_name,
        h.hive_code,
        h.hive_id,
        d.queen_line,
        d.queen_origin
      FROM hive_evaluations e
      JOIN apiaries a ON a.apiary_id = e.apiary_id
      JOIN hives h ON h.hive_id = e.hive_id
      LEFT JOIN latest_descriptors d
        ON d.hive_id = e.hive_id
       AND d.year = EXTRACT(YEAR FROM e.eval_date)
      WHERE ${where}
      ORDER BY e.eval_date ASC, h.hive_code ASC, e.hive_evaluation_id ASC
    `;

    const { rows } = await pool.query(query, params);

    // 3️⃣ Transform each evaluation into multiple “metric rows”
    const exportRows = [];

    for (const row of rows) {
      const base = {
        date: row.eval_date,
        rucher: row.apiary_name,
        caisse: row.hive_code,
        // 🟡 "souche": we try queen_line first, fallback to origin
        souche: row.queen_line || row.queen_origin || null,
        colonie: row.hive_id, // your internal colony ID = hive_id for now
      };

      // Context info / comments
      const infoParts = [];
      if (row.eval_type) infoParts.push(row.eval_type);
      if (row.eval_season_label) infoParts.push(row.eval_season_label);
      if (row.treatment_type) infoParts.push(`Traitement: ${row.treatment_type}`);
      if (row.notes) infoParts.push(row.notes);
      const infoComplement = infoParts.join(" | ") || null;

      const pushMetric = (key, labelFr, labelEn, value) => {
        if (value === null || value === undefined) return;
        exportRows.push({
          ...base,
          evaluation_key: key,           // stable code
          evaluation_label_fr: labelFr,  // for French users / JF
          evaluation_label_en: labelEn,  // for English users
          valeur: value,
          info_complement: infoComplement,
        });
      };

      // Honey / frames
      pushMetric(
        "honey_yield_kg",
        "Production miel (Kg)",
        "Honey yield (kg)",
        row.honey_yield_kg
      );
      pushMetric(
        "brood_frames",
        "Cadres de couvain",
        "Brood frames",
        row.brood_frames
      );
      pushMetric(
        "food_frames",
        "Cadres de nourriture",
        "Food frames",
        row.food_frames
      );

      // Scores
      pushMetric(
        "population_score",
        "Force de population (1–4)",
        "Population score (1–4)",
        row.population_score
      );
      pushMetric(
        "temperament_score",
        "Tempérament (1–4, 1 = calme, 4 = agressif)",
        "Temperament (1–4, 1 = calm, 4 = aggressive)",
        row.temperament_score
      );
      pushMetric(
        "varroa_level",
        "Niveau de varroa",
        "Varroa level",
        row.varroa_level
      );
      pushMetric(
        "swarming_tendency",
        "Tendance à l’essaimage (0–4)",
        "Swarming tendency (0–4)",
        row.swarming_tendency
      );

      // Booleans as 0/1
      if (row.migration_used !== null && row.migration_used !== undefined) {
        pushMetric(
          "migration_used",
          "Transhumance utilisée (0/1)",
          "Migration used (0/1)",
          row.migration_used ? 1 : 0
        );
      }
      if (row.feeding_done !== null && row.feeding_done !== undefined) {
        pushMetric(
          "feeding_done",
          "Nourrissement effectué (0/1)",
          "Feeding done (0/1)",
          row.feeding_done ? 1 : 0
        );
      }
    }

    return res.json({
      count: exportRows.length,
      rows: exportRows,
    });
  } catch (err) {
    console.error("🔴 GET /analytics/evaluations-long error:", err);
    return res.status(500).json({
      error: "Server error while building evaluations export",
    });
  }
});

module.exports = router;
