// routes/hivesPublic.js
const express = require('express');
const router = express.Router();
const supabase = require('../utils/supabaseClient');

// 📡 راوت جلب بيانات الخلية من public_key
// 📡 راوت جلب بيانات الخلية من public_key
router.get('/public/:public_key', async (req, res) => {
  const { public_key } = req.params;

  try {
    // 🐝 جلب بيانات الخلية
    const { data: hive, error: hiveError } = await supabase
      .from('hives')
      .select(`
        hive_id,
        hive_code,
        hive_type,
        hive_purpose,
        empty_weight,
        frame_capacity,
        apiary_id,
        created_at
      `)
      .eq('public_key', public_key)
      .single();

    if (hiveError || !hive) {
      return res.status(404).json({ error: 'Hive not found' });
    }

    // 🌱 جلب بيانات المنحل المرتبط بالخلية
    const { data: apiary } = await supabase
      .from('apiaries')
      .select('apiary_name, commune, department, company_id, owner_user_id')
      .eq('apiary_id', hive.apiary_id)
      .single();

    let label = 'Hive Owner';

    // 🏢 إذا كان المنحل مرتبط بشركة، استخدم اسم الشركة
    if (apiary?.company_id) {
      const { data: company } = await supabase
        .from('companies')
        .select('company_name')
        .eq('company_id', apiary.company_id)
        .single();

      if (company?.company_name) {
        label = company.company_name;
      }

    // 👤 إذا لم توجد شركة، استخدم اسم المالك من جدول المستخدمين
    } else if (apiary?.owner_user_id) {
      const { data: user } = await supabase
        .from('users')
        .select('full_name')
        .eq('user_id', apiary.owner_user_id)
        .single();

      if (user?.full_name) {
        label = user.full_name;
      }
    }

    return res.json({
      hive,
      apiary,
      label
    });

  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: 'Unexpected server error' });
  }
});

module.exports = router;


