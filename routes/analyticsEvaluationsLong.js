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


// GET /analytics/evaluations-long/export
// Returns a CSV file ready for Excel (one line per evaluation "metric")
router.get("/evaluations-long/export", authenticateUser, async (req, res) => {
  const userId = req.user.id;
  const { year, apiary_id, hive_id } = req.query || {};

  try {
    // 🧠 Same base query as /evaluations-long (copy/paste logic)
    const params = [userId];
    let idx = params.length + 1;

    let where = `
      a.owner_user_id = $1
    `;

    // optional: filter by year (on eval_date)
    if (year) {
      where += ` AND EXTRACT(YEAR FROM e.eval_date) = $${idx++}`;
      params.push(Number(year));
    }

    // optional: filter by apiary
    if (apiary_id) {
      where += ` AND e.apiary_id = $${idx++}`;
      params.push(Number(apiary_id));
    }

    // optional: filter by hive
    if (hive_id) {
      where += ` AND e.hive_id = $${idx++}`;
      params.push(Number(hive_id));
    }

    const sql = `
      SELECT
        e.eval_date AS date,
        a.apiary_name AS rucher,
        h.hive_code AS caisse,
        d.queen_line AS souche,
        e.hive_id::text AS colonie,
        e.eval_type,
        e.season_label,
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
        e.notes
      FROM hive_evaluations e
      JOIN apiaries a ON a.apiary_id = e.apiary_id
      JOIN hives h ON h.hive_id = e.hive_id
      LEFT JOIN hive_descriptors d
        ON d.hive_id = e.hive_id
       AND d.year = EXTRACT(YEAR FROM e.eval_date)::int
      WHERE ${where}
      ORDER BY e.eval_date, h.hive_code, e.hive_id
    `;

    const { rows } = await pool.query(sql, params);

    // 🧩 Map DB fields to "long" lines
    const FIELDS = [
      {
        key: "honey_yield_kg",
        label_fr: "Production miel (Kg)",
        label_en: "Honey yield (kg)",
        getValue: (r) => r.honey_yield_kg,
      },
      {
        key: "brood_frames",
        label_fr: "Cadres de couvain",
        label_en: "Brood frames",
        getValue: (r) => r.brood_frames,
      },
      {
        key: "food_frames",
        label_fr: "Cadres de nourriture",
        label_en: "Food frames",
        getValue: (r) => r.food_frames,
      },
      {
        key: "population_score",
        label_fr: "Force de population (1–4)",
        label_en: "Population score (1–4)",
        getValue: (r) => r.population_score,
      },
      {
        key: "temperament_score",
        label_fr: "Tempérament (1–4, 1 = calme, 4 = agressif)",
        label_en: "Temperament (1–4, 1 = calm, 4 = aggressive)",
        getValue: (r) => r.temperament_score,
      },
      {
        key: "varroa_level",
        label_fr: "Niveau de varroa",
        label_en: "Varroa level",
        getValue: (r) => r.varroa_level,
      },
      {
        key: "swarming_tendency",
        label_fr: "Tendance à l’essaimage (0–4)",
        label_en: "Swarming tendency (0–4)",
        getValue: (r) => r.swarming_tendency,
      },
      {
        key: "migration_used",
        label_fr: "Transhumance utilisée (0/1)",
        label_en: "Migration used (0/1)",
        getValue: (r) => (r.migration_used ? 1 : 0),
      },
      {
        key: "feeding_done",
        label_fr: "Nourrissement effectué (0/1)",
        label_en: "Feeding done (0/1)",
        getValue: (r) => (r.feeding_done ? 1 : 0),
      },
    ];

    const longRows = [];

    for (const r of rows) {
      for (const f of FIELDS) {
        const v = f.getValue(r);
        if (v === null || v === undefined || v === "") continue;

        const infoParts = [];
        if (r.eval_type) infoParts.push(r.eval_type);
        if (r.season_label) infoParts.push(r.season_label);
        if (r.treatment_type)
          infoParts.push(`Traitement: ${r.treatment_type}`);
        if (r.notes) infoParts.push(r.notes);

        const info_complement = infoParts.join(" | ");

        longRows.push({
          date: r.date,
          rucher: r.rucher,
          caisse: r.caisse,
          souche: r.souche || "",
          colonie: r.colonie,
          evaluation_label_fr: f.label_fr,
          valeur: v,
          info_complement,
        });
      }
    }

    // 🧾 Build CSV (semicolon for FR Excel)
    const escapeCsv = (val) => {
      if (val === null || val === undefined) return "";
      const s = String(val);
      // double quotes escape
      const escaped = s.replace(/"/g, '""');
      return `"${escaped}"`;
    };

    const header = [
      "Date",
      "Rucher",
      "Caisse",
      "Souche",
      "Colonie",
      "Évaluation",
      "Valeur",
      "Info complément",
    ];

    const lines = [];
    lines.push(header.map(escapeCsv).join(";"));

    for (const row of longRows) {
      lines.push(
        [
          row.date ? new Date(row.date).toISOString().split("T")[0] : "",
          row.rucher,
          row.caisse,
          row.souche,
          row.colonie,
          row.evaluation_label_fr,
          row.valeur,
          row.info_complement,
        ]
          .map(escapeCsv)
          .join(";")
      );
    }

    const csv = lines.join("\n");

    const fileName = `bee_evaluations_${new Date()
      .toISOString()
      .slice(0, 10)}.csv`;

    res.setHeader("Content-Type", "text/csv; charset=utf-8");
    res.setHeader(
      "Content-Disposition",
      `attachment; filename="${fileName}"`
    );
    return res.status(200).send(csv);
  } catch (err) {
    console.error("🔴 GET /analytics/evaluations-long/export error:", err);
    return res
      .status(500)
      .json({ error: "Server error while exporting evaluations CSV" });
  }
});


module.exports = router;
