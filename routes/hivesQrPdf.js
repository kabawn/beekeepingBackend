const express = require('express');
const router = express.Router();
const PDFDocument = require('pdfkit');
const QRCode = require('qrcode');
const supabase = require('../utils/supabaseClient');

// 🖨️ تحميل PDF يحتوي على QR Codes لكل خلايا منحل معين
router.get('/qr-pdf/:apiary_id', async (req, res) => {
  const { apiary_id } = req.params;
  const layout = req.query.layout || 'pages'; // 'pages' or 'grid'

  try {
    // 1. جلب الخلايا
    const { data: hives } = await supabase
      .from('hives')
      .select('hive_code, public_key, apiary_id')
      .eq('apiary_id', apiary_id);

    if (!hives || hives.length === 0) {
      return res.status(404).json({ error: 'No hives found' });
    }

    // 2. اسم الشركة
    const { data: apiary } = await supabase
      .from('apiaries')
      .select('company_id')
      .eq('apiary_id', apiary_id)
      .single();

    let label = 'Hive Owner';
    if (apiary?.company_id) {
      const { data: company } = await supabase
        .from('companies')
        .select('company_name')
        .eq('company_id', apiary.company_id)
        .single();
      label = company?.company_name || label;
    }

    // 3. إعداد ملف PDF
    const doc = new PDFDocument({ autoFirstPage: false });
    res.setHeader('Content-Disposition', `attachment; filename=qr-apiary-${apiary_id}.pdf`);
    res.setHeader('Content-Type', 'application/pdf');
    doc.pipe(res);

    if (layout === 'grid') {
      const perRow = 2;
      const qrSize = 200;
      const margin = 40;
      const gap = 20;
      let x = margin;
      let y = margin;
      let count = 0;

      doc.addPage();

      for (const hive of hives) {
        const qrUrl = `https://yourapp.com/hive/${hive.public_key}`;
        const qrDataUrl = await QRCode.toDataURL(qrUrl);
        const img = qrDataUrl.replace(/^data:image\/png;base64,/, '');
        const imgBuffer = Buffer.from(img, 'base64');

        doc.image(imgBuffer, x, y, { width: qrSize });
        doc.fontSize(14).text(hive.hive_code, x, y + qrSize + 5, { align: 'center', width: qrSize });
        doc.fontSize(10).text(label, x, y + qrSize + 25, { align: 'center', width: qrSize });

        x += qrSize + gap;
        count++;

        if (count % perRow === 0) {
          x = margin;
          y += qrSize + 60;
          if (y + qrSize + 60 > doc.page.height - margin) {
            doc.addPage();
            y = margin;
          }
        }
      }
    } else {
      for (const hive of hives) {
        const qrUrl = `https://yourapp.com/hive/${hive.public_key}`;
        const qrDataUrl = await QRCode.toDataURL(qrUrl);
        const img = qrDataUrl.replace(/^data:image\/png;base64,/, '');
        const imgBuffer = Buffer.from(img, 'base64');

        doc.addPage();
        doc.image(imgBuffer, 150, 100, { width: 300 });
        doc.fontSize(20).text(`Ruche: ${hive.hive_code}`, { align: 'center' });
        doc.fontSize(16).text(label, { align: 'center' });
      }
    }

    doc.end();
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to generate PDF' });
  }
});

module.exports = router;
