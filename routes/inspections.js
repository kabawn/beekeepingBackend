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
// 📥 جلب كل الفحوصات لخلية معينة
router.get('/hive/:hive_id', authenticateUser, async (req, res) => {
  const { hive_id } = req.params;

  try {
    const { data: inspections, error } = await supabase
      .from('hive_inspections')
      .select(`
         *,
         hives(frame_capacity)
      `)
      .eq('hive_id', hive_id)
      .order('inspection_date', { ascending: false });

    if (error) {
      return res.status(400).json({ error: error.message });
    }

    // 🧮 Calculate missing frames
    const result = inspections.map((insp) => ({
      ...insp,
      missing_frames:
        insp.hives?.frame_capacity != null && insp.frame_count != null
          ? insp.hives.frame_capacity - insp.frame_count
          : null,
    }));

    res.status(200).json({ inspections: result });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Unexpected server error' });
  }
});


// 🔔 تنبيهات حسب الفلتر (today, overdue, upcoming, all) + بيانات الخلية والمنحل
// 🔔 GET /inspections/alerts/revisits?filter=today|overdue|upcoming
router.get('/alerts/revisits', authenticateUser, async (req, res) => {
  const filter = req.query.filter || 'upcoming';
  const today = new Date();
  const todayStr = today.toISOString().split('T')[0];

  const upcomingLimit = new Date(today);
  upcomingLimit.setDate(today.getDate() + 3);
  const upcomingLimitStr = upcomingLimit.toISOString().split('T')[0];

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
          apiary(name)
        )
      `)
      .eq('revisit_needed', true);

    if (filter === 'today') {
      query = query.eq('revisit_date', todayStr);
    } else if (filter === 'overdue') {
      query = query.lt('revisit_date', todayStr);
    } else if (filter === 'upcoming') {
      query = query.gte('revisit_date', todayStr).lte('revisit_date', upcomingLimitStr);
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

// 🗑️ حذف فحص بناءً على المعرف
router.delete('/:id', authenticateUser, async (req, res) => {
  const { id } = req.params;

  try {
    const { error } = await supabase
      .from('hive_inspections')
      .delete()
      .eq('inspection_id', id)
      .eq('user_id', req.user.id); // Optional: ensure only the owner can delete

    if (error) {
      return res.status(400).json({ error: error.message });
    }

    res.status(200).json({ message: '🗑️ Inspection deleted successfully' });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Unexpected server error' });
  }
});

module.exports = router;