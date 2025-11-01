// routes/harvests.js
const express = require("express");
const router = express.Router();
const pool = require("../db"); // Your PostgreSQL pool
const authenticateUser = require("../middlewares/authMiddleware");
 router.use(authenticateUser); // apply to all harvest routes
// Create a new harvest record (stores gross + empty + net)
router.post("/", async (req, res) => {
   try {
      const {
         public_key, // preferred (from QR)
         super_id, // alternative if you already know it
         full_weight, // gross weight in KG (from scale)
         location, // optional
      } = req.body || {};

      // 1) Validate gross
      const gross = Number(full_weight);
      if (!Number.isFinite(gross) || gross <= 0) {
         return res.status(400).json({ error: "full_weight must be a positive number in kg" });
      }

      // 2) Resolve the super and get its tare (empty weight in kg)
      let resolved;
      if (public_key && String(public_key).trim()) {
         const q = await pool.query(
            `select super_id, weight_empty
           from supers
          where public_key = $1`,
            [String(public_key).trim()]
         );
         resolved = q.rows[0];
      } else if (Number.isFinite(+super_id)) {
         const q = await pool.query(
            `select super_id, weight_empty
           from supers
          where super_id = $1`,
            [+super_id]
         );
         resolved = q.rows[0];
      } else {
         return res.status(400).json({ error: "Provide public_key (preferred) or super_id" });
      }

      if (!resolved) {
         return res.status(404).json({ error: "Super not found" });
      }

      const tare = Number(resolved.weight_empty); // KG from supers table
      if (!Number.isFinite(tare) || tare <= 0) {
         return res.status(400).json({
            error: "This super has no valid empty weight (tare). Set it via super type or manual before harvesting.",
         });
      }

      // 3) Compute net = gross - tare
      const net = +(gross - tare).toFixed(3);
      if (net < 0) {
         return res.status(400).json({
            error: "Computed net honey is negative. Check scale reading or empty weight.",
            details: { full_weight_kg: gross, empty_weight_kg: tare, net_honey_kg: net },
         });
      }

      // 4) Insert gross + empty + net (plus location)
      const sql = `
      insert into harvests (
        super_id,
        full_weight,        -- gross (kg)
        empty_weight_kg,    -- snapshot tare (kg)
        net_honey_kg,       -- net (kg)
        location,
        harvest_date
      ) values ($1, $2, $3, $4, $5, now())
      returning *;
    `;
      const params = [resolved.super_id, gross, tare, net, location || null];

      const result = await pool.query(sql, params);
      const row = result.rows[0];

      return res.status(201).json({
         message: "Harvest saved",
         harvest: row,
      });
   } catch (error) {
      console.error("Error creating harvest:", error);
      res.status(500).json({ error: "Server error while creating harvest" });
   }
});

// Get all harvest records (optional – you may extend with filtering by hive or apiary).
router.get("/", async (req, res) => {
   try {
      const result = await pool.query("SELECT * FROM harvests ORDER BY id DESC");
      res.json(result.rows);
   } catch (error) {
      console.error("Error fetching harvests:", error);
      res.status(500).json({ error: "Server error while fetching harvests" });
   }
});

// Get super details by public_key (used after scanning QR)
router.get("/super-by-key/:public_key", async (req, res) => {
   const { public_key } = req.params;

   try {
      const result = await pool.query(
         `SELECT super_id AS id, super_code, public_key FROM supers WHERE public_key = $1`,
         [public_key.trim()]
      );

      if (result.rows.length === 0) {
         return res.status(404).json({ error: "Super not found" });
      }

      res.json(result.rows[0]);
   } catch (error) {
      console.error("Error fetching super by key:", error);
      res.status(500).json({ error: "Server error while fetching super by key" });
   }
});

// GET /api/harvests/recent?limit=50
router.get("/recent", async (req, res) => {
   try {
      const limit = Math.min(Number(req.query.limit) || 50, 200);
      const sql = `
      select
        h.id,
        h.super_id,
        h.full_weight::float8       as gross_weight_kg,
        h.empty_weight_kg::float8   as empty_weight_kg,
        h.net_honey_kg::float8      as net_honey_kg,
        h.harvest_date,
        h.location,
        s.super_code,
        s.public_key
      from harvests h
      join supers s on s.super_id = h.super_id
      order by h.harvest_date desc
      limit $1
    `;
      const { rows } = await pool.query(sql, [limit]);
      res.json(rows);
   } catch (e) {
      console.error("Error fetching recent harvests:", e);
      res.status(500).json({ error: "Server error while fetching recent harvests" });
   }
});


// GET /api/harvests/super/5
router.get("/super/:super_id", async (req, res) => {
  try {
    const superId = Number(req.params.super_id);
    if (!Number.isFinite(superId)) return res.status(400).json({ error: "Invalid super_id" });

    const sql = `
      select
        h.id,
        h.full_weight::float8       as gross_weight_kg,
        h.empty_weight_kg::float8   as empty_weight_kg,
        h.net_honey_kg::float8      as net_honey_kg,
        h.harvest_date,
        h.location
      from harvests h
      where h.super_id = $1
      order by h.harvest_date desc
    `;
    const { rows } = await pool.query(sql, [superId]);
    res.json(rows);
  } catch (e) {
    console.error("Error fetching super history:", e);
    res.status(500).json({ error: "Server error while fetching super history" });
  }
});


// GET /api/harvests/by-key/:public_key
router.get("/by-key/:public_key", async (req, res) => {
  try {
    const publicKey = String(req.params.public_key || "").trim();
    if (!publicKey) return res.status(400).json({ error: "public_key is required" });

    const { rows: supersRows } = await pool.query(
      `select super_id from supers where public_key = $1`,
      [publicKey]
    );
    if (supersRows.length === 0) return res.status(404).json({ error: "Super not found" });

    const superId = supersRows[0].super_id;

    const { rows } = await pool.query(
      `select
         h.id,
         h.full_weight::float8       as gross_weight_kg,
         h.empty_weight_kg::float8   as empty_weight_kg,
         h.net_honey_kg::float8      as net_honey_kg,
         h.harvest_date,
         h.location
       from harvests h
       where h.super_id = $1
       order by h.harvest_date desc`,
      [superId]
    );

    res.json({ super_id: superId, history: rows });
  } catch (e) {
    console.error("Error fetching history by key:", e);
    res.status(500).json({ error: "Server error while fetching history by key" });
  }
});



// GET /api/harvests/summary?from=2025-11-01&to=2025-11-30
router.get("/summary", async (req, res) => {
  try {
    const from = req.query.from ? new Date(req.query.from) : null;
    const to   = req.query.to   ? new Date(req.query.to)   : null;

    const where = [];
    const params = [];
    if (from) { params.push(from.toISOString()); where.push(`h.harvest_date >= $${params.length}`); }
    if (to)   { params.push(to.toISOString());   where.push(`h.harvest_date <  $${params.length}`); }
    const whereSql = where.length ? `where ${where.join(" and ")}` : "";

    const totalSql = `
      select
        coalesce(sum(h.full_weight)::float8, 0)      as total_gross_kg,
        coalesce(sum(h.empty_weight_kg)::float8, 0)  as total_empty_kg,
        coalesce(sum(h.net_honey_kg)::float8, 0)     as total_net_kg
      from harvests h
      ${whereSql}
    `;
    const perSuperSql = `
      select
        s.super_id,
        s.super_code,
        coalesce(sum(h.net_honey_kg)::float8, 0) as net_total_kg,
        count(*) as harvest_count
      from harvests h
      join supers s on s.super_id = h.super_id
      ${whereSql}
      group by s.super_id, s.super_code
      order by net_total_kg desc
    `;

    const [totals, perSuper] = await Promise.all([
      pool.query(totalSql, params),
      pool.query(perSuperSql, params),
    ]);

    res.json({ range: { from: req.query.from || null, to: req.query.to || null }, totals: totals.rows[0], perSuper: perSuper.rows });
  } catch (e) {
    console.error("Error building summary:", e);
    res.status(500).json({ error: "Server error while building summary" });
  }
});


// GET /api/harvests/export.csv?from=...&to=...
router.get("/export.csv", async (req, res) => {
  try {
    const from = req.query.from ? new Date(req.query.from) : null;
    const to   = req.query.to   ? new Date(req.query.to)   : null;

    const where = [];
    const params = [];
    if (from) { params.push(from.toISOString()); where.push(`h.harvest_date >= $${params.length}`); }
    if (to)   { params.push(to.toISOString());   where.push(`h.harvest_date <  $${params.length}`); }
    const whereSql = where.length ? `where ${where.join(" and ")}` : "";

    const sql = `
      select
        h.id,
        s.super_code,
        s.public_key,
        h.full_weight::float8     as gross_weight_kg,
        h.empty_weight_kg::float8 as empty_weight_kg,
        h.net_honey_kg::float8    as net_honey_kg,
        h.harvest_date,
        h.location
      from harvests h
      join supers s on s.super_id = h.super_id
      ${whereSql}
      order by h.harvest_date desc
    `;
    const { rows } = await pool.query(sql, params);

    // Build CSV
    const headers = ["id","super_code","public_key","gross_weight_kg","empty_weight_kg","net_honey_kg","harvest_date","location"];
    const csv = [
      headers.join(","),
      ...rows.map(r =>
        [
          r.id,
          r.super_code,
          r.public_key,
          r.gross_weight_kg ?? "",
          r.empty_weight_kg ?? "",
          r.net_honey_kg ?? "",
          r.harvest_date?.toISOString ? r.harvest_date.toISOString() : r.harvest_date,
          (r.location || "").toString().replaceAll('"','""')
        ].map(v => typeof v === "string" && v.includes(",") ? `"${v}"` : v).join(",")
      )
    ].join("\n");

    res.setHeader("Content-Type", "text/csv; charset=utf-8");
    res.setHeader("Content-Disposition", "attachment; filename=harvests.csv");
    res.send(csv);
  } catch (e) {
    console.error("Error exporting CSV:", e);
    res.status(500).json({ error: "Server error while exporting CSV" });
  }
});


module.exports = router;
