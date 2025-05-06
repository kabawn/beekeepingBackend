// 📁 routes/notationConfig.js
const express = require('express');
const router = express.Router();
const supabase = require('../utils/supabaseClient');
const authenticateUser = require('../middlewares/authMiddleware');

// ✅ CREATE a new notation type
router.post('/', authenticateUser, async (req, res) => {
  const { label, characteristic, type, min_value, max_value } = req.body;

  if (!label || !characteristic || !type) {
    return res.status(400).json({ error: 'label, characteristic, and type are required' });
  }

  try {
    const { data, error } = await supabase
      .from('notation_config')
      .insert([{ label, characteristic, type, min_value, max_value }])
      .select();

    if (error) return res.status(400).json({ error: error.message });
    res.status(201).json({ message: 'Notation config created', config: data[0] });
  } catch (err) {
    console.error('Error creating notation config:', err);
    res.status(500).json({ error: 'Server error' });
  }
});

// ✅ GET all notation configs
router.get('/', authenticateUser, async (_req, res) => {
  try {
    const { data, error } = await supabase
      .from('notation_config')
      .select('*')
      .order('id');

    if (error) return res.status(400).json({ error: error.message });
    res.status(200).json({ configs: data });
  } catch (err) {
    console.error('Error fetching notation configs:', err);
    res.status(500).json({ error: 'Server error' });
  }
});

// ✅ UPDATE a config by ID
router.put('/:id', authenticateUser, async (req, res) => {
  const { id } = req.params;
  const { label, characteristic, type, min_value, max_value } = req.body;

  try {
    const { data, error } = await supabase
      .from('notation_config')
      .update({ label, characteristic, type, min_value, max_value })
      .eq('id', id)
      .select();

    if (error) return res.status(400).json({ error: error.message });
    res.status(200).json({ message: 'Notation config updated', config: data[0] });
  } catch (err) {
    console.error('Error updating notation config:', err);
    res.status(500).json({ error: 'Server error' });
  }
});

// ✅ DELETE a config by ID
router.delete('/:id', authenticateUser, async (req, res) => {
  const { id } = req.params;

  try {
    const { error } = await supabase
      .from('notation_config')
      .delete()
      .eq('id', id);

    if (error) return res.status(400).json({ error: error.message });
    res.status(200).json({ message: 'Notation config deleted' });
  } catch (err) {
    console.error('Error deleting notation config:', err);
    res.status(500).json({ error: 'Server error' });
  }
});

module.exports = router;
