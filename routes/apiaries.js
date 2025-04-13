const express = require('express');
const router = express.Router();
const pool = require('../db');
const supabase = require('../utils/supabaseClient');
const authenticateUser = require('../middlewares/authMiddleware');

// 🐝 إنشاء منحل جديد
router.post('/', authenticateUser, async (req, res) => {
  const {
    apiary_name,
    location,
    commune,
    department,
    land_owner_name,
    phone,
    company_id
  } = req.body;

  if (!apiary_name || !location) {
    return res.status(400).json({ error: 'apiary_name and location are required.' });
  }

  try {
    const insertData = {
      apiary_name,
      location,
      commune,
      department,
      land_owner_name,
      phone,
      created_at: new Date()
    };

    if (company_id) {
      insertData.company_id = company_id;
    } else {
      insertData.owner_user_id = req.user.id;
    }

    const { data, error } = await supabase
      .from('apiaries')
      .insert([insertData])
      .select();

    if (error) {
      return res.status(400).json({ error: error.message });
    }

    res.status(201).json({ message: '✅ Apiary created successfully', apiary: data[0] });
  } catch (err) {
    res.status(500).json({ error: 'Unexpected server error' });
  }
});

// ✅ عدد الخلايا في منحل معين
router.get('/:id/hives/count', async (req, res) => {
  const { id } = req.params;
  try {
    const result = await pool.query(
      'SELECT COUNT(*) AS count FROM hives WHERE apiary_id = $1',
      [id]
    );
    res.json({ count: parseInt(result.rows[0].count, 10) });
  } catch (error) {
    console.error('Error fetching hive count:', error);
    res.status(500).json({ error: 'Server error while fetching hive count' });
  }
});

// ✅ جميع المناحل
router.get('/', async (req, res) => {
  try {
    const result = await pool.query('SELECT * FROM apiaries ORDER BY apiary_id ASC');
    res.json({ apiaries: result.rows });
  } catch (error) {
    console.error('Error fetching apiaries:', error);
    res.status(500).json({ error: 'Server error while fetching apiaries' });
  }
});

// ✅ خلايا منحل معين
router.get('/:id/hives', async (req, res) => {
  const { id } = req.params;
  try {
    const result = await pool.query(
      'SELECT * FROM hives WHERE apiary_id = $1 ORDER BY hive_id ASC',
      [id]
    );
    res.json(result.rows);
  } catch (error) {
    console.error('Error fetching hives for apiary:', error);
    res.status(500).json({ error: 'Server error while fetching hives for apiary' });
  }
});

// ✅ منحل واحد حسب ID
router.get('/:id', async (req, res) => {
  const { id } = req.params;
  try {
    const result = await pool.query('SELECT * FROM apiaries WHERE apiary_id = $1', [id]);
    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Apiary not found' });
    }
    res.json(result.rows[0]);
  } catch (error) {
    console.error('Error fetching apiary:', error);
    res.status(500).json({ error: 'Server error while fetching apiary' });
  }
});

// ✅ تحديث منحل
router.put('/:id', async (req, res) => {
  const { id } = req.params;
  const { name, city, land_owner, phone, latitude, longitude, altitude } = req.body;
  try {
    const result = await pool.query(
      `UPDATE apiaries 
       SET name = $1, city = $2, land_owner = $3, phone = $4, latitude = $5, longitude = $6, altitude = $7 
       WHERE apiary_id = $8 RETURNING *`,
      [name, city, land_owner, phone, latitude, longitude, altitude, id]
    );
    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Apiary not found' });
    }
    res.json(result.rows[0]);
  } catch (error) {
    console.error('Error updating apiary:', error);
    res.status(500).json({ error: 'Server error while updating apiary' });
  }
});

// ✅ حذف منحل
router.delete('/:id', async (req, res) => {
  const { id } = req.params;
  try {
    const result = await pool.query('DELETE FROM apiaries WHERE apiary_id = $1 RETURNING *', [id]);
    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Apiary not found' });
    }
    res.json({ message: 'Apiary deleted successfully', apiary: result.rows[0] });
  } catch (error) {
    console.error('Error deleting apiary:', error);
    res.status(500).json({ error: 'Server error while deleting apiary' });
  }
});

module.exports = router;
