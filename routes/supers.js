// routes/supers.js
const express = require('express');
const router = express.Router();
const pool = require('../db'); // Make sure db.js exports your PostgreSQL connection pool

/**
 /**
 * Create a new super.
 * Expects a JSON body with:
 * - super_code (string) - unique identifier for the super (e.g., from a QR code)
 * - type (string)
 * - status (string) – this field will be set automatically (overridden) based on hive linkage.
 * - weight_empty (number, optional; default will be used if not provided)
 * - hive_id (number, optional)
 */
 router.post('/', async (req, res) => {
  const { super_code, type, weight_empty, hive_id } = req.body;
  try {
    // Automatically determine status:
    // If hive_id is provided, set status to "in use", otherwise "available".
    const status = hive_id ? "in use" : "available";
    const result = await pool.query(
      `INSERT INTO supers (super_code, type, status, weight_empty, hive_id)
       VALUES ($1, $2, $3, COALESCE($4::DOUBLE PRECISION, 0), $5)
       RETURNING *`,
      [super_code, type, status, weight_empty, hive_id]
    );
    res.status(201).json(result.rows[0]);
  } catch (error) {
    console.error('Error creating super:', error);
    res.status(500).json({ error: 'Server error while creating super' });
  }
});
  

/**
 * Retrieve all supers.
 */
router.get('/', async (req, res) => {
  try {
    const result = await pool.query('SELECT * FROM supers ORDER BY id ASC');
    res.json(result.rows);
  } catch (error) {
    console.error('Error fetching supers:', error);
    res.status(500).json({ error: 'Server error while fetching supers' });
  }
});

/**
 * Retrieve a single super by ID.
 */
router.get('/:id', async (req, res) => {
  const { id } = req.params;
  try {
    const result = await pool.query('SELECT * FROM supers WHERE id = $1', [id]);
    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Super not found' });
    }
    res.json(result.rows[0]);
  } catch (error) {
    console.error('Error fetching super:', error);
    res.status(500).json({ error: 'Server error while fetching super' });
  }
});

/**
 * Update an existing super.
 * Expects a JSON body with:
 * - type (string)
 * - status (string)
 * - weight_empty (number, optional)
 * - hive_id (number, optional)
 */
router.put('/:id', async (req, res) => {
  const { id } = req.params;
  const { type, status, super_code, weight_empty, hive_id } = req.body;
  try {
    const result = await pool.query(
      `UPDATE supers 
       SET type = $1, 
           status = $2, 
           super_code = $3, 
           weight_empty = COALESCE($4::DOUBLE PRECISION, 0), 
           hive_id = $5
       WHERE id = $6 RETURNING *`,
      [type, status, super_code, weight_empty, hive_id, id]
    );
    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Super not found' });
    }
    res.json(result.rows[0]);
  } catch (error) {
    console.error('Error updating super:', error);
    res.status(500).json({ error: 'Server error while updating super' });
  }
});


/**
 * Delete a super by ID.
 */
router.delete('/:id', async (req, res) => {
  const { id } = req.params;
  try {
    const result = await pool.query('DELETE FROM supers WHERE id = $1 RETURNING *', [id]);
    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Super not found' });
    }
    res.json({ message: 'Super deleted successfully', super: result.rows[0] });
  } catch (error) {
    console.error('Error deleting super:', error);
    res.status(500).json({ error: 'Server error while deleting super' });
  }
});

// Get supers linked to a specific hive.
router.get('/byhive/:hiveId', async (req, res) => {
  const { hiveId } = req.params;
  try {
    const result = await pool.query('SELECT * FROM supers WHERE hive_id = $1 ORDER BY id ASC', [hiveId]);
    res.json(result.rows);
  } catch (error) {
    console.error('Error fetching supers for hive:', error);
    res.status(500).json({ error: 'Server error while fetching supers for hive' });
  }
});

// Add this code in routes/supers.js
router.get('/identifier/:super_code', async (req, res) => {
  const { super_code } = req.params;
  try {
    const result = await pool.query('SELECT * FROM supers WHERE super_code = $1', [super_code]);
    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Super not found' });
    }
    res.json(result.rows[0]);
  } catch (error) {
    console.error('Error fetching super by identifier:', error);
    res.status(500).json({ error: 'Server error while fetching super' });
  }
});

module.exports = router;


module.exports = router;
