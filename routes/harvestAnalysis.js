// routes/harvestAnalysis.js
const express = require("express");
const router = express.Router();
const pool = require("../db");
const authenticateUser = require("../middlewares/authMiddleware");

/**
 * Query params:
 * - from=YYYY-MM-DD (inclusive)
 * - to=YYYY-MM-DD   (exclusive)
 * - q=string        (search)
 * - limit=number
 * - offset=number
 */

function parseRange(q) {
   const from = q.from ? new Date(`${q.from}T00:00:00.000Z`) : null;
   const to = q.to ? new Date(`${q.to}T00:00:00.000Z`) : null; // exclusive
   return { from, to };
}

function parsePaging(q) {
   const limitRaw = parseInt(q.limit, 10);
   const offsetRaw = parseInt(q.offset, 10);

   const limit = Number.isFinite(limitRaw) ? Math.min(Math.max(limitRaw, 10), 200) : 80;
   const offset = Number.isFinite(offsetRaw) ? Math.max(offsetRaw, 0) : 0;

   return { limit, offset };
}

function parseSearch(q) {
   const s = (q.q || "").toString().trim();
   return s ? s : null;
}

// ----------------------------------------------------
// /by-hive
// ----------------------------------------------------
router.get("/by-hive", authenticateUser, async (req, res) => {
   const userId = req.user.id;
   const { from, to } = parseRange(req.query || {});
   const { limit, offset } = parsePaging(req.query || {});
   const q = parseSearch(req.query || {});

   try {
      const sql = `
      WITH fh AS (
        SELECT hive_id, apiary_id, super_id, net_honey_kg, harvest_date
        FROM harvests
        WHERE user_id = $1
          AND ($2::timestamptz IS NULL OR harvest_date >= $2::timestamptz)
          AND ($3::timestamptz IS NULL OR harvest_date <  $3::timestamptz)
      ),
      joined AS (
        SELECT
          fh.hive_id,
          h.hive_code,
          fh.apiary_id,
          a.apiary_name,
          fh.super_id,
          s.super_code,
          fh.net_honey_kg,
          fh.harvest_date
        FROM fh
        LEFT JOIN hives    h ON fh.hive_id   = h.hive_id
        LEFT JOIN apiaries a ON fh.apiary_id = a.apiary_id
        LEFT JOIN supers   s ON fh.super_id  = s.super_id
        WHERE ($4::text IS NULL
          OR (h.hive_code ILIKE ('%'||$4||'%')
              OR a.apiary_name ILIKE ('%'||$4||'%'))
        )
      ),
      base AS (
        SELECT
          hive_id,
          hive_code,
          apiary_name,
          super_code,
          SUM(net_honey_kg)::float8 AS net_kg,
          COUNT(*)::int AS harvests,
          MAX(harvest_date) AS last_harvest_at
        FROM joined
        GROUP BY hive_id, hive_code, apiary_name, super_code
      ),
      agg AS (
        SELECT
          hive_id,
          hive_code AS hive_identifier,
          apiary_name,
          SUM(net_kg)::float8 AS total_honey,
          MAX(last_harvest_at) AS last_harvest_at,
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
      )
      SELECT *
      FROM agg
      ORDER BY last_harvest_at DESC NULLS LAST
      LIMIT $5 OFFSET $6;
    `;

      const params = [
         userId,
         from ? from.toISOString() : null,
         to ? to.toISOString() : null,
         q,
         limit,
         offset,
      ];

      const result = await pool.query(sql, params);
      res.json(result.rows);
   } catch (error) {
      console.error("❌ Error in harvest analysis by hive:", error);
      res.status(500).json({ error: "Server error while fetching harvest analysis by hive" });
   }
});

// ----------------------------------------------------
// /by-apiary
// ----------------------------------------------------
router.get("/by-apiary", authenticateUser, async (req, res) => {
   const userId = req.user.id;
   const { from, to } = parseRange(req.query || {});
   const { limit, offset } = parsePaging(req.query || {});
   const q = parseSearch(req.query || {});

   try {
      const sql = `
      WITH fh AS (
        SELECT hive_id, apiary_id, super_id, net_honey_kg, harvest_date
        FROM harvests
        WHERE user_id = $1
          AND ($2::timestamptz IS NULL OR harvest_date >= $2::timestamptz)
          AND ($3::timestamptz IS NULL OR harvest_date <  $3::timestamptz)
      ),
      joined AS (
        SELECT
          fh.apiary_id,
          a.apiary_name,
          fh.hive_id,
          s.super_code,
          fh.net_honey_kg,
          fh.harvest_date
        FROM fh
        LEFT JOIN apiaries a ON fh.apiary_id = a.apiary_id
        LEFT JOIN supers   s ON fh.super_id  = s.super_id
        WHERE ($4::text IS NULL OR a.apiary_name ILIKE ('%'||$4||'%'))
      ),
      base AS (
        SELECT
          apiary_id,
          apiary_name,
          hive_id,
          super_code,
          SUM(net_honey_kg)::float8 AS net_kg,
          COUNT(*)::int AS harvests,
          MAX(harvest_date) AS last_harvest_at
        FROM joined
        GROUP BY apiary_id, apiary_name, hive_id, super_code
      ),
      agg AS (
        SELECT
          apiary_id,
          apiary_name,
          SUM(net_kg)::float8 AS total_honey,
          COUNT(DISTINCT hive_id)::int AS hives_count,
          COUNT(*)::int AS supers_rows,
          MAX(last_harvest_at) AS last_harvest_at,
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
        (CASE WHEN hives_count > 0 THEN (total_honey / hives_count) ELSE 0 END)::float8 AS avg_honey_per_hive,
        hives_count,
        supers_rows AS supers_count,
        last_harvest_at,
        supers_breakdown
      FROM agg
      ORDER BY last_harvest_at DESC NULLS LAST
      LIMIT $5 OFFSET $6;
    `;

      const params = [
         userId,
         from ? from.toISOString() : null,
         to ? to.toISOString() : null,
         q,
         limit,
         offset,
      ];

      const result = await pool.query(sql, params);
      res.json(result.rows);
   } catch (error) {
      console.error("❌ Error in harvest analysis by apiary:", error);
      res.status(500).json({ error: "Server error while fetching harvest analysis by apiary" });
   }
});

module.exports = router;
