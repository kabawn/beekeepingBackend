// routes/queens.js
const express = require("express");
const router = express.Router();
const pool = require("../db"); // Ensure your db.js exports the PostgreSQL connection pool

/**
 * Create a new queen.
 * Expects a JSON body with:
 * - queen_code (string) - the special code for the queen
 * - mothers_code (string)
 * - father_code (string)
 * - grafting_date (string, in YYYY-MM-DD format)
 * - introduction_date (string, in YYYY-MM-DD format)
 * - hive_id (number, optional)
 */
router.post("/", async (req, res) => {
   const { queen_code, mothers_code, father_code, grafting_date, introduction_date, hive_id } =
      req.body;
   try {
      const result = await pool.query(
         `INSERT INTO queens (queen_code, mothers_code, father_code, grafting_date, introduction_date, hive_id)
       VALUES ($1, $2, $3, $4, $5, $6)
       RETURNING *`,
         [queen_code, mothers_code, father_code, grafting_date, introduction_date, hive_id]
      );
      res.status(201).json(result.rows[0]);
   } catch (error) {
      console.error("Full error object:", error);
      if (error.code === "23503") {
         // Return a client error status (400) instead of 500
         res.status(400).json({
            error: "Invalid hive_id. The Hive ID you entered does not exist.",
         });
      } else {
         res.status(500).json({ error: "Server error while creating queen" });
      }
   }
});

/**
 * Retrieve all queens.
 */
router.get("/", async (req, res) => {
   try {
      const result = await pool.query("SELECT * FROM queens ORDER BY id ASC");
      res.json(result.rows);
   } catch (error) {
      console.error("Error fetching queens:", error);
      res.status(500).json({ error: "Server error while fetching queens" });
   }
});

/**
 * Retrieve a single queen by ID.
 */
router.get("/:id", async (req, res) => {
   const { id } = req.params;
   try {
      const result = await pool.query("SELECT * FROM queens WHERE id = $1", [id]);
      if (result.rows.length === 0) {
         return res.status(404).json({ error: "Queen not found" });
      }
      res.json(result.rows[0]);
   } catch (error) {
      console.error("Error fetching queen:", error);
      res.status(500).json({ error: "Server error while fetching queen" });
   }
});

/**
 * Update an existing queen.
 * Expects a JSON body with the fields to update.
 */
router.put("/:id", async (req, res) => {
   const { id } = req.params;
   const { queen_code, mothers_code, father_code, grafting_date, introduction_date, hive_id } =
      req.body;
   try {
      const result = await pool.query(
         `UPDATE queens 
       SET queen_code = $1, mothers_code = $2, father_code = $3, grafting_date = $4, introduction_date = $5, hive_id = $6 
       WHERE id = $7 RETURNING *`,
         [queen_code, mothers_code, father_code, grafting_date, introduction_date, hive_id, id]
      );
      if (result.rows.length === 0) {
         return res.status(404).json({ error: "Queen not found" });
      }
      res.json(result.rows[0]);
   } catch (error) {
      console.error("Error updating queen:", error);
      res.status(500).json({ error: "Server error while updating queen" });
   }
});


// Retrieve a single queen by queen_code (i.e. the queen identifier)
router.get('/identifier/:queen_identifier', async (req, res) => {
  const { queen_identifier } = req.params;
  try {
    const result = await pool.query('SELECT * FROM queens WHERE queen_code = $1', [queen_identifier]);
    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Queen not found' });
    }
    res.json(result.rows[0]);
  } catch (error) {
    console.error('Error fetching queen by identifier:', error);
    res.status(500).json({ error: 'Server error while fetching queen' });
  }
});

/**
 * Delete a queen by ID.
 */
router.delete("/:id", async (req, res) => {
   const { id } = req.params;
   try {
      const result = await pool.query("DELETE FROM queens WHERE id = $1 RETURNING *", [id]);
      if (result.rows.length === 0) {
         return res.status(404).json({ error: "Queen not found" });
      }
      res.json({ message: "Queen deleted successfully", queen: result.rows[0] });
   } catch (error) {
      console.error("Error deleting queen:", error);
      res.status(500).json({ error: "Server error while deleting queen" });
   }
});

module.exports = router;
