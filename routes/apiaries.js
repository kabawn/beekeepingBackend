// routes/apiaries.js
const express = require("express");
const router = express.Router();
const pool = require("../db");
const authenticateUser = require("../middlewares/authMiddleware");
const PDFDocument = require("pdfkit");
const QRCode = require("qrcode");
const path = require("path");

const fontArabic = path.join(
   __dirname,
   "..",
   "assets",
   "fonts",
   "NotoNaskhArabic-VariableFont_wght.ttf"
);

// تسجيل الخط

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

/**
 * ✅ Generate ONE PDF containing QR codes for ALL hives in one apiary
 * QR CONTENT = hive.public_key (RAW) ✅
 *
 * GET /apiaries/:id/hives/qr-pdf?label_mm=40&gap_mm=4&text=1&title=1
 */
router.get("/:id/hives/qr-pdf", authenticateUser, async (req, res) => {
   const { id } = req.params; // apiary_id
   const userId = req.user.id;

   // خيارات للطباعة
   const labelSizeMm = Number(req.query.label_mm || 40); // ✅ أفضل افتراضيًا من 50mm
   const gapMm = Number(req.query.gap_mm || 4);
   const showText = (req.query.text ?? "1") !== "0"; // 1=show, 0=hide
   const showTitle = (req.query.title ?? "1") !== "0"; // عنوان الصفحة

   try {
      // ✅ تحقق ملكية المنحل (للتأكد فقط + نحتاج company_id)
      const ownership = await pool.query(
         "SELECT company_id FROM apiaries WHERE apiary_id = $1 AND owner_user_id = $2 LIMIT 1",
         [id, userId]
      );
      if (ownership.rows.length === 0) {
         return res.status(404).json({ error: "Apiary not found" });
      }

      const { company_id } = ownership.rows[0];

      // ✅ جلب خلايا المنحل
      const hivesResult = await pool.query(
         "SELECT hive_id, hive_code, public_key FROM hives WHERE apiary_id = $1 ORDER BY hive_id ASC",
         [id]
      );

      const hives = hivesResult.rows || [];
      if (hives.length === 0) {
         return res.status(404).json({ error: "No hives found for this apiary" });
      }

      // ✅ ownerLabel = اسم الشركة (إن وجد) وإلا اسم المستخدم — بدون BeeStats وبدون apiary_name
      let ownerLabel = "";

      if (company_id) {
         const c = await pool.query(
            "SELECT company_name FROM companies WHERE company_id = $1 LIMIT 1",
            [company_id]
         );
         ownerLabel = (c.rows[0]?.company_name || "").trim();
      }

      if (!ownerLabel) {
         // ⚠️ عدّل الجدول/العمود حسب مشروعك (users / profiles)
         const u = await pool.query("SELECT full_name FROM users WHERE id = $1 LIMIT 1", [userId]);
         ownerLabel = (u.rows[0]?.full_name || "").trim();
      }

      // ====== PDF Response ======
      res.setHeader("Content-Type", "application/pdf");
      res.setHeader("Content-Disposition", `attachment; filename="apiary-${id}-qr-codes.pdf"`);

      const doc = new PDFDocument({ size: "A4", margin: mmToPt(10) });
      doc.pipe(res);

      // ✅ Register Arabic font AFTER creating doc
      doc.registerFont("AR", fontArabic);

      // ====== Layout ======
      const labelSize = mmToPt(labelSizeMm);
      const gap = mmToPt(gapMm);

      const pageW = doc.page.width;
      const pageH = doc.page.height;

      const left = doc.page.margins.left;
      const right = doc.page.margins.right;
      const top = doc.page.margins.top;
      const bottom = doc.page.margins.bottom;

      // مسافة عنوان أعلى الصفحة
      const headerH = showTitle ? mmToPt(10) : 0;

      // ارتفاع النص تحت QR
      const textH = showText ? mmToPt(12) : 0;

      // مساحة قابلة للاستخدام
      const usableW = pageW - left - right;
      const usableH = pageH - top - bottom - headerH;

      // ✅ احسب cols تلقائياً حسب عرض الصفحة (أفضل من تحديدها يدويًا)
      const cols = Math.max(1, Math.floor((usableW + gap) / (labelSize + gap)));
      const cellW = labelSize + gap;
      const cellH = labelSize + textH + gap;

      const rows = Math.max(1, Math.floor((usableH + gap) / cellH));
      const perPage = cols * rows;

      // ✅ توسيط الشبكة أفقياً لتحسين الشكل
      const gridW = cols * labelSize + (cols - 1) * gap;
      const startX = left + Math.max(0, (usableW - gridW) / 2);
      const startY = top + headerH;

      // ====== Title (اختياري) ======
      const drawHeader = () => {
         if (!showTitle) return;

         // عنوان خفيف: اسم المالك + عدد الخلايا
         const title = ownerLabel ? ownerLabel : " ";
         doc.font("AR")
            .fontSize(12)
            .fillColor("#000")
            .text(title, left, top - mmToPt(2), { align: "left" });

         doc.font("AR")
            .fontSize(9)
            .fillColor("#666")
            .text(`Ruches: ${hives.length}`, left, top + mmToPt(3), { align: "left" });

         doc.fillColor("#000");
      };

      drawHeader();

      // ====== Draw QR grid ======
      for (let i = 0; i < hives.length; i++) {
         const hive = hives[i];

         // صفحة جديدة
         if (i > 0 && i % perPage === 0) {
            doc.addPage();
            drawHeader();
         }

         const localPos = i % perPage;
         const col = localPos % cols;
         const row = Math.floor(localPos / cols);

         const x = startX + col * cellW;
         const y = startY + row * cellH;

         const qrData = String(hive.public_key || "").trim();
         if (!qrData) continue;

         // QR buffer
         const qrPng = await QRCode.toBuffer(qrData, {
            type: "png",
            width: 512,
            margin: 1,
            errorCorrectionLevel: "M",
         });

         // ✅ إطار بسيط (يحسن شكل الملصق عند القص)
         doc.roundedRect(
            x - mmToPt(1),
            y - mmToPt(1),
            labelSize + mmToPt(2),
            labelSize + textH + mmToPt(2),
            4
         )
            .lineWidth(0.5)
            .strokeColor("#E6E6E6")
            .stroke()
            .strokeColor("#000");

         // QR
         doc.image(qrPng, x, y, { width: labelSize, height: labelSize });

         // نص
         if (showText) {
            // سطر 1: Ruche: XX-YY
            doc.font("AR")
               .fontSize(9)
               .fillColor("#000")
               .text(`Ruche: ${hive.hive_code}`, x, y + labelSize + mmToPt(1), {
                  width: labelSize,
                  align: "center",
               });

            // سطر 2: اسم الشركة/المستخدم (اختياري لو فاضي)
            if (ownerLabel) {
               doc.font("AR")
                  .fontSize(9)
                  .fillColor("#444")
                  .text(ownerLabel, x, y + labelSize + mmToPt(6), {
                     width: labelSize,
                     align: "center",
                  })
                  .fillColor("#000");
            }
         }
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
