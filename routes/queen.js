// routes/queen.js
const express = require("express");
const router = express.Router();
const pool = require("../db");
const authenticateUser = require("../middlewares/authMiddleware");
const { PDFDocument, StandardFonts, rgb } = require("pdf-lib");
const QRCode = require("qrcode");
const {
   getSeason,
   getDayOfYear,
   getOrCreateQueenSettings,
   getNextGraftIndexForSeason,
   computeGraftDerivedDates,
   buildLotCode,
   generateCellsForLine,
   defaultQrPayloadBuilder,
   getNextLineIndexForDay, // 👈 import helper
} = require("../utils/queenUtils");

// All routes require auth
router.use(authenticateUser);

// ---------------- SETTINGS ----------------

// GET /queen/settings
router.get("/settings", async (req, res) => {
   const ownerId = req.user.id;

   try {
      const settings = await getOrCreateQueenSettings(ownerId);
      res.json({ settings });
   } catch (err) {
      console.error("Error fetching queen settings:", err);
      res.status(500).json({ error: "Error fetching queen settings" });
   }
});

// PUT /queen/settings
router.put("/settings", async (req, res) => {
   const ownerId = req.user.id;
   const { mode, cells_per_strip, g10_offset_days, emergence_offset_days, laying_offset_days } =
      req.body;

   try {
      const { rows } = await pool.query(
         `
         INSERT INTO queen_settings (
            owner_id, mode, cells_per_strip,
            g10_offset_days, emergence_offset_days, laying_offset_days
         )
         VALUES ($1, COALESCE($2, 'simple')::queen_mode, COALESCE($3, 14),
                 COALESCE($4, 10), COALESCE($5, 12), COALESCE($6, 22))
         ON CONFLICT (owner_id) DO UPDATE SET
            mode = EXCLUDED.mode,
            cells_per_strip = EXCLUDED.cells_per_strip,
            g10_offset_days = EXCLUDED.g10_offset_days,
            emergence_offset_days = EXCLUDED.emergence_offset_days,
            laying_offset_days = EXCLUDED.laying_offset_days,
            updated_at = now()
         RETURNING *
         `,
         [
            ownerId,
            mode,
            cells_per_strip,
            g10_offset_days,
            emergence_offset_days,
            laying_offset_days,
         ],
      );

      res.json({ settings: rows[0] });
   } catch (err) {
      console.error("Error updating queen settings:", err);
      res.status(500).json({ error: "Error updating queen settings" });
   }
});

// ---------------- STRAINS CRUD ----------------

// GET /queen/strains
router.get("/strains", async (req, res) => {
   const ownerId = req.user.id;

   try {
      const { rows } = await pool.query(
         `
         SELECT *
         FROM queen_strains
         WHERE owner_id = $1 AND archived_at IS NULL
         ORDER BY season DESC, name ASC
         `,
         [ownerId],
      );
      res.json({ strains: rows });
   } catch (err) {
      console.error("Error fetching queen strains:", err);
      res.status(500).json({ error: "Error fetching queen strains" });
   }
});

// POST /queen/strains
// POST /queen/strains
router.post("/strains", async (req, res) => {
   const ownerId = req.user.id;
   const {
      season,
      name,
      female_line,
      male_line,
      grandmother_female,
      grandfather_female,
      grandmother_male,
      grandfather_male,
      marking,
      insemination1_date,
      insemination2_date,
      class: strainClass,
      selector,
   } = req.body;

   if (!season || !name) {
      return res.status(400).json({ error: "season and name are required" });
   }

   try {
      const { rows } = await pool.query(
         `
         INSERT INTO queen_strains (
            owner_id, season, name,
            female_line, male_line,
            grandmother_female, grandfather_female,
            grandmother_male, grandfather_male,
            marking, insemination1_date, insemination2_date,
            class, selector
         )
         VALUES (
            $1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14
         )
         RETURNING *
         `,
         [
            ownerId,
            season,
            name,
            female_line,
            male_line,
            grandmother_female,
            grandfather_female,
            grandmother_male,
            grandfather_male,
            marking,
            insemination1_date,
            insemination2_date,
            strainClass,
            selector,
         ],
      );

      res.status(201).json({ strain: rows[0] });
   } catch (err) {
      console.error("Error creating queen strain:", err);
      res.status(500).json({ error: "Error creating queen strain" });
   }
});

// PUT /queen/strains/:id
router.put("/strains/:id", async (req, res) => {
   const ownerId = req.user.id;
   const strainId = req.params.id;
   const {
      season,
      name,
      female_line,
      male_line,
      grandmother_female,
      grandfather_female,
      grandmother_male,
      grandfather_male,
      marking,
      insemination1_date,
      insemination2_date,
      class: strainClass,
      selector,
   } = req.body;

   try {
      const { rows } = await pool.query(
         `
         UPDATE queen_strains
         SET
            season = COALESCE($3, season),
            name = COALESCE($4, name),
            female_line = COALESCE($5, female_line),
            male_line = COALESCE($6, male_line),
            grandmother_female = COALESCE($7, grandmother_female),
            grandfather_female = COALESCE($8, grandfather_female),
            grandmother_male = COALESCE($9, grandmother_male),
            grandfather_male = COALESCE($10, grandfather_male),
            marking = COALESCE($11, marking),
            insemination1_date = COALESCE($12, insemination1_date),
            insemination2_date = COALESCE($13, insemination2_date),
            class = COALESCE($14, class),
            selector = COALESCE($15, selector),
            updated_at = now()
         WHERE id = $1 AND owner_id = $2 AND archived_at IS NULL
         RETURNING *
         `,
         [
            strainId,
            ownerId,
            season,
            name,
            female_line,
            male_line,
            grandmother_female,
            grandfather_female,
            grandmother_male,
            grandfather_male,
            marking,
            insemination1_date,
            insemination2_date,
            strainClass,
            selector,
         ],
      );

      if (!rows.length) {
         return res.status(404).json({ error: "Strain not found" });
      }
      res.json({ strain: rows[0] });
   } catch (err) {
      console.error("Error updating queen strain:", err);
      res.status(500).json({ error: "Error updating queen strain" });
   }
});

// DELETE /queen/strains/:id
router.delete("/strains/:id", async (req, res) => {
   const ownerId = req.user.id;
   const strainId = req.params.id;

   try {
      // موجودة وملكك؟
      const strainRes = await pool.query(
         `SELECT id, name, archived_at
       FROM queen_strains
       WHERE id = $1 AND owner_id = $2
       LIMIT 1`,
         [strainId, ownerId],
      );
      if (!strainRes.rows.length) {
         return res.status(404).json({ error: "Strain not found" });
      }

      // مستخدمة في graft lines؟
      const usedRes = await pool.query(
         `SELECT 1
       FROM queen_graft_lines gl
       JOIN queen_graft_sessions gs ON gs.id = gl.session_id
       WHERE gl.strain_id = $1 AND gs.owner_id = $2
       LIMIT 1`,
         [strainId, ownerId],
      );

      // إذا مستخدمة → Archive بدل حذف
      if (usedRes.rows.length > 0) {
         const archived = await pool.query(
            `UPDATE queen_strains
         SET archived_at = COALESCE(archived_at, now()), updated_at = now()
         WHERE id = $1 AND owner_id = $2
         RETURNING *`,
            [strainId, ownerId],
         );

         return res.status(200).json({
            success: true,
            archived: true,
            message: "Strain is used in graft lines, so it was archived instead of deleted.",
            strain: archived.rows[0],
         });
      }

      // إذا مش مستخدمة → Delete فعلي
      const del = await pool.query(
         `DELETE FROM queen_strains
       WHERE id = $1 AND owner_id = $2
       RETURNING *`,
         [strainId, ownerId],
      );

      return res.json({ success: true, deleted: true, strain: del.rows[0] });
   } catch (err) {
      console.error("Error deleting queen strain:", err);
      return res.status(500).json({ error: "Error deleting queen strain" });
   }
});

// ---------------- GRAFT CREATION ----------------

// Body example:
// {
//    "graft_date": "2025-07-18",
//    "lines": [
//       { "strain_id": "...", "breeder_id": null, "num_strips": 4, "cells_accepted": 40 }
//    ]
// }
router.post("/grafts", async (req, res) => {
   const ownerId = req.user.id;
   const { graft_date, lines } = req.body;

   if (!graft_date || !Array.isArray(lines) || !lines.length) {
      return res.status(400).json({
         error: "graft_date and at least one line are required",
      });
   }

   const client = await pool.connect();
   try {
      await client.query("BEGIN");

      const settings = await getOrCreateQueenSettings(ownerId, client);
      const dateObj = new Date(graft_date);
      const season = getSeason(dateObj);
      const dayOfYear = getDayOfYear(dateObj);

      const graftIndex = await getNextGraftIndexForSeason(ownerId, season, client);

      // create session
      const sessionInsert = await client.query(
         `
         INSERT INTO queen_graft_sessions (
            owner_id, season, graft_date, graft_index_season, graft_day_of_year
         )
         VALUES ($1,$2,$3,$4,$5)
         RETURNING *
         `,
         [ownerId, season, graft_date, graftIndex, dayOfYear],
      );
      const session = sessionInsert.rows[0];

      const { g10, emergence, laying } = computeGraftDerivedDates(graft_date, settings);

      const createdLines = [];
      let lineIndexInSession = 0;

      // 👇 NEW: find the next LgGref for that day
      let nextLgGref = await getNextLineIndexForDay(ownerId, season, dayOfYear, client);

      for (const line of lines) {
         lineIndexInSession += 1; // purely internal, per session
         const lgGref = nextLgGref++; // 👈 this is the LgGref used in LotGref (per *day*)

         const cellsPerStrip = settings.cells_per_strip;
         const cellsGrafted = (line.num_strips || 0) * cellsPerStrip;

         const lotCode = buildLotCode(season, dayOfYear, lgGref); // 👈 now correct

         const lineInsert = await client.query(
            `
      INSERT INTO queen_graft_lines (
         session_id,
         line_index_in_session,
         strain_id,
         breeder_id,
         num_strips,
         cells_grafted,
         cells_accepted,
         lot_code,
         date_g10,
         date_emergence,
         date_laying_expected
      )
      VALUES (
         $1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11
      )
      RETURNING *
      `,
            [
               session.id,
               lineIndexInSession,
               line.strain_id,
               line.breeder_id || null,
               line.num_strips,
               cellsGrafted,
               line.cells_accepted || null,
               lotCode,
               g10,
               emergence,
               laying,
            ],
         );

         createdLines.push(lineInsert.rows[0]);
      }

      await client.query("COMMIT");

      res.status(201).json({
         session,
         lines: createdLines,
      });
   } catch (err) {
      await client.query("ROLLBACK");
      console.error("Error creating graft session:", err);
      res.status(500).json({ error: "Error creating graft session" });
   } finally {
      client.release();
   }
});

// ---------------- LIST GRAFT SESSIONS ----------------

// GET /queen/grafts
router.get("/grafts", async (req, res) => {
   const ownerId = req.user.id;

   try {
      const { rows } = await pool.query(
         `
         SELECT
            gs.*,
            COUNT(gl.id) AS lines_count,
            COALESCE(SUM(gl.cells_grafted),0) AS total_cells_grafted,
            COALESCE(SUM(gl.cells_accepted),0) AS total_cells_accepted
         FROM queen_graft_sessions gs
         LEFT JOIN queen_graft_lines gl ON gl.session_id = gs.id
         WHERE gs.owner_id = $1
         GROUP BY gs.id
         ORDER BY gs.graft_date DESC
         `,
         [ownerId],
      );

      res.json({ sessions: rows });
   } catch (err) {
      console.error("Error fetching graft sessions:", err);
      res.status(500).json({ error: "Error fetching graft sessions" });
   }
});

// GET /queen/grafts/:id
router.get("/grafts/:id", async (req, res) => {
   const ownerId = req.user.id;
   const sessionId = req.params.id;

   try {
      const sessionRes = await pool.query(
         `
         SELECT *
         FROM queen_graft_sessions
         WHERE id = $1 AND owner_id = $2
         `,
         [sessionId, ownerId],
      );

      if (!sessionRes.rows.length) {
         return res.status(404).json({ error: "Graft session not found" });
      }

      const linesRes = await pool.query(
         `
         SELECT
            gl.*,
            s.name AS strain_name,
            b.code AS breeder_code,
            b.name AS breeder_name
         FROM queen_graft_lines gl
         JOIN queen_strains s ON s.id = gl.strain_id
         LEFT JOIN queen_breeders b ON b.id = gl.breeder_id
         WHERE gl.session_id = $1
         ORDER BY gl.line_index_in_session ASC
         `,
         [sessionId],
      );

      res.json({
         session: sessionRes.rows[0],
         lines: linesRes.rows,
      });
   } catch (err) {
      console.error("Error fetching graft session details:", err);
      res.status(500).json({ error: "Error fetching graft session details" });
   }
});

// ---------------- UPDATE ONE GRAFT LINE (NbBar / NbCell) ----------------

// PUT /queen/grafts/lines/:lineId
router.put("/grafts/lines/:lineId", async (req, res) => {
   const ownerId = req.user.id;
   const lineId = req.params.lineId;
   const { num_strips, cells_accepted } = req.body;

   try {
      const { rows } = await pool.query(
         `
      UPDATE queen_graft_lines AS gl
      SET
        num_strips = COALESCE($3, gl.num_strips),
        cells_accepted = COALESCE($4, gl.cells_accepted),
        updated_at = now()
      FROM queen_graft_sessions AS gs
      WHERE gl.id = $1
        AND gl.session_id = gs.id
        AND gs.owner_id = $2
      RETURNING gl.*;
      `,
         [lineId, ownerId, num_strips, cells_accepted],
      );

      if (!rows.length) {
         return res.status(404).json({ error: "Graft line not found" });
      }

      return res.json({ line: rows[0] });
   } catch (err) {
      console.error("Error updating graft line:", err);
      return res.status(500).json({ error: "Error updating graft line" });
   }
});

// ---------------- CELLS GENERATION ----------------

// POST /queen/grafts/lines/:lineId/cells/generate
// body: { cells_count?: number }
// if not provided -> use cells_grafted from line
router.post("/grafts/lines/:lineId/cells/generate", async (req, res) => {
   const ownerId = req.user.id;
   const lineId = req.params.lineId;
   const { cells_count } = req.body || {};

   const client = await pool.connect();
   try {
      await client.query("BEGIN");

      // Load line + session (to confirm ownership and get lotCode)
      const { rows: lineRows } = await client.query(
         `
         SELECT gl.*, gs.owner_id
         FROM queen_graft_lines gl
         JOIN queen_graft_sessions gs ON gs.id = gl.session_id
         WHERE gl.id = $1 AND gs.owner_id = $2
         `,
         [lineId, ownerId],
      );

      if (!lineRows.length) {
         await client.query("ROLLBACK");
         return res.status(404).json({ error: "Graft line not found" });
      }

      const line = lineRows[0];

      // Prefer NbCell if it exists, otherwise fall back to Nb greffées
      const defaultCount = line.cells_accepted || line.cells_grafted;

      const count = cells_count && cells_count > 0 ? cells_count : defaultCount;

      const createdCells = await generateCellsForLine({
         lineId: line.id,
         lotCode: line.lot_code,
         cellsCount: count,
         client,
         buildQrPayload: defaultQrPayloadBuilder,
      });

      await client.query("COMMIT");
      res.status(201).json({ cells: createdCells });
   } catch (err) {
      await client.query("ROLLBACK");
      console.error("Error generating cells:", err);
      res.status(500).json({ error: "Error generating cells" });
   } finally {
      client.release();
   }
});

// GET /queen/grafts/lines/:lineId/cells
router.get("/grafts/lines/:lineId/cells", async (req, res) => {
   const ownerId = req.user.id;
   const lineId = req.params.lineId;

   try {
      const { rows } = await pool.query(
         `
         SELECT c.*
         FROM queen_cells c
         JOIN queen_graft_lines gl ON gl.id = c.line_id
         JOIN queen_graft_sessions gs ON gs.id = gl.session_id
         WHERE c.line_id = $1 AND gs.owner_id = $2
         ORDER BY c.cell_index ASC
         `,
         [lineId, ownerId],
      );
      res.json({ cells: rows });
   } catch (err) {
      console.error("Error fetching cells:", err);
      res.status(500).json({ error: "Error fetching cells" });
   }
});

// 🔽 ADD THIS NEW ROUTE JUST AFTER THE ONE ABOVE
//

// GET /queen/grafts/lines/:lineId/cells/labels.pdf
// GET /queen/grafts/lines/:lineId/cells/labels.pdf
// Export A4 sheet of labels (33 per page, 25x70mm) with QR code
// GET /queen/grafts/lines/:lineId/cells/labels.pdf
// Export A4 sheet of labels (33 per page, 25x70mm) with QR code
router.get("/grafts/lines/:lineId/cells/labels.pdf", async (req, res) => {
   const ownerId = req.user.id;
   const lineId = req.params.lineId;

   try {
      // Fetch all cells for this line + related info
      const { rows: cells } = await pool.query(
         `
         SELECT
            c.*,
            gl.lot_code,
            gl.date_g10,
            gl.date_laying_expected,
            gs.season,
            gs.graft_date AS graft_date,
            s.name AS strain_name,
            s.female_line,
            s.male_line,
            s.grandmother_female,
            s.grandfather_female,
            s.grandmother_male,
            s.grandfather_male,
            b.name AS breeder_name,
            b.code AS breeder_code
         FROM queen_cells c
         JOIN queen_graft_lines gl ON gl.id = c.line_id
         JOIN queen_graft_sessions gs ON gs.id = gl.session_id
         JOIN queen_strains s ON s.id = gl.strain_id
         LEFT JOIN queen_breeders b ON b.id = gl.breeder_id
         WHERE c.line_id = $1 AND gs.owner_id = $2
         ORDER BY c.cell_index ASC
         `,
         [lineId, ownerId],
      );

      if (!cells.length) {
         return res.status(404).json({ error: "No cells found for this line" });
      }

      // Helper: format dates as DD/MM
      const formatFR = (d) => {
         if (!d) return "";
         const date = new Date(d);
         if (Number.isNaN(date.getTime())) return "";
         const dd = String(date.getDate()).padStart(2, "0");
         const mm = String(date.getMonth() + 1).padStart(2, "0");
         return `${dd}/${mm}`;
      };

      // PDF setup (A4 portrait)
      const pdfDoc = await PDFDocument.create();
      const font = await pdfDoc.embedFont(StandardFonts.Helvetica);
      const fontBold = await pdfDoc.embedFont(StandardFonts.HelveticaBold);

      const pageWidth = 595.28; // A4 portrait in points
      const pageHeight = 841.89;

      // ----- GRID CONFIG ----------------------------------------------------
      const cols = 3;
      const rowsPerPage = 11;
      const labelsPerPage = cols * rowsPerPage;

      // Vertical
      const marginTop = 30;
      const labelH = 71; // ~25 mm

      // Horizontal – we compute label width to keep equal left/right margins
      const sideMargin = 10; // same on left and right
      const colGap = 5; // space between columns

      // available width for all labels (inside page margins & gaps)
      const availableWidth = pageWidth - 2 * sideMargin - (cols - 1) * colGap;
      const labelW = availableWidth / cols;

      // effective left margin used in positioning
      const marginLeft = sideMargin;

      const textColor = rgb(0, 0, 0);

      let page = pdfDoc.addPage([pageWidth, pageHeight]);

      for (let idx = 0; idx < cells.length; idx++) {
         const cell = cells[idx];

         // New page every 33 labels
         if (idx > 0 && idx % labelsPerPage === 0) {
            page = pdfDoc.addPage([pageWidth, pageHeight]);
         }

         const indexOnPage = idx % labelsPerPage;
         const row = Math.floor(indexOnPage / cols);
         const col = indexOnPage % cols;

         const x = marginLeft + col * (labelW + colGap);
         const yTop = pageHeight - marginTop - row * labelH;

         // --- Parent formatting --------------------------------------------
         const parentsCore =
            cell.female_line || cell.male_line
               ? `${cell.female_line || "?"} x ${cell.male_line || "?"}`
               : "";
         const parentsLine = parentsCore ? `[ ${parentsCore} ]` : "";

         const graftDateShort = formatFR(cell.graft_date);
         const layingShort = formatFR(cell.date_laying_expected);

         const greffText =
            graftDateShort && layingShort
               ? `Greffage : ${graftDateShort} [${layingShort}]`
               : graftDateShort
                 ? `Greffage : ${graftDateShort}`
                 : "";

         const rucherLine = `Ruchers de Cocagne - ${cell.season}`;

         // --- Label background ---------------------------------------------
         page.drawRectangle({
            x,
            y: yTop - labelH,
            width: labelW,
            height: labelH,
            color: rgb(1, 1, 1),
            borderColor: rgb(0.85, 0.85, 0.85),
            borderWidth: 0.5,
         });

         // --- Text block (left side) ---------------------------------------
         const textX = x + 8;
         let textY = yTop - 16;

         // 1) Strain name (Souche)
         page.drawText(cell.strain_name || "", {
            x: textX,
            y: textY,
            size: 12,
            font: fontBold,
            color: textColor,
         });
         textY -= 14;

         // 2) Parents line [ Z840 x Z953 ]
         if (parentsLine) {
            page.drawText(parentsLine, {
               x: textX,
               y: textY,
               size: 8,
               font,
               color: textColor,
            });
            textY -= 11;
         }

         // 3) Greffage line
         if (greffText) {
            page.drawText(greffText, {
               x: textX,
               y: textY,
               size: 8,
               font,
               color: textColor,
            });
            textY -= 11;
         }

         // 4) Rucher + season
         page.drawText(rucherLine, {
            x: textX,
            y: textY,
            size: 8,
            font,
            color: textColor,
         });

         // --- QR code (right side) -----------------------------------------
         const qrPayload =
            typeof cell.qr_payload === "string"
               ? cell.qr_payload
               : JSON.stringify(cell.qr_payload || {});

         const qrBuffer = await QRCode.toBuffer(qrPayload, {
            width: 140,
            margin: 0,
         });
         const qrImage = await pdfDoc.embedPng(qrBuffer);

         const qrSize = 50; // smaller to give more air
         // keep 10pt internal padding to the right edge of label
         const qrX = x + labelW - qrSize - 10;
         const qrY = yTop - labelH + 6;

         // 5) Breeder label above QR:  > Z841 <
         const hasCode = !!cell.breeder_code;
         const hasName = !!cell.breeder_name;
         if (hasCode || hasName) {
            let breederLabel;
            if (hasCode && hasName) {
               breederLabel = `> ${cell.breeder_code} <`;
            } else {
               breederLabel = `> ${cell.breeder_code} <`;
            }

            const breederFontSize = 7;
            const breederWidth = font.widthOfTextAtSize(breederLabel, breederFontSize);
            // center over QR
            const breederX = qrX + (qrSize - breederWidth) / 2;
            const breederY = yTop - 10;

            page.drawText(breederLabel, {
               x: breederX,
               y: breederY,
               size: breederFontSize,
               font,
               color: textColor,
            });
         }

         // draw QR
         page.drawImage(qrImage, {
            x: qrX,
            y: qrY,
            width: qrSize,
            height: qrSize,
         });
      }

      const pdfBytes = await pdfDoc.save();

      res.setHeader("Content-Type", "application/pdf");
      res.setHeader("Content-Disposition", `attachment; filename=queen_cells_labels_${lineId}.pdf`);
      return res.send(Buffer.from(pdfBytes));
   } catch (err) {
      console.error("Error generating labels PDF:", err);
      res.status(500).json({ error: "Error generating labels PDF" });
   }
});

// ---------------- BREEDERS CRUD ----------------

// GET /queen/breeders
router.get("/breeders", async (req, res) => {
   const ownerId = req.user.id;

   try {
      const { rows } = await pool.query(
         `
         SELECT *
         FROM queen_breeders
         WHERE owner_id = $1
         ORDER BY code ASC
         `,
         [ownerId],
      );
      res.json({ breeders: rows });
   } catch (err) {
      console.error("Error fetching queen breeders:", err);
      res.status(500).json({ error: "Error fetching queen breeders" });
   }
});

// POST /queen/breeders
router.post("/breeders", async (req, res) => {
   const ownerId = req.user.id;
   const { code, name } = req.body;

   if (!code) {
      return res.status(400).json({ error: "code is required" });
   }

   try {
      const { rows } = await pool.query(
         `
         INSERT INTO queen_breeders (owner_id, code, name)
         VALUES ($1, $2, $3)
         RETURNING *
         `,
         [ownerId, code, name || null],
      );

      res.status(201).json({ breeder: rows[0] });
   } catch (err) {
      console.error("Error creating queen breeder:", err);
      res.status(500).json({ error: "Error creating queen breeder" });
   }
});

// PUT /queen/breeders/:id
router.put("/breeders/:id", async (req, res) => {
   const ownerId = req.user.id;
   const breederId = req.params.id;
   const { code, name } = req.body;

   try {
      const { rows } = await pool.query(
         `
         UPDATE queen_breeders
         SET
            code = COALESCE($3, code),
            name = COALESCE($4, name),
            updated_at = NOW()
         WHERE id = $1 AND owner_id = $2
         RETURNING *
         `,
         [breederId, ownerId, code, name],
      );

      if (!rows.length) {
         return res.status(404).json({ error: "Breeder not found" });
      }

      res.json({ breeder: rows[0] });
   } catch (err) {
      console.error("Error updating queen breeder:", err);
      res.status(500).json({ error: "Error updating queen breeder" });
   }
});

// DELETE /queen/breeders/:id
router.delete("/breeders/:id", async (req, res) => {
   const ownerId = req.user.id;
   const breederId = req.params.id;

   try {
      const { rowCount } = await pool.query(
         `DELETE FROM queen_breeders WHERE id = $1 AND owner_id = $2`,
         [breederId, ownerId],
      );

      if (!rowCount) {
         return res.status(404).json({ error: "Breeder not found" });
      }

      res.json({ success: true });
   } catch (err) {
      console.error("Error deleting queen breeder:", err);
      res.status(500).json({ error: "Error deleting queen breeder" });
   }
});

// ---------------- ANALYTICS DASHBOARD ----------------
//
// GET /queen/analytics/dashboard?season=2025&days_ahead=21
//
router.get("/analytics/dashboard", async (req, res) => {
   const ownerId = req.user.id;
   const seasonParam = req.query.season ? parseInt(req.query.season, 10) : null;
   const daysAheadParam = req.query.days_ahead ? parseInt(req.query.days_ahead, 10) : 21;

   try {
      // 1️⃣ Season overview (totals)
      const overviewRes = await pool.query(
         `
         SELECT
            gs.season,
            COUNT(DISTINCT gs.id) AS grafts_count,
            COUNT(gl.id)         AS lines_count,
            COALESCE(SUM(gl.cells_grafted), 0)   AS total_cells_grafted,
            COALESCE(SUM(gl.cells_accepted), 0)  AS total_cells_accepted
         FROM queen_graft_sessions gs
         LEFT JOIN queen_graft_lines gl ON gl.session_id = gs.id
         WHERE gs.owner_id = $1
           AND ($2::int IS NULL OR gs.season = $2::int)
         GROUP BY gs.season
         ORDER BY gs.season DESC
         `,
         [ownerId, seasonParam],
      );

      let seasonOverview = null;
      if (overviewRes.rows.length > 0) {
         const row = overviewRes.rows[0];
         const accepted = Number(row.total_cells_accepted) || 0;
         const grafted = Number(row.total_cells_grafted) || 0;
         const acceptanceRate = grafted > 0 ? (accepted / grafted) * 100 : 0;

         seasonOverview = {
            season: row.season,
            grafts_count: Number(row.grafts_count),
            lines_count: Number(row.lines_count),
            total_cells_grafted: grafted,
            total_cells_accepted: accepted,
            acceptance_rate: Math.round(acceptanceRate * 10) / 10,
         };
      }

      // 2️⃣ Per graft sessions (for timeline & comparison)
      const perGraftRes = await pool.query(
         `
         SELECT
            gs.id,
            gs.graft_date,
            gs.graft_index_season,
            gs.graft_day_of_year,
            COALESCE(SUM(gl.cells_grafted), 0)   AS total_cells_grafted,
            COALESCE(SUM(gl.cells_accepted), 0)  AS total_cells_accepted
         FROM queen_graft_sessions gs
         LEFT JOIN queen_graft_lines gl ON gl.session_id = gs.id
         WHERE gs.owner_id = $1
           AND ($2::int IS NULL OR gs.season = $2::int)
         GROUP BY gs.id
         ORDER BY gs.graft_date DESC
         `,
         [ownerId, seasonParam],
      );

      const perGraft = perGraftRes.rows.map((row) => {
         const g = Number(row.total_cells_grafted) || 0;
         const a = Number(row.total_cells_accepted) || 0;
         const rate = g > 0 ? (a / g) * 100 : 0;
         return {
            session_id: row.id,
            graft_date: row.graft_date,
            graft_index_season: row.graft_index_season,
            graft_day_of_year: row.graft_day_of_year,
            total_cells_grafted: g,
            total_cells_accepted: a,
            acceptance_rate: Math.round(rate * 10) / 10,
         };
      });

      // 3️⃣ Per strain performance
      const perStrainRes = await pool.query(
         `
         SELECT
            s.id,
            s.name,
            s.season,
            COALESCE(SUM(gl.cells_grafted), 0)   AS total_cells_grafted,
            COALESCE(SUM(gl.cells_accepted), 0)  AS total_cells_accepted
         FROM queen_graft_lines gl
         JOIN queen_graft_sessions gs ON gs.id = gl.session_id
         JOIN queen_strains s ON s.id = gl.strain_id
         WHERE gs.owner_id = $1
           AND ($2::int IS NULL OR gs.season = $2::int)
         GROUP BY s.id, s.name, s.season
         ORDER BY s.season DESC, s.name ASC
         `,
         [ownerId, seasonParam],
      );

      const perStrain = perStrainRes.rows.map((row) => {
         const g = Number(row.total_cells_grafted) || 0;
         const a = Number(row.total_cells_accepted) || 0;
         const rate = g > 0 ? (a / g) * 100 : 0;
         return {
            strain_id: row.id,
            strain_name: row.name,
            season: row.season,
            total_cells_grafted: g,
            total_cells_accepted: a,
            acceptance_rate: Math.round(rate * 10) / 10,
         };
      });

      // 4️⃣ Calendar – upcoming G10 / Emergence / Laying (next X days)
      const calendarRes = await pool.query(
         `
         SELECT type, event_date, lines_count, cells_grafted, cells_accepted
         FROM (
            -- G10
            SELECT
               'G10'::text AS type,
               gl.date_g10 AS event_date,
               COUNT(*)    AS lines_count,
               COALESCE(SUM(gl.cells_grafted), 0)  AS cells_grafted,
               COALESCE(SUM(gl.cells_accepted), 0) AS cells_accepted
            FROM queen_graft_lines gl
            JOIN queen_graft_sessions gs ON gs.id = gl.session_id
            WHERE gs.owner_id = $1
              AND gl.date_g10 IS NOT NULL
              AND gl.date_g10 >= CURRENT_DATE
              AND gl.date_g10 < CURRENT_DATE + ($3::int || ' days')::interval
              AND ($2::int IS NULL OR gs.season = $2::int)
            GROUP BY gl.date_g10

            UNION ALL

            -- Emergence
            SELECT
               'emergence'::text AS type,
               gl.date_emergence AS event_date,
               COUNT(*)    AS lines_count,
               COALESCE(SUM(gl.cells_grafted), 0)  AS cells_grafted,
               COALESCE(SUM(gl.cells_accepted), 0) AS cells_accepted
            FROM queen_graft_lines gl
            JOIN queen_graft_sessions gs ON gs.id = gl.session_id
            WHERE gs.owner_id = $1
              AND gl.date_emergence IS NOT NULL
              AND gl.date_emergence >= CURRENT_DATE
              AND gl.date_emergence < CURRENT_DATE + ($3::int || ' days')::interval
              AND ($2::int IS NULL OR gs.season = $2::int)
            GROUP BY gl.date_emergence

            UNION ALL

            -- Laying
            SELECT
               'laying'::text AS type,
               gl.date_laying_expected AS event_date,
               COUNT(*)    AS lines_count,
               COALESCE(SUM(gl.cells_grafted), 0)  AS cells_grafted,
               COALESCE(SUM(gl.cells_accepted), 0) AS cells_accepted
            FROM queen_graft_lines gl
            JOIN queen_graft_sessions gs ON gs.id = gl.session_id
            WHERE gs.owner_id = $1
              AND gl.date_laying_expected IS NOT NULL
              AND gl.date_laying_expected >= CURRENT_DATE
              AND gl.date_laying_expected < CURRENT_DATE + ($3::int || ' days')::interval
              AND ($2::int IS NULL OR gs.season = $2::int)
            GROUP BY gl.date_laying_expected
         ) AS events
         ORDER BY event_date ASC, type ASC
         `,
         [ownerId, seasonParam, daysAheadParam],
      );

      const calendar = calendarRes.rows.map((row) => ({
         type: row.type, // 'G10' | 'emergence' | 'laying'
         date: row.event_date,
         lines_count: Number(row.lines_count) || 0,
         cells_grafted: Number(row.cells_grafted) || 0,
         cells_accepted: Number(row.cells_accepted) || 0,
      }));

      res.json({
         season_overview: seasonOverview,
         per_graft: perGraft,
         per_strain: perStrain,
         calendar,
      });
   } catch (err) {
      console.error("Error in /queen/analytics/dashboard:", err);
      res.status(500).json({ error: "Error generating queen analytics dashboard" });
   }
});

module.exports = router;
