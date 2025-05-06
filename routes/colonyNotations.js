// 📁 routes/colonyNotations.js
const express = require('express');
const router = express.Router();
const supabase = require('../utils/supabaseClient');
const authenticateUser = require('../middlewares/authMiddleware');

// ✅ CREATE a new colony notation
router.post('/', authenticateUser, async (req, res) => {
  const { hive_id, queen_id, notation_id, value, location, date_recorded } = req.body;

  if (!hive_id || !notation_id || value === undefined) {
    return res.status(400).json({ error: 'hive_id, notation_id and value are required' });
  }

  try {
    const { data, error } = await supabase
      .from('colony_notations')
      .insert([{ hive_id, queen_id, notation_id, value, location, date_recorded, user_id: req.user.id }])
      .select();

    if (error) return res.status(400).json({ error: error.message });
    res.status(201).json({ message: 'Notation recorded', record: data[0] });
  } catch (err) {
    console.error('Error adding notation:', err);
    res.status(500).json({ error: 'Server error' });
  }
});

// ✅ GET all notations for a hive
router.get('/hive/:hive_id', authenticateUser, async (req, res) => {
  const { hive_id } = req.params;

  try {
    const { data, error } = await supabase
      .from('colony_notations')
      .select('*, notation_config(label, characteristic, type)')
      .eq('hive_id', hive_id)
      .order('date_recorded', { ascending: false });

    if (error) return res.status(400).json({ error: error.message });
    res.status(200).json({ records: data });
  } catch (err) {
    console.error('Error fetching notations:', err);
    res.status(500).json({ error: 'Server error' });
  }
});

// ✅ UPDATE a notation
router.put('/:id', authenticateUser, async (req, res) => {
  const { id } = req.params;
  const { value, location, date_recorded } = req.body;

  try {
    const { data, error } = await supabase
      .from('colony_notations')
      .update({ value, location, date_recorded })
      .eq('id', id)
      .select();

    if (error) return res.status(400).json({ error: error.message });
    res.status(200).json({ message: 'Notation updated', record: data[0] });
  } catch (err) {
    console.error('Error updating notation:', err);
    res.status(500).json({ error: 'Server error' });
  }
});

// ✅ DELETE a notation
router.delete('/:id', authenticateUser, async (req, res) => {
  const { id } = req.params;

  try {
    const { error } = await supabase
      .from('colony_notations')
      .delete()
      .eq('id', id);

    if (error) return res.status(400).json({ error: error.message });
    res.status(200).json({ message: 'Notation deleted' });
  } catch (err) {
    console.error('Error deleting notation:', err);
    res.status(500).json({ error: 'Server error' });
  }
});

module.exports = router;