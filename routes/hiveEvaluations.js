// routes/hiveEvaluations.js
const express = require("express");
const router = express.Router();
const pool = require("../db");
const authenticateUser = require("../middlewares/authMiddleware");
const requirePro = require("../middlewares/requirePro");

// POST /hive-evaluations  → create a new evaluation
router.post("/", authenticateUser, requirePro, async (req, res) => {
   const userId = req.user.id;
   const {
      apiary_id,
      hive_id,
      eval_date,
      season_label,
      eval_type,
      honey_yield_kg,
      brood_frames,
      food_frames,
      population_score,
      temperament_score,
      varroa_level,
      swarming_tendency,
      migration_used,
      feeding_done,
      treatment_type,
      notes,
   } = req.body || {};

   if (!apiary_id || !hive_id) {
      return res.status(400).json({ error: "apiary_id and hive_id are required" });
   }

   try {
      // 1️⃣ Check hive belongs to this apiary AND this user
      const { rows: check } = await pool.query(
         `SELECT h.hive_id
       FROM hives h
       JOIN apiaries a ON a.apiary_id = h.apiary_id
       WHERE h.hive_id = $1
         AND h.apiary_id = $2
         AND a.owner_user_id = $3`,
         [hive_id, apiary_id, userId],
      );

      if (!check.length) {
         return res.status(404).json({ error: "Hive not found for this user/apiary" });
      }

      // 2️⃣ Insert evaluation
      const { rows } = await pool.query(
         `INSERT INTO hive_evaluations (
         owner_user_id, apiary_id, hive_id,
         eval_date, season_label, eval_type,
         honey_yield_kg, brood_frames, food_frames,
         population_score, temperament_score, varroa_level,
         swarming_tendency, migration_used, feeding_done,
         treatment_type, notes
       )
       VALUES (
         $1, $2, $3,
         COALESCE($4::date, CURRENT_DATE), $5, $6,
         $7, $8, $9,
         $10, $11, $12,
         $13, $14, $15,
         $16, $17
       )
       RETURNING *`,
         [
            userId,
            apiary_id,
            hive_id,
            eval_date,
            season_label,
            eval_type,
            honey_yield_kg,
            brood_frames,
            food_frames,
            population_score,
            temperament_score,
            varroa_level,
            swarming_tendency,
            migration_used,
            feeding_done,
            treatment_type,
            notes,
         ],
      );

      return res.status(201).json({ evaluation: rows[0] });
   } catch (err) {
      console.error("🔴 POST /hive-evaluations error:", err);
      return res.status(500).json({ error: "Server error while creating evaluation" });
   }
});

// GET /hive-evaluations/hives/:hiveId  → all evaluations for one hive
router.get("/hives/:hiveId", authenticateUser, requirePro, async (req, res) => {
   const userId = req.user.id;
   const { hiveId } = req.params;

   try {
      const { rows } = await pool.query(
         `SELECT e.*
       FROM hive_evaluations e
       JOIN apiaries a ON a.apiary_id = e.apiary_id
       WHERE e.hive_id = $1
         AND a.owner_user_id = $2
       ORDER BY e.eval_date DESC, e.hive_evaluation_id DESC`,
         [hiveId, userId],
      );

      return res.json({ evaluations: rows });
   } catch (err) {
      console.error("🔴 GET /hive-evaluations/hives/:hiveId error:", err);
      return res.status(500).json({ error: "Server error while fetching evaluations" });
   }
});

// GET /hive-evaluations/apiaries/:apiaryId  → all evaluations for one apiary
router.get("/apiaries/:apiaryId", authenticateUser, requirePro, async (req, res) => {
   const userId = req.user.id;
   const { apiaryId } = req.params;

   try {
      const { rows } = await pool.query(
         `SELECT e.*
       FROM hive_evaluations e
       JOIN apiaries a ON a.apiary_id = e.apiary_id
       WHERE e.apiary_id = $1
         AND a.owner_user_id = $2
       ORDER BY e.eval_date DESC, e.hive_id ASC`,
         [apiaryId, userId],
      );

      return res.json({ evaluations: rows });
   } catch (err) {
      console.error("🔴 GET /hive-evaluations/apiaries/:apiaryId error:", err);
      return res.status(500).json({ error: "Server error while fetching evaluations" });
   }
});

module.exports = router;
