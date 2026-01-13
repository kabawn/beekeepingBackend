// routes/apiaries.js
const express = require("express");
const router = express.Router();
const pool = require("../db");
const authenticateUser = require("../middlewares/authMiddleware");
const PDFDocument = require("pdfkit");
const QRCode = require("qrcode");

// mm -> points (PDF uses points)
const mmToPt = (mm) => mm * 2.83464567;
// helper: normalize array of productions
function normalizeProductions(raw, mainProd) {
   if (Array.isArray(raw) && raw.length > 0) {
      return [...new Set(raw.map((v) => String(v).toLowerCase()))];
   }
   if (mainProd) return [String(mainProd).toLowerCase()];
   return ["honey"];
}

// CREATE APIARY
router.post("/", authenticateUser, async (req, res) => {
   const userId = req.user.id;

   const {
      apiary_name,
      location,
      commune,
      department,
      land_owner_name,
      phone,
      main_production, // string
      productions, // array of strings (optional)
   } = req.body;

   try {
      // 1) subscription
      const subResult = await pool.query(
         "SELECT plan_type FROM subscriptions WHERE user_id = $1 LIMIT 1",
         [userId]
      );
      const planType = subResult.rows[0]?.plan_type || "free";

      if (planType === "free") {
         const countResult = await pool.query(
            "SELECT COUNT(*) FROM apiaries WHERE owner_user_id = $1",
            [userId]
         );
         const apiaryCount = parseInt(countResult.rows[0].count, 10);

         if (apiaryCount >= 1) {
            return res.status(403).json({
               error: "Free users can only create one apiary. Please upgrade your plan.",
            });
         }
      }

      // 2) main production
      const safeMain = (main_production || "honey").toLowerCase();

      // 3) insert apiary
      const insertResult = await pool.query(
         `INSERT INTO apiaries (
            apiary_name,
            location,
            commune,
            department,
            land_owner_name,
            phone,
            owner_user_id,
            main_production
         )
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
         RETURNING *`,
         [apiary_name, location, commune, department, land_owner_name, phone, userId, safeMain]
      );

      const apiary = insertResult.rows[0];
      const apiaryId = apiary.apiary_id;

      // 4) insert productions into apiary_productions
      const prodList = normalizeProductions(productions, safeMain);

      if (prodList.length > 0) {
         await pool.query(
            `UPDATE apiary_productions
             SET is_active = TRUE, deactivated_at = NULL
             WHERE apiary_id = $1 AND production_type = ANY($2::text[])`,
            [apiaryId, prodList]
         );

         await Promise.all(
            prodList.map((p) =>
               pool.query(
                  `INSERT INTO apiary_productions (apiary_id, production_type, is_active, deactivated_at)
       VALUES ($1, $2, TRUE, NULL)
       ON CONFLICT (apiary_id, production_type)
       DO UPDATE SET
         is_active = TRUE,
         deactivated_at = NULL`,
                  [id, p]
               )
            )
         );
      }

      return res.status(201).json({
         apiary,
         productions: prodList,
      });
   } catch (error) {
      console.error("Error creating apiary:", error);
      return res.status(500).json({ error: "Server error while creating apiary" });
   }
});

// HIVE COUNT
router.get("/:id/hives/count", authenticateUser, async (req, res) => {
   const { id } = req.params;
   const userId = req.user.id;

   try {
      const ownership = await pool.query(
         "SELECT 1 FROM apiaries WHERE apiary_id = $1 AND owner_user_id = $2 LIMIT 1",
         [id, userId]
      );

      if (ownership.rows.length === 0) {
         return res.status(404).json({ error: "Apiary not found" });
      }

      const result = await pool.query("SELECT COUNT(*) AS count FROM hives WHERE apiary_id = $1", [
         id,
      ]);
      res.json({ count: parseInt(result.rows[0].count, 10) });
   } catch (error) {
      console.error("Error fetching hive count:", error);
      res.status(500).json({ error: "Server error while fetching hive count" });
   }
});

// GET USER APIARIES (with productions[])
router.get("/", authenticateUser, async (req, res) => {
   try {
      const userId = req.user.id;

      const result = await pool.query(
         `
         SELECT 
            a.*,
            COALESCE(
               json_agg(p.production_type)
                 FILTER (WHERE p.production_type IS NOT NULL AND p.is_active = TRUE),
               '[]'
            ) AS productions
         FROM apiaries a
         LEFT JOIN apiary_productions p
           ON p.apiary_id = a.apiary_id
         WHERE a.owner_user_id = $1
         GROUP BY a.apiary_id
         ORDER BY a.apiary_id ASC
         `,
         [userId]
      );

      res.json({ apiaries: result.rows });
   } catch (error) {
      console.error("Error fetching apiaries for user:", error);
      res.status(500).json({ error: "Server error while fetching user apiaries" });
   }
});

// HIVES FOR ONE APIARY
// HIVES FOR ONE APIARY (with optional pagination)
router.get("/:id/hives", authenticateUser, async (req, res) => {
   const { id } = req.params;
   const userId = req.user.id;
   const { limit, offset } = req.query;

   try {
      // ✅ تأكد من ملكية المنحل
      const ownership = await pool.query(
         "SELECT 1 FROM apiaries WHERE apiary_id = $1 AND owner_user_id = $2 LIMIT 1",
         [id, userId]
      );

      if (ownership.rows.length === 0) {
         return res.status(404).json({ error: "Apiary not found" });
      }

      // 🔹 لو ما فيه limit/offset → سلوك قديم (كل الهفز)
      if (!limit && !offset) {
         const result = await pool.query(
            "SELECT * FROM hives WHERE apiary_id = $1 ORDER BY hive_id ASC",
            [id]
         );
         return res.json(result.rows);
      }

      // 🔹 لو فيه pagination
      const safeLimit = Math.min(parseInt(limit, 10) || 60, 200); // max 200 per page
      const safeOffset = parseInt(offset, 10) || 0;

      const result = await pool.query(
         "SELECT * FROM hives WHERE apiary_id = $1 ORDER BY hive_id ASC LIMIT $2 OFFSET $3",
         [id, safeLimit, safeOffset]
      );

      return res.json({ hives: result.rows });
   } catch (error) {
      console.error("Error fetching hives for apiary:", error);
      res.status(500).json({ error: "Server error while fetching hives for apiary" });
   }
});

router.get("/:id/hives/qr-pdf", authenticateUser, async (req, res) => {
   const { id } = req.params; // apiary_id
   const userId = req.user.id;

   // خيارات للطباعة (اختياري)
   const labelSizeMm = Number(req.query.label_mm || 50); // 50mm = 5cm
   const gapMm = Number(req.query.gap_mm || 6); // مسافة بين الملصقات
   const cols = Number(req.query.cols || 3); // عدد الأعمدة
   const showText = (req.query.text ?? "1") !== "0"; // إظهار النص تحت QR

   try {
      // ✅ تحقق ملكية المنحل
      const ownership = await pool.query(
         "SELECT apiary_name, company_id FROM apiaries WHERE apiary_id = $1 AND owner_user_id = $2 LIMIT 1",
         [id, userId]
      );
      if (ownership.rows.length === 0) {
         return res.status(404).json({ error: "Apiary not found" });
      }

      const apiary = ownership.rows[0];

      // ✅ جلب خلايا المنحل
      const hivesResult = await pool.query(
         "SELECT hive_id, hive_code, public_key FROM hives WHERE apiary_id = $1 ORDER BY hive_id ASC",
         [id]
      );
      const hives = hivesResult.rows || [];

      if (hives.length === 0) {
         return res.status(404).json({ error: "No hives found for this apiary" });
      }

      // (اختياري) اسم الشركة
      let ownerLabel = apiary.apiary_name || "BeeStats";
      if (apiary.company_id) {
         const c = await pool.query(
            "SELECT company_name FROM companies WHERE company_id = $1 LIMIT 1",
            [apiary.company_id]
         );
         ownerLabel = c.rows[0]?.company_name || ownerLabel;
      }

      // ====== تجهيز PDF Response ======
      res.setHeader("Content-Type", "application/pdf");
      res.setHeader("Content-Disposition", `attachment; filename="apiary-${id}-qr-codes.pdf"`);

      const doc = new PDFDocument({ size: "A4", margin: mmToPt(10) });
      doc.pipe(res);

      // مقاسات وتخطيط
      const pageWidth = doc.page.width;
      const pageHeight = doc.page.height;

      const labelSize = mmToPt(labelSizeMm);
      const gap = mmToPt(gapMm);

      const startX = doc.page.margins.left;
      const startY = doc.page.margins.top;

      // ارتفاع إضافي للنص تحت QR
      const textBlock = showText ? mmToPt(10) : 0;

      const cellW = labelSize + gap;
      const cellH = labelSize + textBlock + gap;

      // لو cols كبيرة/صغيرة، نحسب تلقائياً إن تحب (هنا ثابتة من query)
      const maxRows = Math.floor((pageHeight - startY - doc.page.margins.bottom + gap) / cellH);

      // عنوان صغير (اختياري)
      doc.fontSize(12).text(`BeeStats — ${ownerLabel}`, { align: "left" });
      doc.moveDown(0.5);

      let index = 0;

      for (const hive of hives) {
         // صفحة جديدة لو امتلأت
         const pos = index; // يبدأ من 0
         const col = pos % cols;
         const row = Math.floor(pos / cols) % maxRows;

         // إذا دخلنا على row=0 بعد maxRows*cols → صفحة جديدة
         if (pos > 0 && pos % (cols * maxRows) === 0) {
            doc.addPage();
            doc.fontSize(12).text(`BeeStats — ${ownerLabel}`, { align: "left" });
            doc.moveDown(0.5);
         }

         const baseX = startX + col * cellW;
         const baseY = startY + mmToPt(8) + row * cellH; // +8mm تحت العنوان

         const qrUrl = `https://yourapp.com/hive/${hive.public_key}`;

         // QR كـ PNG buffer
         const qrPng = await QRCode.toBuffer(qrUrl, {
            type: "png",
            width: 512,
            margin: 1,
            errorCorrectionLevel: "M",
         });

         // رسم QR
         doc.image(qrPng, baseX, baseY, { width: labelSize, height: labelSize });

         // نص تحت QR
         if (showText) {
            doc.fontSize(9).text(`Ruche: ${hive.hive_code}`, baseX, baseY + labelSize + mmToPt(1), {
               width: labelSize,
               align: "center",
            });
            doc.fontSize(8)
               .fillColor("#444")
               .text(ownerLabel, baseX, baseY + labelSize + mmToPt(5), {
                  width: labelSize,
                  align: "center",
               })
               .fillColor("#000");
         }

         index++;
      }

      doc.end();
   } catch (error) {
      console.error("❌ qr-pdf error:", error);
      return res.status(500).json({ error: "Failed to generate PDF" });
   }
});

// GET ONE APIARY (with productions[])
router.get("/:id", authenticateUser, async (req, res) => {
   const { id } = req.params;
   const userId = req.user.id;

   try {
      const result = await pool.query(
         `
         SELECT 
            a.*,
            COALESCE(
               json_agg(p.production_type)
                 FILTER (WHERE p.production_type IS NOT NULL AND p.is_active = TRUE),
               '[]'
            ) AS productions
         FROM apiaries a
         LEFT JOIN apiary_productions p
           ON p.apiary_id = a.apiary_id
         WHERE a.apiary_id = $1
           AND a.owner_user_id = $2
         GROUP BY a.apiary_id
         `,
         [id, userId]
      );

      if (result.rows.length === 0) {
         return res.status(404).json({ error: "Apiary not found" });
      }

      res.json(result.rows[0]);
   } catch (error) {
      console.error("Error fetching apiary:", error);
      res.status(500).json({ error: "Server error while fetching apiary" });
   }
});

// UPDATE APIARY
router.put("/:id", authenticateUser, async (req, res) => {
   const { id } = req.params;
   const userId = req.user.id;

   const {
      apiary_name,
      location,
      commune,
      department,
      land_owner_name,
      phone,
      main_production,
      productions, // optional multi-edit
   } = req.body;

   try {
      const safeMain = (main_production || "honey").toLowerCase();

      const result = await pool.query(
         `UPDATE apiaries
          SET apiary_name = $1,
              location = $2,
              commune = $3,
              department = $4,
              land_owner_name = $5,
              phone = $6,
              main_production = $7
          WHERE apiary_id = $8
          AND owner_user_id = $9
          RETURNING *`,
         [apiary_name, location, commune, department, land_owner_name, phone, safeMain, id, userId]
      );

      if (result.rows.length === 0) {
         return res.status(404).json({ error: "Apiary not found" });
      }

      const apiary = result.rows[0];

      if (Array.isArray(productions)) {
         const prodList = normalizeProductions(productions, safeMain);

         // deactivate old ones
         await pool.query(
            `UPDATE apiary_productions
             SET is_active = FALSE, deactivated_at = now()
             WHERE apiary_id = $1 AND is_active = TRUE`,
            [id]
         );

         // reactivate existing and insert missing
         await pool.query(
            `UPDATE apiary_productions
             SET is_active = TRUE, deactivated_at = NULL
             WHERE apiary_id = $1 AND production_type = ANY($2::text[])`,
            [id, prodList]
         );

         await Promise.all(
            prodList.map((p) =>
               pool.query(
                  `INSERT INTO apiary_productions (apiary_id, production_type, is_active)
                   SELECT $1, $2, TRUE
                   WHERE NOT EXISTS (
                     SELECT 1 FROM apiary_productions
                     WHERE apiary_id = $1 AND production_type = $2
                   )`,
                  [id, p]
               )
            )
         );
      }

      res.json({ apiary });
   } catch (error) {
      console.error("Error updating apiary:", error);
      res.status(500).json({ error: "Server error while updating apiary" });
   }
});

// DELETE APIARY
router.delete("/:id", authenticateUser, async (req, res) => {
   const { id } = req.params;
   const userId = req.user.id;

   try {
      const result = await pool.query(
         "DELETE FROM apiaries WHERE apiary_id = $1 AND owner_user_id = $2 RETURNING *",
         [id, userId]
      );
      if (result.rows.length === 0) {
         return res.status(404).json({ error: "Apiary not found" });
      }
      res.json({ message: "Apiary deleted successfully", apiary: result.rows[0] });
   } catch (error) {
      console.error("Error deleting apiary:", error);
      res.status(500).json({ error: "Server error while deleting apiary" });
   }
});

module.exports = router;
