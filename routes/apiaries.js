// routes/apiaries.js
const express = require("express");
const router = express.Router();
const pool = require("../db");
const authenticateUser = require("../middlewares/authMiddleware");
const PDFDocument = require("pdfkit");
const QRCode = require("qrcode");
const path = require("path");
const { createCanvas, GlobalFonts } = require("@napi-rs/canvas");
const DISABLE_FREE_APIARY_LIMIT = true;

const fontArabic = path.join(
   __dirname,
   "..",
   "assets",
   "fonts",
   "NotoNaskhArabic-VariableFont_wght.ttf",
);

try {
   GlobalFonts.registerFromPath(fontArabic, "NotoNaskhArabic");
   console.log("✅ Arabic font registered:", fontArabic);
} catch (e) {
   console.warn("⚠️ Could not register Arabic font:", e?.message || e);
}

// تسجيل الخط

// mm -> points (PDF uses points)
const mmToPt = (mm) => mm * 2.83464567;

// Render text to PNG (fixes Arabic RTL + shaping problems in PDFKit)
function renderTextPng(
   text,
   { width = 240, height = 46, fontSize = 22, color = "#444", fontFamily = "NotoNaskhArabic" } = {},
) {
   const canvas = createCanvas(width, height);
   const ctx = canvas.getContext("2d");

   // Transparent background
   ctx.clearRect(0, 0, width, height);

   // font
   ctx.font = `${fontSize}px "${fontFamily}"`;
   ctx.fillStyle = color;
   ctx.textAlign = "center";
   ctx.textBaseline = "middle";

   // RTL (canvas supports direction; shaping handled by font renderer)
   ctx.direction = "rtl";

   // Draw
   ctx.fillText(String(text || ""), width / 2, height / 2);

   return canvas.toBuffer("image/png");
}

// Light fallback for non-arabic (still ok as PNG)
function renderTextPngLTR(text, opts = {}) {
   const canvas = createCanvas(opts.width || 240, opts.height || 46);
   const ctx = canvas.getContext("2d");

   ctx.clearRect(0, 0, canvas.width, canvas.height);

   ctx.font = `${opts.fontSize || 18}px "Arial"`;
   ctx.fillStyle = opts.color || "#444";
   ctx.textAlign = "center";
   ctx.textBaseline = "middle";
   ctx.direction = "ltr";

   ctx.fillText(String(text || ""), canvas.width / 2, canvas.height / 2);

   return canvas.toBuffer("image/png");
}

function hasArabic(text) {
   return /[\u0600-\u06FF]/.test(String(text || ""));
}

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
         [userId],
      );
      const planType = subResult.rows[0]?.plan_type || "free";

      if (!DISABLE_FREE_APIARY_LIMIT && planType === "free") {
         const countResult = await pool.query(
            "SELECT COUNT(*) FROM apiaries WHERE owner_user_id = $1",
            [userId],
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
         [apiary_name, location, commune, department, land_owner_name, phone, userId, safeMain],
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
            [apiaryId, prodList],
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
                  [apiaryId, p], // ✅ FIX HERE
               ),
            ),
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
         [id, userId],
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
   const tTotal0 = Date.now();
   const userId = req.user.id;

   try {
      const tDb0 = Date.now();

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
         [userId],
      );

      const dbMs = Date.now() - tDb0;
      const totalMs = Date.now() - tTotal0;

      console.log("🧠 DB /api/apiaries ms =", dbMs);
      console.log("⏱️ TOTAL /api/apiaries ms =", totalMs);

      return res.json({ apiaries: result.rows, perf: { dbMs, totalMs } });
   } catch (error) {
      console.error("Error fetching apiaries for user:", error);
      return res.status(500).json({ error: "Server error while fetching user apiaries" });
   }
});

// HIVES FOR ONE APIARY
// HIVES FOR ONE APIARY (with optional pagination)
router.get("/:id/hives", authenticateUser, async (req, res) => {
   const { id } = req.params;
   const userId = req.user.id;
   const { limit, offset, include_supers } = req.query;

   try {
      // ownership
      const ownership = await pool.query(
         "SELECT 1 FROM apiaries WHERE apiary_id = $1 AND owner_user_id = $2 LIMIT 1",
         [id, userId],
      );
      if (ownership.rows.length === 0) {
         return res.status(404).json({ error: "Apiary not found" });
      }

      const safeLimit = Math.min(parseInt(limit, 10) || 60, 200);
      const safeOffset = parseInt(offset, 10) || 0;

      const withSupers = String(include_supers || "0") === "1";

      // ✅ لو ما تبي supers: رجّع الخلايا مثل قبل
      if (!withSupers) {
         const r = await pool.query(
            "SELECT * FROM hives WHERE apiary_id = $1 ORDER BY hive_id ASC LIMIT $2 OFFSET $3",
            [id, safeLimit, safeOffset],
         );
         return res.json({ hives: r.rows });
      }

      // ✅ WITH supers بدون GROUP BY
      const q = await pool.query(
         `
      SELECT
        h.*,
        COALESCE(s.supers, '[]'::json) AS supers
      FROM hives h
      LEFT JOIN LATERAL (
        SELECT json_agg(
          json_build_object(
            'super_id', sp.super_id,
            'super_code', sp.super_code,
            'active', sp.active
          )
          ORDER BY sp.created_at DESC
        ) AS supers
        FROM supers sp
        WHERE sp.hive_id = h.hive_id
          AND sp.active = true
      ) s ON true
      WHERE h.apiary_id = $1
      ORDER BY h.hive_id ASC
      LIMIT $2 OFFSET $3
      `,
         [id, safeLimit, safeOffset],
      );

      return res.json({ hives: q.rows });
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
/**
 * ✅ ONE PDF for ALL hives in one apiary
 * ✅ QR CONTENT = hive.public_key (RAW)
 * ✅ Under QR: hive_code only + ownerLabel (as PNG for Arabic correctness)
 *
 * GET /apiaries/:id/hives/qr-pdf?label_mm=40&gap_mm=4&text=1&title=1
 */
/**
 * ✅ A4 PDF — QR labels for ALL hives in one apiary
 * ✅ QR CONTENT = hive.public_key (RAW)
 * ✅ Header (top of page): apiary_name (Arabic-safe as PNG)
 * ✅ Under each QR: hive_code ONLY (no "Ruche", no owner name)
 *
 * GET /apiaries/:id/hives/qr-pdf?label_mm=40&gap_mm=4&text=1&title=1
 */

router.get("/:id/hives/qr-pdf", authenticateUser, async (req, res) => {
   const { id } = req.params; // apiary_id
   const userId = req.user.id;

   // --- print options ---
   const labelSizeMm = Number(req.query.label_mm || 40); // QR size
   const gapMm = Number(req.query.gap_mm || 4); // gap between labels
   const showText = (req.query.text ?? "1") !== "0"; // show hive_code
   const showTitle = (req.query.title ?? "1") !== "0"; // show apiary title

   try {
      // ✅ ownership + apiary_name
      const ownership = await pool.query(
         "SELECT apiary_name FROM apiaries WHERE apiary_id = $1 AND owner_user_id = $2 LIMIT 1",
         [id, userId],
      );

      if (ownership.rows.length === 0) {
         return res.status(404).json({ error: "Apiary not found" });
      }

      const apiaryName = String(ownership.rows[0]?.apiary_name || "").trim();

      // ✅ hives
      const hivesResult = await pool.query(
         "SELECT hive_id, hive_code, public_key FROM hives WHERE apiary_id = $1 ORDER BY hive_id ASC",
         [id],
      );

      const hives = hivesResult.rows || [];
      if (hives.length === 0) {
         return res.status(404).json({ error: "No hives found for this apiary" });
      }

      // ===== PDF headers =====
      res.setHeader("Content-Type", "application/pdf");
      res.setHeader("Content-Disposition", `attachment; filename="apiary-${id}-qr-codes.pdf"`);

      const doc = new PDFDocument({ size: "A4", margin: mmToPt(10) });
      doc.pipe(res);

      // ===== Layout =====
      const labelSize = mmToPt(labelSizeMm);
      const gap = mmToPt(gapMm);

      const pageW = doc.page.width;
      const pageH = doc.page.height;

      const left = doc.page.margins.left;
      const right = doc.page.margins.right;
      const top = doc.page.margins.top;
      const bottom = doc.page.margins.bottom;

      // header area height (only once per page)
      const headerH = showTitle ? mmToPt(14) : 0; // gives space for title + small line
      // text area under each QR
      const textH = showText ? mmToPt(10) : 0;

      const usableW = pageW - left - right;
      const usableH = pageH - top - bottom - headerH;

      // auto columns based on printable width
      const cols = Math.max(1, Math.floor((usableW + gap) / (labelSize + gap)));
      const cellW = labelSize + gap;
      const cellH = labelSize + textH + gap;

      const rows = Math.max(1, Math.floor((usableH + gap) / cellH));
      const perPage = cols * rows;

      // center grid horizontally
      const gridW = cols * labelSize + (cols - 1) * gap;
      const startX = left + Math.max(0, (usableW - gridW) / 2);
      const startY = top + headerH;

      // ===== Header (apiary name only) — Arabic-safe =====
      const titlePng =
         showTitle && apiaryName
            ? hasArabic(apiaryName)
               ? renderTextPng(apiaryName, {
                    width: 900,
                    height: 60,
                    fontSize: 34,
                    color: "#000",
                    fontFamily: "NotoNaskhArabic",
                 })
               : renderTextPngLTR(apiaryName, {
                    width: 900,
                    height: 60,
                    fontSize: 26,
                    color: "#000",
                 })
            : null;

      const drawHeader = () => {
         if (!showTitle) return;

         // title (apiary name)
         if (titlePng) {
            // keep within page width (in points). 170mm is safe on A4 with margins
            doc.image(titlePng, left, top - mmToPt(2), {
               width: mmToPt(170),
               height: mmToPt(12),
            });
         }

         // thin line under the title for a clean A4 look
         doc.moveTo(left, top + mmToPt(12))
            .lineTo(pageW - right, top + mmToPt(12))
            .lineWidth(0.7)
            .strokeColor("#E6E6E6")
            .stroke()
            .strokeColor("#000");
      };

      drawHeader();

      // ===== Labels =====
      for (let i = 0; i < hives.length; i++) {
         const hive = hives[i];

         // new page
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

         const qrPng = await QRCode.toBuffer(qrData, {
            type: "png",
            width: 512,
            margin: 1,
            errorCorrectionLevel: "M",
         });

         // light border (good for cutting)
         doc.roundedRect(
            x - mmToPt(1),
            y - mmToPt(1),
            labelSize + mmToPt(2),
            labelSize + textH + mmToPt(2),
            4,
         )
            .lineWidth(0.5)
            .strokeColor("#E6E6E6")
            .stroke()
            .strokeColor("#000");

         // QR
         doc.image(qrPng, x, y, { width: labelSize, height: labelSize });

         // Under QR: hive_code only
         if (showText) {
            doc.fontSize(16)
               .fillColor("#000")
               .text(String(hive.hive_code || ""), x, y + labelSize + mmToPt(2), {
                  width: labelSize,
                  align: "center",
               });
         }
      }

      doc.end();
   } catch (error) {
      console.error("❌ qr-pdf error:", error);
      return res.status(500).json({ error: "Failed to generate PDF" });
   }
});

// -----------------------------
// GET /apiaries/summary
// Apiaries list + hives count + last inspection date
// -----------------------------
router.get("/summary", authenticateUser, async (req, res) => {
  const userId = req.user.id;

  try {
    const sql = `
      SELECT
        a.apiary_id,
        a.apiary_name,
        COUNT(DISTINCT h.hive_id)::int AS hives_count,
        MAX(i.inspection_date)        AS last_inspection_date
      FROM apiaries a
      LEFT JOIN hives h
        ON h.apiary_id = a.apiary_id
      LEFT JOIN hive_inspections i
        ON i.hive_id = h.hive_id
       AND i.user_id = $1
      WHERE a.owner_user_id = $1
      GROUP BY a.apiary_id, a.apiary_name
      ORDER BY a.apiary_id::int ASC;
    `;

    const { rows } = await pool.query(sql, [userId]);

    return res.json({ apiaries: rows });
  } catch (error) {
    console.error("Error fetching apiaries summary:", error);
    return res.status(500).json({ error: "Server error while fetching apiaries summary" });
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
         [id, userId],
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
         [apiary_name, location, commune, department, land_owner_name, phone, safeMain, id, userId],
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
            [id],
         );

         // reactivate existing and insert missing
         await pool.query(
            `UPDATE apiary_productions
             SET is_active = TRUE, deactivated_at = NULL
             WHERE apiary_id = $1 AND production_type = ANY($2::text[])`,
            [id, prodList],
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
                  [id, p],
               ),
            ),
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
         [id, userId],
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
