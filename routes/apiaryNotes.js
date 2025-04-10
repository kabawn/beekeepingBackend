// routes/apiaryNotes.js
const express = require('express');
const router = express.Router();
const supabase = require('../utils/supabaseClient');
const authenticateUser = require('../middlewares/authMiddleware');

// ✍️ إضافة ملاحظة جديدة لمنحل
router.post('/', authenticateUser, async (req, res) => {
  const { apiary_id, note_text, note_date, revisit_needed, revisit_date } = req.body;

  if (!apiary_id || !note_text) {
    return res.status(400).json({ error: 'apiary_id and note_text are required' });
  }

  try {
    const { data, error } = await supabase
      .from('apiary_notes')
      .insert([{
        apiary_id,
        note_text,
        note_date: note_date || new Date().toISOString().split('T')[0],
        revisit_needed,
        revisit_date,
        user_id: req.user.id
      }])
      .select();

    if (error) return res.status(400).json({ error: error.message });

    res.status(201).json({ message: '✅ Note added successfully', note: data[0] });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Unexpected server error' });
  }
});

// 📋 جلب كل الملاحظات لمنحل معين
router.get('/:apiary_id', authenticateUser, async (req, res) => {
  const { apiary_id } = req.params;

  try {
    const { data, error } = await supabase
      .from('apiary_notes')
      .select('*')
      .eq('apiary_id', apiary_id)
      .order('note_date', { ascending: false });

    if (error) return res.status(400).json({ error: error.message });

    res.status(200).json({ notes: data });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Unexpected server error' });
  }
});

// 🔔 تنبيهات زيارات المناحل حسب الفلتر (today, overdue, upcoming, all)
router.get('/alerts/revisits', authenticateUser, async (req, res) => {
  const filter = req.query.filter || 'today';
  const today = new Date().toISOString().split('T')[0];

  try {
    let query = supabase
      .from('apiary_notes')
      .select('note_id, apiary_id, revisit_date, revisit_needed, apiaries(apiary_name, commune, department)')
      .eq('revisit_needed', true);

    if (filter === 'today') {
      query = query.eq('revisit_date', today);
    } else if (filter === 'overdue') {
      query = query.lt('revisit_date', today);
    } else if (filter === 'upcoming') {
      query = query.gt('revisit_date', today);
    }

    query = query.order('revisit_date', { ascending: true });

    const { data, error } = await query;

    if (error) return res.status(400).json({ error: error.message });

    res.status(200).json({ alerts: data });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Unexpected server error' });
  }
});

module.exports = router;
