// routes/harvests.js
const express = require('express');
const router = express.Router();
const pool = require('../db'); // Your PostgreSQL pool

// Create a new harvest record.
router.post('/', async (req, res) => {
  const { super_id, full_weight, location } = req.body;
  try {
    const result = await pool.query(
      `INSERT INTO harvests (super_id, full_weight, location)
       VALUES ($1, $2, $3)
       RETURNING *`,
      [super_id, full_weight, location]
    );
    res.status(201).json(result.rows[0]);
  } catch (error) {
    console.error("Error creating harvest:", error);
    res.status(500).json({ error: "Server error while creating harvest" });
  }
});

// Get all harvest records (optional – you may extend with filtering by hive or apiary).
router.get('/', async (req, res) => {
  try {
    const result = await pool.query('SELECT * FROM harvests ORDER BY harvest_date DESC');
    res.json(result.rows);
  } catch (error) {
    console.error("Error fetching harvests:", error);
    res.status(500).json({ error: "Server error while fetching harvests" });
  }
});


// Get super details by public_key (used after scanning QR)
router.get('/super-by-key/:public_key', async (req, res) => {
  const { public_key } = req.params;

  try {
    const result = await pool.query(
      `SELECT super_id AS id, super_code, public_key FROM supers WHERE public_key = $1`,
      [public_key.trim()]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Super not found' });
    }

    res.json(result.rows[0]);
  } catch (error) {
    console.error("Error fetching super by key:", error);
    res.status(500).json({ error: "Server error while fetching super by key" });
  }
});


module.exports = router;
