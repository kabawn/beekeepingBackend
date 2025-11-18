// routes/harvestAnalysis.js
const express = require("express");
const router = express.Router();
const pool = require("../db");
const authenticateUser = require("../middlewares/authMiddleware");

function parseRange(q) {
  const from = q.from ? new Date(`${q.from}T00:00:00.000Z`) : null;
  const to   = q.to   ? new Date(`${q.to}T00:00:00.000Z`)   : null; // exclusive
  return { from, to };
}

/**
 * GET /api/harvest-analysis/by-hive?from=YYYY-MM-DD&to=YYYY-MM-DD
 * Analyse par ruche (owner-scoped) + détail des hausses utilisées.
 * Utilise maintenant hive_id/apiary_id/net_honey_kg enregistrés dans harvests.
 */
router.get("/by-hive", authenticateUser, async (req, res) => {
  const userId = req.user.id;
  const { from, to } = parseRange(req.query || {});

  try {
    const query = `
      WITH base AS (
        SELECT
          h.hive_id,
          h.hive_code,
          a.apiary_name,
          s.super_code,
          SUM(har.net_honey_kg)::float8 AS net_kg,
          COUNT(*)::int                  AS harvests
        FROM harvests har
        LEFT JOIN hives    h ON har.hive_id   = h.hive_id
        LEFT JOIN apiaries a ON har.apiary_id = a.apiary_id
        LEFT JOIN supers   s ON har.super_id  = s.super_id
        WHERE har.user_id = $1
          AND ($2::timestamptz IS NULL OR har.harvest_date >= $2::timestamptz)
          AND ($3::timestamptz IS NULL OR har.harvest_date <  $3::timestamptz)
        GROUP BY h.hive_id, h.hive_code, a.apiary_name, s.super_code
      )
      SELECT
        hive_id,
        hive_code AS hive_identifier,
        apiary_name,
        SUM(net_kg)::float8 AS total_honey,
        ARRAY_AGG(DISTINCT super_code) AS super_codes,
        JSON_AGG(
          JSON_BUILD_OBJECT(
            'super_code', super_code,
            'net_kg',     ROUND(net_kg::numeric, 3),
            'harvests',   harvests
          )
          ORDER BY net_kg DESC
        ) AS supers_breakdown
      FROM base
      GROUP BY hive_id, hive_code, apiary_name
      ORDER BY total_honey DESC;
    `;

    const params = [
      userId,
      from ? from.toISOString() : null,
      to   ? to.toISOString()   : null,
    ];

    const result = await pool.query(query, params);
    res.json(result.rows);
  } catch (error) {
    console.error("❌ Error in harvest analysis by hive:", error);
    res.status(500).json({ error: "Server error while fetching harvest analysis by hive" });
  }
});

/**
 * GET /api/harvest-analysis/by-apiary?from=YYYY-MM-DD&to=YYYY-MM-DD
 * Analyse par rucher (owner-scoped) + hausses utilisées.
 */
router.get("/by-apiary", authenticateUser, async (req, res) => {
  const userId = req.user.id;
  const { from, to } = parseRange(req.query || {});

  try {
    const query = `
      WITH base AS (
        SELECT
          a.apiary_id,
          a.apiary_name,
          h.hive_id,
          s.super_code,
          SUM(har.net_honey_kg)::float8 AS net_kg,
          COUNT(*)::int                  AS harvests
        FROM harvests har
        LEFT JOIN apiaries a ON har.apiary_id = a.apiary_id
        LEFT JOIN hives    h ON har.hive_id   = h.hive_id
        LEFT JOIN supers   s ON har.super_id  = s.super_id
        WHERE har.user_id = $1
          AND ($2::timestamptz IS NULL OR har.harvest_date >= $2::timestamptz)
          AND ($3::timestamptz IS NULL OR har.harvest_date <  $3::timestamptz)
        GROUP BY a.apiary_id, a.apiary_name, h.hive_id, s.super_code
      ),
      agg AS (
        SELECT
          apiary_id,
          apiary_name,
          SUM(net_kg)::float8 AS total_honey,
          AVG(net_kg)::float8 AS avg_honey_per_hive_est,
          COUNT(DISTINCT hive_id)::int AS hives_count,
          COUNT(*)::int                AS supers_rows,
          ARRAY_AGG(DISTINCT super_code) AS super_codes,
          JSON_AGG(
            JSON_BUILD_OBJECT(
              'super_code', super_code,
              'net_kg',     ROUND(net_kg::numeric, 3),
              'harvests',   harvests
            )
            ORDER BY net_kg DESC
          ) AS supers_breakdown
        FROM base
        GROUP BY apiary_id, apiary_name
      )
      SELECT
        apiary_id,
        apiary_name,
        total_honey,
        avg_honey_per_hive_est AS avg_honey_per_hive,
        hives_count,
        supers_rows   AS supers_count,
        super_codes,
        supers_breakdown
      FROM agg
      ORDER BY total_honey DESC;
    `;

    const params = [
      userId,
      from ? from.toISOString() : null,
      to   ? to.toISOString()   : null,
    ];

    const result = await pool.query(query, params);
    res.json(result.rows);
  } catch (error) {
    console.error("❌ Error in harvest analysis by apiary:", error);
    res.status(500).json({ error: "Server error while fetching harvest analysis by apiary" });
  }
});

module.exports = router;
