// routes/hives.js
const express = require('express');
const router = express.Router();
const { v4: uuidv4 } = require('uuid');
const QRCode = require('qrcode');
const { createCanvas, loadImage } = require('@napi-rs/canvas');
const supabase = require('../utils/supabaseClient');
const authenticateUser = require('../middlewares/authMiddleware');

// 🐝 إنشاء خلية جديدة
router.post('/', authenticateUser, async (req, res) => {
  const {
    hive_code,
    hive_type,
    hive_purpose,
    empty_weight,
    frame_capacity,
    apiary_id,
    public_key,
  } = req.body;

  if (!apiary_id) {
    return res.status(400).json({ error: 'apiary_id is required.' });
  }

  try {
    // ✅ تحقق من عدم تكرار hive_code أو public_key
    if (hive_code || public_key) {
      const { data: existing, error: checkError } = await supabase
        .from('hives')
        .select('*')
        .or(`hive_code.eq.${hive_code},public_key.eq.${public_key}`)
        .maybeSingle();

      if (existing) {
        return res.status(400).json({ error: 'Hive code or public key already exists' });
      }
    }

    let finalHiveCode = hive_code;
    let finalPublicKey = public_key;

    // ✅ إذا لم يتم إرسال public_key → أنشئهم تلقائياً
    if (!finalPublicKey || !finalHiveCode) {
      const { data: lastHives } = await supabase
        .from('hives')
        .select('hive_code')
        .eq('apiary_id', apiary_id)
        .order('hive_code', { ascending: false })
        .limit(1);

      const lastCode = lastHives?.[0]?.hive_code || `${String(apiary_id).padStart(2, '0')}-00`;
      const [prefix, lastNum] = lastCode.split('-');
      const nextNum = String(parseInt(lastNum) + 1).padStart(2, '0');

      finalHiveCode = `${prefix}-${nextNum}`;
      finalPublicKey = uuidv4();
    } else {
      // ✅ حذف المفتاح من available_public_keys إذا تم استخدامه
      await supabase.from('available_public_keys').delete().eq('public_key', finalPublicKey);
    }

    const qrCode = `https://yourapp.com/hive/${finalPublicKey}`;

    const { data, error } = await supabase
      .from('hives')
      .insert([{
        hive_code: finalHiveCode,
        hive_type,
        hive_purpose,
        empty_weight,
        frame_capacity,
        public_key: finalPublicKey,
        qr_code: qrCode,
        apiary_id
      }])
      .select();

    if (error) {
      return res.status(400).json({ error: error.message });
    }

    res.status(201).json({ message: '✅ Hive created successfully', hive: data[0] });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Unexpected server error' });
  }
});

// 🖼️ تحميل صورة QR مع كود الخلية واسم الشركة
router.get('/qr-download/:public_key', async (req, res) => {
  const { public_key } = req.params;

  try {
    const { data: hive } = await supabase
      .from('hives')
      .select('hive_code, apiary_id')
      .eq('public_key', public_key)
      .single();

    if (!hive) {
      return res.status(404).json({ error: 'Hive not found' });
    }

    const { data: apiary } = await supabase
      .from('apiaries')
      .select('company_id, owner_user_id')
      .eq('apiary_id', hive.apiary_id)
      .single();

    let label = 'Hive Owner';
    if (apiary.company_id) {
      const { data: company } = await supabase
        .from('companies')
        .select('company_name')
        .eq('company_id', apiary.company_id)
        .single();
      label = company?.company_name || label;
    }

    const canvas = createCanvas(300, 380);
    const ctx = canvas.getContext('2d');
    ctx.fillStyle = '#fff';
    ctx.fillRect(0, 0, canvas.width, canvas.height);

    const qrUrl = `https://yourapp.com/hive/${public_key}`;
    const qrDataUrl = await QRCode.toDataURL(qrUrl);
    const qrImg = await loadImage(qrDataUrl);
    ctx.drawImage(qrImg, 25, 20, 250, 250);

    ctx.fillStyle = '#000';
    ctx.font = 'bold 20px Arial';
    ctx.textAlign = 'center';
    ctx.fillText(`Ruche: ${hive.hive_code}`, 150, 300);
    ctx.font = '16px Arial';
    ctx.fillText(label, 150, 340);

    const buffer = canvas.toBuffer('image/png');
    res.setHeader('Content-Disposition', `attachment; filename=hive-${public_key}.png`);
    res.setHeader('Content-Type', 'image/png');
    res.send(buffer);
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: '❌ Failed to generate QR image' });
  }
});

// ✅ جلب خلية حسب ID
router.get('/:id', authenticateUser, async (req, res) => {
  const { id } = req.params;

  try {
    const { data, error } = await supabase
      .from('hives')
      .select('*')
      .eq('hive_id', id)
      .single();

    if (error || !data) {
      return res.status(404).json({ error: 'Hive not found' });
    }

    res.status(200).json(data);
  } catch (err) {
    console.error('Error fetching hive:', err);
    res.status(500).json({ error: 'Unexpected server error while fetching hive' });
  }
});

module.exports = router;