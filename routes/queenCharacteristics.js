// routes/queenCharacteristics.js
const express = require('express');
const router = express.Router();
const { v4: uuidv4 } = require('uuid');
const supabase = require('../utils/supabaseClient');
const authenticateUser = require('../middlewares/authMiddleware');

// ➕ إضافة خاصية لملكة
router.post('/', authenticateUser, async (req, res) => {
  const {
    queen_id,
    characteristic_name,
    value,
    value_type, // مثال: "text"، "number"، "boolean"
    min_value,
    max_value
  } = req.body;

  if (!queen_id || !characteristic_name || !value_type) {
    return res.status(400).json({ error: 'queen_id, characteristic_name, and value_type are required' });
  }

  try {
    const { data, error } = await supabase
      .from('queen_characteristics')
      .insert([{
        id: uuidv4(),
        queen_id,
        characteristic_name,
        value,
        value_type,
        min_value,
        max_value
      }])
      .select();

    if (error) return res.status(400).json({ error: error.message });
    res.status(201).json({ message: '✅ Characteristic added', characteristic: data[0] });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Unexpected server error' });
  }
});

// 📋 عرض خصائص ملكة معينة
router.get('/:queen_id', authenticateUser, async (req, res) => {
  const { queen_id } = req.params;

  try {
    const { data, error } = await supabase
      .from('queen_characteristics')
      .select('*')
      .eq('queen_id', queen_id);

    if (error) return res.status(400).json({ error: error.message });
    res.status(200).json({ characteristics: data });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Unexpected server error' });
  }
});

module.exports = router;
