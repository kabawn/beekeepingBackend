// utils/queenUtils.js
const pool = require("../db");

// ---------- DATE HELPERS ----------

function toDateOnly(value) {
   // Accept string or Date and always return a real Date at midnight
   const d = value instanceof Date ? value : new Date(value);
   return new Date(d.getFullYear(), d.getMonth(), d.getDate());
}

function getSeason(date) {
   const d = toDateOnly(date);
   // simple: season = calendar year (you can change later if needed)
   return d.getFullYear();
}

function getDayOfYear(date) {
   const d = toDateOnly(date);
   const start = new Date(d.getFullYear(), 0, 1);
   const diff = d - start;
   return Math.floor(diff / (1000 * 60 * 60 * 24)) + 1; // 1..365
}

// Pad int with leading zeros
function pad(num, size) {
   let s = String(num);
   while (s.length < size) s = "0" + s;
   return s;
}

async function getNextLineIndexForDay(ownerId, season, dayOfYear, client = pool) {
   const { rows } = await client.query(
      `
      SELECT gl.lot_code
      FROM queen_graft_lines gl
      JOIN queen_graft_sessions gs ON gs.id = gl.session_id
      WHERE gs.owner_id = $1
        AND gs.season = $2
        AND gs.graft_day_of_year = $3
      `,
      [ownerId, season, dayOfYear]
   );

   let maxIndex = 0;

   for (const r of rows) {
      if (!r.lot_code) continue;
      const parts = String(r.lot_code).split(".");
      const last = parseInt(parts[2], 10); // YY.DDD.LgGref
      if (!Number.isNaN(last) && last > maxIndex) {
         maxIndex = last;
      }
   }

   return maxIndex + 1; // next LgGref for that day
}

// ---------- SETTINGS HELPERS ----------

async function getOrCreateQueenSettings(ownerId, client = pool) {
   const { rows } = await client.query(`SELECT * FROM queen_settings WHERE owner_id = $1`, [
      ownerId,
   ]);

   if (rows.length > 0) return rows[0];

   const insert = await client.query(
      `
      INSERT INTO queen_settings (
         owner_id,
         cells_per_strip,
         g10_offset_days,
         emergence_offset_days,
         laying_offset_days
      )
      VALUES ($1, 14, 10, 12, 22)
      RETURNING *
      `,
      [ownerId]
   );
   return insert.rows[0];
}

// ---------- GRAFT HELPERS ----------

async function getNextGraftIndexForSeason(ownerId, season, client = pool) {
   const { rows } = await client.query(
      `
      SELECT COALESCE(MAX(graft_index_season), 0) AS max_index
      FROM queen_graft_sessions
      WHERE owner_id = $1 AND season = $2
      `,
      [ownerId, season]
   );
   return Number(rows[0].max_index) + 1;
}

function computeGraftDerivedDates(graftDate, settings) {
   const base = toDateOnly(graftDate);

   const addDays = (d, n) => new Date(d.getFullYear(), d.getMonth(), d.getDate() + n);

   const g10 = addDays(base, settings.g10_offset_days);
   const emergence = addDays(base, settings.emergence_offset_days);
   const laying = addDays(base, settings.laying_offset_days);

   return { g10, emergence, laying };
}

// LotGref = YY.DDD.LgGref
function buildLotCode(season, dayOfYear, lineIndexInSession) {
   const yy = pad(season % 100, 2);
   const ddd = pad(dayOfYear, 3);
   const line = pad(lineIndexInSession, 3);
   return `${yy}.${ddd}.${line}`;
}

// ---------- CELLS HELPERS ----------

async function generateCellsForLine({
   lineId,
   lotCode,
   cellsCount,
   client = pool,
   buildQrPayload,
}) {
   if (cellsCount <= 0) return [];

   // Load strain/pedigree for QR (optional but useful)
   const { rows: lineRows } = await client.query(
      `
      SELECT l.id,
             l.date_laying_expected,
             s.name AS strain_name,
             s.female_line,
             s.male_line,
             s.grandmother_female,
             s.grandfather_female,
             s.grandmother_male,
             s.grandfather_male,
             gs.graft_date,
             gs.season
      FROM queen_graft_lines l
      JOIN queen_strains s ON s.id = l.strain_id
      JOIN queen_graft_sessions gs ON gs.id = l.session_id
      WHERE l.id = $1
      `,
      [lineId]
   );

   if (lineRows.length === 0) {
      throw new Error("Graft line not found");
   }

   const info = lineRows[0];

   const cells = [];
   for (let i = 1; i <= cellsCount; i++) {
      const cellIndex = i;
      const fullLotNumber = `${lotCode}.${pad(cellIndex, 3)}`;

      let qrPayload = null;
      if (typeof buildQrPayload === "function") {
         qrPayload = buildQrPayload({
            cellIndex,
            fullLotNumber,
            lotCode,
            line: info,
         });
      }

      cells.push({
         line_id: lineId,
         cell_index: cellIndex,
         full_lot_number: fullLotNumber,
         qr_payload: qrPayload,
      });
   }

   const values = [];
   const params = [];
   let paramIndex = 1;

   cells.forEach((c) => {
      params.push(c.line_id, c.cell_index, c.full_lot_number, c.qr_payload);
      values.push(
         `($${paramIndex++}, $${paramIndex++}, $${paramIndex++}, $${paramIndex++}::jsonb)`
      );
   });

   const { rows } = await client.query(
      `
      INSERT INTO queen_cells (line_id, cell_index, full_lot_number, qr_payload)
      VALUES ${values.join(",")}
      ON CONFLICT (line_id, cell_index) DO NOTHING
      RETURNING *
      `,
      params
   );

   return rows;
}

// Default QR payload builder – matches what you described
function defaultQrPayloadBuilder({ cellIndex, fullLotNumber, lotCode, line }) {
   const parents = `${line.female_line || ""} x ${line.male_line || ""}`.trim();

   const gp1 = `${line.grandmother_female || ""} x ${line.grandfather_female || ""}`.trim();
   const gp2 = `${line.grandmother_male || ""} x ${line.grandfather_male || ""}`.trim();

   const grandparents = gp1 || gp2 ? `[${gp1}] x [${gp2}]` : null;

   return {
      type: "queen_cell",
      strain: line.strain_name,
      parents,
      grandparents,
      graft_date: line.graft_date,
      expected_laying: line.date_laying_expected,
      cell_lot: fullLotNumber,
      base_lot: lotCode,
      cell_index: cellIndex,
      season: line.season,
   };
}

module.exports = {
   toDateOnly,
   getSeason,
   getDayOfYear,
   getOrCreateQueenSettings,
   getNextGraftIndexForSeason,
   computeGraftDerivedDates,
   buildLotCode,
   generateCellsForLine,
   defaultQrPayloadBuilder,
   getNextLineIndexForDay, // 👈 add this
};
