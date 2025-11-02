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



// /by-hive
router.get("/by-hive", authenticateUser, async (req, res) => {
  const userId = req.user.id;
  const { from, to } = parseRange(req.query);
  try {
    const query = `
      SELECT 
        h.hive_id,
        h.hive_code AS hive_identifier,
        a.apiary_name,
        COALESCE(SUM(har.net_honey_kg),0) AS total_honey,
        COUNT(har.id) AS supers_count,
        MAX(har.harvest_date) AS last_harvest_at
      FROM harvests har
      JOIN supers s ON har.super_id = s.super_id
      JOIN hives  h ON s.hive_id = h.hive_id
      JOIN apiaries a ON h.apiary_id = a.apiary_id
      WHERE a.owner_user_id = $1
        AND ($2::timestamptz IS NULL OR har.harvest_date >= $2)
        AND ($3::timestamptz IS NULL OR har.harvest_date <  $3)
      GROUP BY h.hive_id, h.hive_code, a.apiary_name
      ORDER BY total_honey DESC;
    `;
    const result = await pool.query(query, [userId, from, to]);
    res.json(result.rows);
  } catch (error) {
    console.error("❌ /by-hive", error);
    res.status(500).json({ error: "Server error" });
  }
});

// GET harvest analysis by apiary
// Example in harvestAnalysis.js
// GET harvest analysis by apiary (restricted to authenticated user)
// /by-apiary
router.get("/by-apiary", authenticateUser, async (req, res) => {
  const userId = req.user.id;
  const { from, to } = parseRange(req.query);
  try {
    const query = `
      SELECT 
        a.apiary_id, 
        a.apiary_name, 
        COALESCE(SUM(har.net_honey_kg),0) AS total_honey,
        COALESCE(AVG(har.net_honey_kg) FILTER (WHERE har.net_honey_kg>0),0) AS avg_honey_per_super,
        COUNT(DISTINCT h.hive_id) AS hives_count,
        COUNT(har.id) AS supers_count,
        MAX(har.harvest_date) AS last_harvest_at
      FROM apiaries a
      JOIN hives h  ON a.apiary_id = h.apiary_id
      JOIN supers s ON h.hive_id   = s.hive_id
      JOIN harvests har ON s.super_id = har.super_id
      WHERE a.owner_user_id = $1
        AND ($2::timestamptz IS NULL OR har.harvest_date >= $2)
        AND ($3::timestamptz IS NULL OR har.harvest_date <  $3)
      GROUP BY a.apiary_id, a.apiary_name
      ORDER BY total_honey DESC;
    `;
    const result = await pool.query(query, [userId, from, to]);
    res.json(result.rows);
  } catch (error) {
    console.error("❌ /by-apiary", error);
    res.status(500).json({ error: "Server error" });
  }
});

module.exports = router;
