// routes/hivesPublic.js
const express = require('express');
const router = express.Router();
const supabase = require('../utils/supabaseClient');

// 📡 راوت جلب بيانات الخلية من public_key
router.get('/public/:public_key', async (req, res) => {
  const { public_key } = req.params;

  try {
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

    const { data: apiary } = await supabase
      .from('apiaries')
      .select('apiary_name, commune, department, company_id')
      .eq('apiary_id', hive.apiary_id)
      .single();

    let companyName = null;
    if (apiary?.company_id) {
      const { data: company } = await supabase
        .from('companies')
        .select('company_name')
        .eq('company_id', apiary.company_id)
        .single();
      companyName = company?.company_name || null;
    }

    res.json({
      hive,
      apiary,
      company_name: companyName
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Unexpected server error' });
  }
});

// 📡 راوت جلب بيانات الخلية من public_key
router.get('/public/:public_key', async (req, res) => {
    const { public_key } = req.params;
  
    try {
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
  
      const { data: apiary } = await supabase
        .from('apiaries')
        .select('apiary_name, commune, department, company_id')
        .eq('apiary_id', hive.apiary_id)
        .single();
  
      let companyName = null;
      if (apiary?.company_id) {
        const { data: company } = await supabase
          .from('companies')
          .select('company_name')
          .eq('company_id', apiary.company_id)
          .single();
        companyName = company?.company_name || null;
      }
  
      res.json({
        hive,
        apiary,
        company_name: companyName
      });
    } catch (err) {
      console.error(err);
      res.status(500).json({ error: 'Unexpected server error' });
    }
  });

module.exports = router;
