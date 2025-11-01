// routes/harvests.js
const express = require("express");
const router = express.Router();
const pool = require("../db"); // Your PostgreSQL pool

// Create a new harvest record.
// Create a new harvest record (gross + computed net returned in response)
router.post("/", async (req, res) => {
   try {
      const {
         public_key, // preferred: scanned from the QR
         super_id, // alternative if you already know the id
         full_weight, // gross weight in KG
         location, // optional
      } = req.body || {};

      // 1) Validate gross
      const gross = Number(full_weight);
      if (!Number.isFinite(gross) || gross <= 0) {
         return res.status(400).json({ error: "full_weight must be a positive number in kg" });
      }

      // 2) Resolve the super (by public_key or super_id)
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

      const tare = Number(resolved.weight_empty); // kg from supers
      if (!Number.isFinite(tare) || tare <= 0) {
         return res.status(400).json({
            error: "This super has no valid empty weight (tare). Set it (via super type or manual) before harvesting.",
         });
      }

      // 3) Compute net
      const net = +(gross - tare).toFixed(3);
      if (net < 0) {
         return res.status(400).json({
            error: "Computed net honey is negative. Check scale reading or the empty weight.",
            details: { full_weight_kg: gross, empty_weight_kg: tare, net_honey_kg: net },
         });
      }

      // 4) Insert only your existing columns (super_id, full_weight, location)
      const ins = await pool.query(
         `insert into harvests (super_id, full_weight, location)
       values ($1, $2, $3)
       returning *`,
         [resolved.super_id, gross, location || null]
      );

      const row = ins.rows[0];

      // 5) Return computed values (not stored unless you add columns later)
      return res.status(201).json({
         message: "Harvest saved",
         harvest: row,
         computed: {
            full_weight_kg: gross,
            empty_weight_kg: tare,
            net_honey_kg: net,
         },
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

module.exports = router;
