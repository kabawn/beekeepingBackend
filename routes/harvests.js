// routes/harvests.js
const express = require("express");
const router = express.Router();
const pool = require("../db");
const authenticateUser = require("../middlewares/authMiddleware");

// Apply auth to ALL harvest routes
router.use(authenticateUser);

/**
 * POST /api/harvests
 * Create a new harvest record (stores gross + empty + net + hive/apiary snapshot)
 * Only allowed on supers owned by the logged-in user.
 */
router.post("/", async (req, res) => {
  try {
    const userId = req.user.id;

    const {
      public_key, // preferred (from QR)
      super_id,   // alternative if you already know it
      full_weight, // gross weight in KG (from scale)
      location,   // optional
    } = req.body || {};

    // 1) Validate gross
    const gross = Number(full_weight);
    if (!Number.isFinite(gross) || gross <= 0) {
      return res.status(400).json({ error: "full_weight must be a positive number in kg" });
    }

    // 2) Resolve the super and get its tare + hive/apiary snapshot
    let resolved;

    if (public_key && String(public_key).trim()) {
      const q = await pool.query(
        `
          SELECT 
            s.super_id, 
            s.weight_empty,
            h.hive_id,
            a.apiary_id
          FROM supers s
          LEFT JOIN hives    h ON s.hive_id   = h.hive_id
          LEFT JOIN apiaries a ON h.apiary_id = a.apiary_id
          WHERE s.public_key   = $1
            AND s.owner_user_id = $2
        `,
        [String(public_key).trim(), userId]
      );
      resolved = q.rows[0];
    } else if (Number.isFinite(+super_id)) {
      const q = await pool.query(
        `
          SELECT 
            s.super_id, 
            s.weight_empty,
            h.hive_id,
            a.apiary_id
          FROM supers s
          LEFT JOIN hives    h ON s.hive_id   = h.hive_id
          LEFT JOIN apiaries a ON h.apiary_id = a.apiary_id
          WHERE s.super_id     = $1
            AND s.owner_user_id = $2
        `,
        [+super_id, userId]
      );
      resolved = q.rows[0];
    } else {
      return res.status(400).json({ error: "Provide public_key (preferred) or super_id" });
    }

    if (!resolved) {
      return res.status(404).json({ error: "Super not found for this user" });
    }

    const tare = Number(resolved.weight_empty);
    if (!Number.isFinite(tare) || tare <= 0) {
      return res.status(400).json({
        error:
          "This super has no valid empty weight (tare). Set it via super type or manual before harvesting.",
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

    // 4) Insert harvest (gross + empty + net + location + user_id + hive/apiary snapshot)
    const sql = `
      INSERT INTO harvests (
        super_id,
        full_weight,
        empty_weight_kg,
        net_honey_kg,
        location,
        harvest_date,
        user_id,
        hive_id,
        apiary_id
      ) VALUES ($1, $2, $3, $4, $5, NOW(), $6, $7, $8)
      RETURNING *;
    `;
    const params = [
      resolved.super_id,
      gross,
      tare,
      net,
      location || null,
      userId,
      resolved.hive_id || null,
      resolved.apiary_id || null,
    ];

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

/**
 * GET /api/harvests
 * All harvests for the logged-in user
 */
router.get("/", async (req, res) => {
  try {
    const userId = req.user.id;

  const sql = `
    SELECT
      h.id,
      h.super_id,
      h.full_weight::float8       AS gross_weight_kg,
      h.empty_weight_kg::float8   AS empty_weight_kg,
      h.net_honey_kg::float8      AS net_honey_kg,
      h.harvest_date,
      h.location,
      h.hive_id,
      h.apiary_id,
      a.apiary_name,          
      s.super_code,
      s.public_key
    FROM harvests h
    JOIN supers s ON s.super_id = h.super_id
    LEFT JOIN apiaries a ON a.apiary_id = h.apiary_id
    WHERE h.user_id = $1
    ORDER BY h.id DESC
  `;
    const { rows } = await pool.query(sql, [userId]);
    res.json(rows);
  } catch (error) {
    console.error("Error fetching harvests:", error);
    res.status(500).json({ error: "Server error while fetching harvests" });
  }
});

/**
 * GET /api/harvests/super-by-key/:public_key
 * Super details by key, only if owned by user
 */
router.get("/super-by-key/:public_key", async (req, res) => {
  const userId = req.user.id;
  const { public_key } = req.params;

  try {
    const result = await pool.query(
      `
        SELECT super_id AS id, super_code, public_key
        FROM supers
        WHERE public_key   = $1
          AND owner_user_id = $2
      `,
      [public_key.trim(), userId]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ error: "Super not found for this user" });
    }

    res.json(result.rows[0]);
  } catch (error) {
    console.error("Error fetching super by key:", error);
    res.status(500).json({ error: "Server error while fetching super by key" });
  }
});

/**
 * GET /api/harvests/recent?limit=50
 * Recent harvests for the logged-in user
 */
router.get("/recent", async (req, res) => {
  try {
    const userId = req.user.id;
    const limit = Math.min(Number(req.query.limit) || 50, 200);

    const sql = `
      SELECT
        h.id,
        h.super_id,
        h.full_weight::float8       AS gross_weight_kg,
        h.empty_weight_kg::float8   AS empty_weight_kg,
        h.net_honey_kg::float8      AS net_honey_kg,
        h.harvest_date,
        h.location,
        s.super_code,
        s.public_key,
        h.hive_id,
        h.apiary_id
      FROM harvests h
      JOIN supers s ON s.super_id = h.super_id
      WHERE h.user_id = $1
      ORDER BY h.harvest_date DESC
      LIMIT $2
    `;
    const { rows } = await pool.query(sql, [userId, limit]);
    res.json(rows);
  } catch (e) {
    console.error("Error fetching recent harvests:", e);
    res.status(500).json({ error: "Server error while fetching recent harvests" });
  }
});

/**
 * GET /api/harvests/super/:super_id
 * History for a given super, only if owned by user
 */
router.get("/super/:super_id", async (req, res) => {
  try {
    const userId = req.user.id;
    const superId = Number(req.params.super_id);
    if (!Number.isFinite(superId)) return res.status(400).json({ error: "Invalid super_id" });

    const sql = `
      SELECT
        h.id,
        h.full_weight::float8       AS gross_weight_kg,
        h.empty_weight_kg::float8   AS empty_weight_kg,
        h.net_honey_kg::float8      AS net_honey_kg,
        h.harvest_date,
        h.location
      FROM harvests h
      JOIN supers s ON s.super_id = h.super_id
      WHERE h.super_id = $1
        AND s.owner_user_id = $2
      ORDER BY h.harvest_date DESC
    `;
    const { rows } = await pool.query(sql, [superId, userId]);
    res.json(rows);
  } catch (e) {
    console.error("Error fetching super history:", e);
    res.status(500).json({ error: "Server error while fetching super history" });
  }
});

/**
 * GET /api/harvests/by-key/:public_key
 * History by public_key, only for its owner
 */
router.get("/by-key/:public_key", async (req, res) => {
  try {
    const userId = req.user.id;
    const publicKey = String(req.params.public_key || "").trim();
    if (!publicKey) return res.status(400).json({ error: "public_key is required" });

    const { rows: supersRows } = await pool.query(
      `
        SELECT super_id
        FROM supers
        WHERE public_key   = $1
          AND owner_user_id = $2
      `,
      [publicKey, userId]
    );
    if (supersRows.length === 0) return res.status(404).json({ error: "Super not found for this user" });

    const superId = supersRows[0].super_id;

    const { rows } = await pool.query(
      `
        SELECT
          h.id,
          h.full_weight::float8       AS gross_weight_kg,
          h.empty_weight_kg::float8   AS empty_weight_kg,
          h.net_honey_kg::float8      AS net_honey_kg,
          h.harvest_date,
          h.location
        FROM harvests h
        WHERE h.super_id = $1
          AND h.user_id = $2
        ORDER BY h.harvest_date DESC
      `,
      [superId, userId]
    );

    res.json({ super_id: superId, history: rows });
  } catch (e) {
    console.error("Error fetching history by key:", e);
    res.status(500).json({ error: "Server error while fetching history by key" });
  }
});

/**
 * GET /api/harvests/summary?from=YYYY-MM-DD&to=YYYY-MM-DD
 * Summary for logged-in user
 */
router.get("/summary", async (req, res) => {
  try {
    const userId = req.user.id;
    const from = req.query.from ? new Date(req.query.from) : null;
    const to = req.query.to ? new Date(req.query.to) : null;

    const where = ["h.user_id = $1"];
    const params = [userId];

    if (from) {
      params.push(from.toISOString());
      where.push(`h.harvest_date >= $${params.length}`);
    }
    if (to) {
      params.push(to.toISOString());
      where.push(`h.harvest_date <  $${params.length}`);
    }
    const whereSql = `WHERE ${where.join(" AND ")}`;

    const totalSql = `
      SELECT
        COALESCE(SUM(h.full_weight)::float8, 0)      AS total_gross_kg,
        COALESCE(SUM(h.empty_weight_kg)::float8, 0)  AS total_empty_kg,
        COALESCE(SUM(h.net_honey_kg)::float8, 0)     AS total_net_kg
      FROM harvests h
      ${whereSql}
    `;
    const perSuperSql = `
      SELECT
        s.super_id,
        s.super_code,
        COALESCE(SUM(h.net_honey_kg)::float8, 0) AS net_total_kg,
        COUNT(*) AS harvest_count
      FROM harvests h
      JOIN supers s ON s.super_id = h.super_id
      ${whereSql}
      GROUP BY s.super_id, s.super_code
      ORDER BY net_total_kg DESC
    `;

    const [totals, perSuper] = await Promise.all([
      pool.query(totalSql, params),
      pool.query(perSuperSql, params),
    ]);

    res.json({
      range: { from: req.query.from || null, to: req.query.to || null },
      totals: totals.rows[0],
      perSuper: perSuper.rows,
    });
  } catch (e) {
    console.error("Error building summary:", e);
    res.status(500).json({ error: "Server error while building summary" });
  }
});

/**
 * GET /api/harvests/export.csv?from=...&to=...
 * CSV export for the logged-in user only
 */
router.get("/export.csv", async (req, res) => {
  try {
    const userId = req.user.id;
    const from = req.query.from ? new Date(req.query.from) : null;
    const to = req.query.to ? new Date(req.query.to) : null;

    const where = ["h.user_id = $1"];
    const params = [userId];

    if (from) {
      params.push(from.toISOString());
      where.push(`h.harvest_date >= $${params.length}`);
    }
    if (to) {
      params.push(to.toISOString());
      where.push(`h.harvest_date <  $${params.length}`);
    }
    const whereSql = `WHERE ${where.join(" AND ")}`;

    const sql = `
      SELECT
        h.id,
        s.super_code,
        s.public_key,
        h.full_weight::float8     AS gross_weight_kg,
        h.empty_weight_kg::float8 AS empty_weight_kg,
        h.net_honey_kg::float8    AS net_honey_kg,
        h.harvest_date,
        h.location
      FROM harvests h
      JOIN supers s ON s.super_id = h.super_id
      ${whereSql}
      ORDER BY h.harvest_date DESC
    `;
    const { rows } = await pool.query(sql, params);

    const headers = [
      "id",
      "super_code",
      "public_key",
      "gross_weight_kg",
      "empty_weight_kg",
      "net_honey_kg",
      "harvest_date",
      "location",
    ];
    const csv = [
      headers.join(","),
      ...rows.map((r) =>
        [
          r.id,
          r.super_code,
          r.public_key,
          r.gross_weight_kg ?? "",
          r.empty_weight_kg ?? "",
          r.net_honey_kg ?? "",
          r.harvest_date?.toISOString ? r.harvest_date.toISOString() : r.harvest_date,
          (r.location || "").toString().replaceAll('"', '""'),
        ]
          .map((v) => (typeof v === "string" && v.includes(",") ? `"${v}"` : v))
          .join(",")
      ),
    ].join("\n");

    res.setHeader("Content-Type", "text/csv; charset=utf-8");
    res.setHeader("Content-Disposition", "attachment; filename=harvests.csv");
    res.send(csv);
  } catch (e) {
    console.error("Error exporting CSV:", e);
    res.status(500).json({ error: "Server error while exporting CSV" });
  }
});

/**
 * GET /api/harvests/series
 * Time series already user-scoped via apiaries.owner_user_id
 * Now uses hive_id/apiary_id snapshot from harvests
 */
router.get("/series", async (req, res) => {
  try {
    const userId = req.user.id;
    const from = req.query.from ? new Date(`${req.query.from}T00:00:00.000Z`) : null;
    const to = req.query.to ? new Date(`${req.query.to}T00:00:00.000Z`) : null;
    const hiveId = req.query.hive_id ? +req.query.hive_id : null;
    const apiaryId = req.query.apiary_id ? +req.query.apiary_id : null;

    const sql = `
      SELECT 
        TO_CHAR(DATE_TRUNC('day', har.harvest_date), 'YYYY-MM-DD') AS d,
        SUM(har.net_honey_kg)::float8                             AS net
      FROM harvests har
      JOIN apiaries a ON har.apiary_id = a.apiary_id
      LEFT JOIN hives h ON har.hive_id = h.hive_id
      WHERE a.owner_user_id = $1
        AND ($2::timestamptz IS NULL OR har.harvest_date >= $2)
        AND ($3::timestamptz IS NULL OR har.harvest_date <  $3)
        AND ($4::int IS NULL OR h.hive_id = $4)
        AND ($5::int IS NULL OR a.apiary_id = $5)
      GROUP BY 1
      ORDER BY 1;
    `;
    const { rows } = await pool.query(sql, [userId, from, to, hiveId, apiaryId]);
    res.json(rows);
  } catch (e) {
    console.error("Error /series:", e);
    res.status(500).json({ error: "Server error" });
  }
});

module.exports = router;
