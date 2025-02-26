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
  } = req.body;

  try {
    const result = await pool.query(
      `INSERT INTO inspections 
        (hive_id, inspector_name, brood_status, queen_status, food_storage, disease_signs, mite_count, notes, revisit_needed, revisit_reason, image_url)
       VALUES 
        ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
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
      ]
    );
    res.status(201).json(result.rows[0]);
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
router.get("/revisit", async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT hives.id AS hive_id, hives.hive_identifier, inspections.inspection_date, inspections.revisit_reason 
       FROM inspections 
       INNER JOIN hives ON hives.id = inspections.hive_id 
       WHERE inspections.revisit_needed = true 
       ORDER BY inspections.inspection_date ASC`
    );
    res.json(result.rows);
  } catch (error) {
    console.error("Error fetching hives needing revisit:", error);
    res.status(500).json({ error: "Server error while fetching revisit hives" });
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
