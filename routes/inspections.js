// routes/inspections.js
const express = require('express');
const router = express.Router();
const supabase = require('../utils/supabaseClient');
const authenticateUser = require('../middlewares/authMiddleware');

// ✅ تسجيل فحص جديد لخلية
router.post('/', authenticateUser, async (req, res) => {
  const {
    hive_id,
    inspection_date,
    queen_seen,
    eggs_seen,
    queen_cell_present,
    brood_quality,
    food_storage,
    sickness_signs,
    frame_count,
    revisit_needed,
    revisit_date,
    notes
  } = req.body;

  if (!hive_id) {
    return res.status(400).json({ error: 'hive_id is required' });
  }

  try {
    const { data, error } = await supabase
      .from('hive_inspections')
      .insert([{
        hive_id,
        inspection_date: inspection_date || new Date().toISOString().split('T')[0],
        queen_seen,
        eggs_seen,
        queen_cell_present,
        brood_quality,
        food_storage,
        sickness_signs,
        frame_count,
        revisit_needed,
        revisit_date,
        notes,
        user_id: req.user.id
      }])
      .select();

    if (error) {
      return res.status(400).json({ error: error.message });
    }

    res.status(201).json({ message: '✅ Inspection recorded successfully', inspection: data[0] });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Unexpected server error' });
  }
});

// 📥 جلب كل الفحوصات لخلية معينة
router.get('/hive/:hive_id', authenticateUser, async (req, res) => {
  const { hive_id } = req.params;

  try {
    const { data, error } = await supabase
      .from('hive_inspections')
      .select('*')
      .eq('hive_id', hive_id)
      .order('inspection_date', { ascending: false });

    if (error) {
      return res.status(400).json({ error: error.message });
    }

    res.status(200).json({ inspections: data });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Unexpected server error' });
  }
});

// 🔔 تنبيهات حسب الفلتر (today, overdue, upcoming, all) + بيانات الخلية والمنحل
router.get('/alerts/revisits', authenticateUser, async (req, res) => {
  const filter = req.query.filter || 'today';
  const today = new Date().toISOString().split('T')[0];

  try {
    let query = supabase
      .from('hive_inspections')
      .select(`
        inspection_id,
        hive_id,
        revisit_date,
        revisit_needed,
        hives(
          hive_code,
          apiary_id,
          apiaries(apiary_name, commune, department)
        )
      `)
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

    if (error) {
      return res.status(400).json({ error: error.message });
    }

    res.status(200).json({ alerts: data });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Unexpected server error' });
  }
});

module.exports = router;