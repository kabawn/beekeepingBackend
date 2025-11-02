// routes/harvestAnalysis.js
const express = require("express");
const router = express.Router();
const pool = require("../db");
const authenticateUser = require("../middlewares/authMiddleware");

// GET harvest analysis by hive
// GET harvest analysis by hive (restricted to authenticated user)
// GET harvest analysis by hive (filtered by apiary owner)
// at top (after imports)
function parseRange(q){
  const from = q.from ? new Date(`${q.from}T00:00:00.000Z`) : null;
  const to   = q.to   ? new Date(`${q.to}T00:00:00.000Z`)   : null; // exclusive
  return { from, to };
}



// GET harvest analysis by hive (owner-scoped) + supers used
router.get("/by-hive", authenticateUser, async (req, res) => {
  const userId = req.user.id;
  const { from, to } = req.query || {};

  try {
    const query = `
      with base as (
        select 
          h.hive_id,
          h.hive_code,
          a.apiary_name,
          s.super_code,
          sum(har.full_weight - s.weight_empty)::float8 as net_kg,
          count(*)::int as harvests
        from harvests har
        join supers s on har.super_id = s.super_id
        join hives h on s.hive_id = h.hive_id
        join apiaries a on h.apiary_id = a.apiary_id
        where a.owner_user_id = $1
          and ($2::timestamptz is null or har.harvest_date >= $2::timestamptz)
          and ($3::timestamptz is null or har.harvest_date <  $3::timestamptz)
        group by h.hive_id, h.hive_code, a.apiary_name, s.super_code
      )
      select
        hive_id,
        hive_code as hive_identifier,
        apiary_name,
        sum(net_kg)::float8 as total_honey,
        array_agg(distinct super_code) as super_codes,
        json_agg(
          json_build_object(
            'super_code', super_code,
            'net_kg', round(net_kg::numeric, 3),
            'harvests', harvests
          )
          order by net_kg desc
        ) as supers_breakdown
      from base
      group by hive_id, hive_code, apiary_name
      order by total_honey desc;
    `;

    const params = [
      userId,
      from ? new Date(from).toISOString() : null,
      to ? new Date(to).toISOString() : null,
    ];

    const result = await pool.query(query, params);
    res.json(result.rows);
  } catch (error) {
    console.error("❌ Error in harvest analysis by hive:", error);
    res.status(500).json({ error: "Server error while fetching harvest analysis by hive" });
  }
});


// GET harvest analysis by apiary
// Example in harvestAnalysis.js
// GET harvest analysis by apiary (restricted to authenticated user)
// /by-apiary
// GET harvest analysis by apiary (owner-scoped) + supers used (across the apiary)
router.get("/by-apiary", authenticateUser, async (req, res) => {
  const userId = req.user.id;
  const { from, to } = req.query || {};

  try {
    const query = `
      with base as (
        select 
          a.apiary_id,
          a.apiary_name,
          h.hive_id,
          s.super_code,
          sum(har.full_weight - s.weight_empty)::float8 as net_kg,
          count(*)::int as harvests
        from harvests har
        join supers s on har.super_id = s.super_id
        join hives h on s.hive_id = h.hive_id
        join apiaries a on h.apiary_id = a.apiary_id
        where a.owner_user_id = $1
          and ($2::timestamptz is null or har.harvest_date >= $2::timestamptz)
          and ($3::timestamptz is null or har.harvest_date <  $3::timestamptz)
        group by a.apiary_id, a.apiary_name, h.hive_id, s.super_code
      ),
      agg as (
        select
          apiary_id,
          apiary_name,
          sum(net_kg)::float8 as total_honey,
          avg(net_kg)::float8 as avg_honey_per_hive_est, -- rough; for exact per-hive avg you can change
          count(distinct hive_id)::int as hives_count,
          count(*)::int as supers_rows, -- number of super_code rows in base
          array_agg(distinct super_code) as super_codes,
          json_agg(
            json_build_object(
              'super_code', super_code,
              'net_kg', round(net_kg::numeric, 3),
              'harvests', harvests
            )
            order by net_kg desc
          ) as supers_breakdown
        from base
        group by apiary_id, apiary_name
      )
      select
        apiary_id,
        apiary_name,
        total_honey,
        avg_honey_per_hive_est as avg_honey_per_hive,
        hives_count,
        supers_rows as supers_count,
        super_codes,
        supers_breakdown
      from agg
      order by total_honey desc;
    `;

    const params = [
      userId,
      from ? new Date(from).toISOString() : null,
      to ? new Date(to).toISOString() : null,
    ];

    const result = await pool.query(query, params);
    res.json(result.rows);
  } catch (error) {
    console.error("❌ Error in harvest analysis by apiary:", error);
    res.status(500).json({ error: "Server error while fetching harvest analysis by apiary" });
  }
});

module.exports = router;
