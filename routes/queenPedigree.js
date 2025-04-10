// routes/queenPedigree.js
const express = require('express');
const router = express.Router();
const { v4: uuidv4 } = require('uuid');
const supabase = require('../utils/supabaseClient');
const authenticateUser = require('../middlewares/authMiddleware');

// ➕ إضافة سجل نسب جديد
router.post('/', authenticateUser, async (req, res) => {
  const {
    queen_id,
    female_parent,
    male_parent,
    birth_date,
    inseminated,
    is_alive
  } = req.body;

  if (!queen_id) return res.status(400).json({ error: 'queen_id is required' });

  try {
    const { data, error } = await supabase
      .from('queen_pedigree')
      .insert([{
        pedigree_id: uuidv4(),
        queen_id,
        female_parent,
        male_parent,
        birth_date,
        inseminated,
        is_alive
      }])
      .select();

    if (error) return res.status(400).json({ error: error.message });

    res.status(201).json({ message: '✅ Pedigree created successfully', pedigree: data[0] });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Unexpected server error' });
  }
});

// 📋 عرض النسب المرتبط بملكة معينة
router.get('/:queen_id', authenticateUser, async (req, res) => {
  const { queen_id } = req.params;

  try {
    const { data, error } = await supabase
      .from('queen_pedigree')
      .select('*')
      .eq('queen_id', queen_id);

    if (error) return res.status(400).json({ error: error.message });
    res.status(200).json({ pedigree: data });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Unexpected server error' });
  }
});

// ✏️ تعديل النسب
router.patch('/:pedigree_id', authenticateUser, async (req, res) => {
  const { pedigree_id } = req.params;
  const updateFields = req.body;

  try {
    const { data, error } = await supabase
      .from('queen_pedigree')
      .update(updateFields)
      .eq('pedigree_id', pedigree_id)
      .select();

    if (error) return res.status(400).json({ error: error.message });
    res.status(200).json({ message: '✅ Pedigree updated successfully', pedigree: data[0] });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Unexpected server error' });
  }
});

module.exports = router;
