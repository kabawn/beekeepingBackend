const express = require("express");
const router = express.Router();
const pool = require("../db");
const authenticateUser = require("../middlewares/authMiddleware");

// POST /hive-descriptors  → create or update descriptor for a hive/year
router.post("/", authenticateUser, async (req, res) => {
  const userId = req.user.id;
  const {
    apiary_id,
    hive_id,
    year,
    season_label,
    queen_origin,
    queen_year,
    queen_line,
    reproduction_method,
    overwintering_result,
    treatment_strategy,
    hive_purpose_snapshot,
    notes,
  } = req.body || {};

  if (!apiary_id || !hive_id || !year) {
    return res.status(400).json({ error: "apiary_id, hive_id and year are required" });
  }

  try {
    // 1️⃣ Check hive belongs to apiary + user
    const { rows: check } = await pool.query(
      `SELECT h.hive_id
       FROM hives h
       JOIN apiaries a ON a.apiary_id = h.apiary_id
       WHERE h.hive_id = $1
         AND h.apiary_id = $2
         AND a.owner_user_id = $3`,
      [hive_id, apiary_id, userId]
    );

    if (!check.length) {
      return res.status(404).json({ error: "Hive not found for this user/apiary" });
    }

    // 2️⃣ Upsert descriptor (one per hive/year)
    const { rows } = await pool.query(
      `INSERT INTO hive_descriptors (
         owner_user_id, apiary_id, hive_id, year,
         season_label,
         queen_origin, queen_year, queen_line, reproduction_method,
         overwintering_result, treatment_strategy, hive_purpose_snapshot,
         notes
       )
       VALUES (
         $1, $2, $3, $4,
         $5,
         $6, $7, $8, $9,
         $10, $11, $12,
         $13
       )
       ON CONFLICT (hive_id, year)
       DO UPDATE SET
         season_label = EXCLUDED.season_label,
         queen_origin = EXCLUDED.queen_origin,
         queen_year = EXCLUDED.queen_year,
         queen_line = EXCLUDED.queen_line,
         reproduction_method = EXCLUDED.reproduction_method,
         overwintering_result = EXCLUDED.overwintering_result,
         treatment_strategy = EXCLUDED.treatment_strategy,
         hive_purpose_snapshot = EXCLUDED.hive_purpose_snapshot,
         notes = EXCLUDED.notes,
         updated_at = now()
       RETURNING *`,
      [
        userId,
        apiary_id,
        hive_id,
        year,
        season_label,
        queen_origin,
        queen_year,
        queen_line,
        reproduction_method,
        overwintering_result,
        treatment_strategy,
        hive_purpose_snapshot,
        notes,
      ]
    );

    return res.status(201).json({ descriptor: rows[0] });
  } catch (err) {
    console.error("🔴 POST /hive-descriptors error:", err);
    return res.status(500).json({ error: "Server error while saving descriptor" });
  }
});

// GET /hive-descriptors/hives/:hiveId  → descriptors for one hive
router.get("/hives/:hiveId", authenticateUser, async (req, res) => {
  const userId = req.user.id;
  const { hiveId } = req.params;

  try {
    const { rows } = await pool.query(
      `SELECT d.*
       FROM hive_descriptors d
       JOIN apiaries a ON a.apiary_id = d.apiary_id
       WHERE d.hive_id = $1
         AND a.owner_user_id = $2
       ORDER BY d.year DESC, d.hive_descriptor_id DESC`,
      [hiveId, userId]
    );

    return res.json({ descriptors: rows });
  } catch (err) {
    console.error("🔴 GET /hive-descriptors/hives/:hiveId error:", err);
    return res.status(500).json({ error: "Server error while fetching descriptors" });
  }
});

// GET /hive-descriptors/apiaries/:apiaryId  → descriptors for one apiary
router.get("/apiaries/:apiaryId", authenticateUser, async (req, res) => {
  const userId = req.user.id;
  const { apiaryId } = req.params;

  try {
    const { rows } = await pool.query(
      `SELECT d.*
       FROM hive_descriptors d
       JOIN apiaries a ON a.apiary_id = d.apiary_id
       WHERE d.apiary_id = $1
         AND a.owner_user_id = $2
       ORDER BY d.year DESC, d.hive_id ASC`,
      [apiaryId, userId]
    );

    return res.json({ descriptors: rows });
  } catch (err) {
    console.error("🔴 GET /hive-descriptors/apiaries/:apiaryId error:", err);
    return res.status(500).json({ error: "Server error while fetching descriptors" });
  }
});

module.exports = router;
