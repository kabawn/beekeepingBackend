// routes/queen.js
const express = require("express");
const router = express.Router();
const pool = require("../db");
const authenticateUser = require("../middlewares/authMiddleware");

const {
   getSeason,
   getDayOfYear,
   getOrCreateQueenSettings,
   getNextGraftIndexForSeason,
   computeGraftDerivedDates,
   buildLotCode,
   generateCellsForLine,
   defaultQrPayloadBuilder,
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
         ]
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
         WHERE owner_id = $1
         ORDER BY season DESC, name ASC
         `,
         [ownerId]
      );
      res.json({ strains: rows });
   } catch (err) {
      console.error("Error fetching queen strains:", err);
      res.status(500).json({ error: "Error fetching queen strains" });
   }
});

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
            grandmother_male, grandmother_male,
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
         ]
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
         WHERE id = $1 AND owner_id = $2
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
         ]
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
      const { rowCount } = await pool.query(
         `DELETE FROM queen_strains WHERE id = $1 AND owner_id = $2`,
         [strainId, ownerId]
      );
      if (!rowCount) {
         return res.status(404).json({ error: "Strain not found" });
      }
      res.json({ success: true });
   } catch (err) {
      console.error("Error deleting queen strain:", err);
      res.status(500).json({ error: "Error deleting queen strain" });
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
         [ownerId, season, graft_date, graftIndex, dayOfYear]
      );
      const session = sessionInsert.rows[0];

      const { g10, emergence, laying } = computeGraftDerivedDates(graft_date, settings);

      const createdLines = [];
      let lineIndexInSession = 0;

      for (const line of lines) {
         lineIndexInSession += 1;

         const cellsPerStrip = settings.cells_per_strip;
         const cellsGrafted = (line.num_strips || 0) * cellsPerStrip;

         const lotCode = buildLotCode(season, dayOfYear, lineIndexInSession);

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
            ]
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
         [ownerId]
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
         [sessionId, ownerId]
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
         [sessionId]
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
         [lineId, ownerId]
      );

      if (!lineRows.length) {
         await client.query("ROLLBACK");
         return res.status(404).json({ error: "Graft line not found" });
      }

      const line = lineRows[0];
      const count = cells_count && cells_count > 0 ? cells_count : line.cells_grafted;

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
         [lineId, ownerId]
      );
      res.json({ cells: rows });
   } catch (err) {
      console.error("Error fetching cells:", err);
      res.status(500).json({ error: "Error fetching cells" });
   }
});

module.exports = router;
