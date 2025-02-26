// routes/hives.js
const express = require('express');
const router = express.Router();
const pool = require('../db'); // Ensure you have a db.js file that exports your PostgreSQL connection pool

/**
 * Create a new hive.
 * Expects a JSON body with:
 * - apiary_id (number)
 * - hive_identifier (string)
 * - hive_type_id (number)
 * - current_queen_id (number, optional)
 */
router.post('/', async (req, res) => {
  const { apiary_id, hive_identifier, hive_type_id, current_queen_id } = req.body;
  try {
    const result = await pool.query(
      `INSERT INTO hives (apiary_id, hive_identifier, hive_type_id, current_queen_id)
       VALUES ($1, $2, $3, $4)
       RETURNING *`,
      [apiary_id, hive_identifier, hive_type_id, current_queen_id]
    );
    res.status(201).json(result.rows[0]);
  } catch (error) {
    console.error('Error creating hive:', error);
    res.status(500).json({ error: 'Server error while creating hive' });
  }
});

/**
 * Retrieve all hives.
 */
router.get('/', async (req, res) => {
  try {
    const result = await pool.query('SELECT * FROM hives ORDER BY id ASC');
    res.json(result.rows);
  } catch (error) {
    console.error('Error fetching hives:', error);
    res.status(500).json({ error: 'Server error while fetching hives' });
  }
});

/**
 * Retrieve a single hive by ID.
 */
router.get('/:id', async (req, res) => {
  const { id } = req.params;
  try {
    const result = await pool.query('SELECT * FROM hives WHERE id = $1', [id]);
    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Hive not found' });
    }
    res.json(result.rows[0]);
  } catch (error) {
    console.error('Error fetching hive:', error);
    res.status(500).json({ error: 'Server error while fetching hive' });
  }
});

/**
 * Retrieve a single hive by hive_identifier.
 */
router.get('/identifier/:hive_identifier', async (req, res) => {
    const { hive_identifier } = req.params;
    try {
      const result = await pool.query('SELECT * FROM hives WHERE hive_identifier = $1', [hive_identifier]);
      if (result.rows.length === 0) {
        return res.status(404).json({ error: 'Hive not found' });
      }
      res.json(result.rows[0]);
    } catch (error) {
      console.error('Error fetching hive by identifier:', error);
      res.status(500).json({ error: 'Server error while fetching hive' });
    }
  });
  

/**
 * Update an existing hive.
 * Expects a JSON body with:
 * - apiary_id (number)
 * - hive_identifier (string)
 * - hive_type_id (number)
 * - current_queen_id (number, optional)
 */
router.put('/:id', async (req, res) => {
  const { id } = req.params;
  const { apiary_id, hive_identifier, hive_type_id, current_queen_id } = req.body;
  try {
    const result = await pool.query(
      `UPDATE hives 
       SET apiary_id = $1, hive_identifier = $2, hive_type_id = $3, current_queen_id = $4 
       WHERE id = $5 RETURNING *`,
      [apiary_id, hive_identifier, hive_type_id, current_queen_id, id]
    );
    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Hive not found' });
    }
    res.json(result.rows[0]);
  } catch (error) {
    console.error('Error updating hive:', error);
    res.status(500).json({ error: 'Server error while updating hive' });
  }
});

/**
 * Delete a hive by ID.
 */
router.delete('/:id', async (req, res) => {
  const { id } = req.params;
  try {
    const result = await pool.query('DELETE FROM hives WHERE id = $1 RETURNING *', [id]);
    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Hive not found' });
    }
    res.json({ message: 'Hive deleted successfully', hive: result.rows[0] });
  } catch (error) {
    console.error('Error deleting hive:', error);
    res.status(500).json({ error: 'Server error while deleting hive' });
  }
});

module.exports = router;
