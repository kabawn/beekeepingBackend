const express = require("express");
const router = express.Router();
const pool = require("../db"); // PostgreSQL connection pool

/**
 * Add a new inspection record for a hive
 * Expects a JSON body with:
 * - hive_id (number)
 * - inspector_name (string)
 * - brood_status (string)
 * - queen_status (string)
 * - food_storage (string)
 * - disease_signs (string)
 * - mite_count (number, optional)
 * - notes (string)
 * - revisit_needed (boolean)
 * - revisit_reason (string, optional)
 * - image_url (string, optional)
 */
router.post("/", async (req, res) => {
  const {
    hive_id,
    inspector_name,
    brood_status,
    queen_status,
    food_storage,
    disease_signs,
    mite_count,
    notes,
    revisit_needed,
    revisit_reason,
    image_url,
    current_frames, // 🟢 New field to store the current number of frames
  } = req.body;

  try {
    // ✅ Get total frames from the hives table
    const hiveResult = await pool.query(
      "SELECT total_frames FROM hives WHERE id = $1",
      [hive_id]
    );

    if (hiveResult.rows.length === 0) {
      return res.status(404).json({ error: "Hive not found" });
    }

    const total_frames = hiveResult.rows[0].total_frames;
    const missing_frames = total_frames - current_frames; // 🔥 Calculate missing frames

    // ✅ Insert inspection record with current and missing frames
    const result = await pool.query(
      `INSERT INTO inspections 
        (hive_id, inspector_name, brood_status, queen_status, food_storage, disease_signs, mite_count, notes, revisit_needed, revisit_reason, image_url, current_frames)
       VALUES 
        ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)
       RETURNING *`,
      [
        hive_id,
        inspector_name,
        brood_status,
        queen_status,
        food_storage,
        disease_signs,
        mite_count || null,
        notes,
        revisit_needed,
        revisit_reason || null,
        image_url || null,
        current_frames,
      ]
    );

    // ✅ Send response with missing frames
    res.status(201).json({ 
      ...result.rows[0], 
      total_frames, 
      missing_frames 
    });

  } catch (error) {
    console.error("Error creating inspection:", error);
    res.status(500).json({ error: "Server error while creating inspection" });
  }
});


/**
 * Retrieve all inspections for a specific hive.
 */
router.get("/", async (req, res) => {
  const { hive_id } = req.query;

  if (!hive_id) {
    return res.status(400).json({ error: "Missing hive_id parameter" });
  }

  try {
    const result = await pool.query(
      "SELECT * FROM inspections WHERE hive_id = $1 ORDER BY inspection_date DESC",
      [hive_id]
    );
    res.json(result.rows);
  } catch (error) {
    console.error("Error fetching inspections:", error);
    res.status(500).json({ error: "Server error while fetching inspections" });
  }
});

/**
 * Retrieve hives that require a revisit.
 */
router.get("/", async (req, res) => {
  const { hive_id } = req.query;

  if (!hive_id) {
    return res.status(400).json({ error: "Missing hive_id parameter" });
  }

  try {
    // ✅ Get total frames from the hives table
    const hiveResult = await pool.query(
      "SELECT total_frames FROM hives WHERE id = $1",
      [hive_id]
    );

    if (hiveResult.rows.length === 0) {
      return res.status(404).json({ error: "Hive not found" });
    }

    const total_frames = hiveResult.rows[0].total_frames;

    // ✅ Get inspections and calculate missing frames dynamically
    const result = await pool.query(
      `SELECT *, $1 - current_frames AS missing_frames
       FROM inspections
       WHERE hive_id = $2
       ORDER BY inspection_date DESC`,
      [total_frames, hive_id]
    );

    res.json(result.rows);
  } catch (error) {
    console.error("Error fetching inspections:", error);
    res.status(500).json({ error: "Server error while fetching inspections" });
  }
});


/**
 * Delete an inspection record.
 */
router.delete("/:id", async (req, res) => {
  const { id } = req.params;

  try {
    const result = await pool.query("DELETE FROM inspections WHERE id = $1 RETURNING *", [id]);
    if (result.rows.length === 0) {
      return res.status(404).json({ error: "Inspection not found" });
    }
    res.json({ message: "Inspection deleted successfully", inspection: result.rows[0] });
  } catch (error) {
    console.error("Error deleting inspection:", error);
    res.status(500).json({ error: "Server error while deleting inspection" });
  }
});

module.exports = router;
