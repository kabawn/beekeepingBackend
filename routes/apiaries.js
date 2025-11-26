// routes/apiaries.js
const express = require("express");
const router = express.Router();
const pool = require("../db");
const authenticateUser = require("../middlewares/authMiddleware");

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

      await Promise.all(
         prodList.map((p) =>
            pool.query(
               `INSERT INTO apiary_productions (apiary_id, production_type, is_active)
                VALUES ($1, $2, TRUE)
                ON CONFLICT (apiary_id, production_type)
                DO UPDATE SET is_active = TRUE, deactivated_at = NULL`,
               [apiaryId, p]
            )
         )
      );

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
router.get("/:id/hives", authenticateUser, async (req, res) => {
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

      const result = await pool.query(
         "SELECT * FROM hives WHERE apiary_id = $1 ORDER BY hive_id ASC",
         [id]
      );
      res.json(result.rows);
   } catch (error) {
      console.error("Error fetching hives for apiary:", error);
      res.status(500).json({ error: "Server error while fetching hives for apiary" });
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

         // insert new active ones
         await Promise.all(
            prodList.map((p) =>
               pool.query(
                  `INSERT INTO apiary_productions (apiary_id, production_type, is_active)
                   VALUES ($1, $2, TRUE)
                   ON CONFLICT (apiary_id, production_type)
                   DO UPDATE SET is_active = TRUE, deactivated_at = NULL`,
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

