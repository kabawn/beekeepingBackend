const express = require("express");
const router = express.Router();
const pool = require("../db");
const supabase = require("../utils/supabaseClient");
const authenticateUser = require("../middlewares/authMiddleware");

// إنشاء منحل جديد
router.post("/", authenticateUser, async (req, res) => {
   const userId = req.user.id;

   // ✅ accept main_production from the body (optional)
   const {
      apiary_name,
      location,
      commune,
      department,
      land_owner_name,
      phone,
      main_production, // <-- NEW
   } = req.body;

   try {
      // جلب نوع اشتراك المستخدم
      const subResult = await pool.query(
         "SELECT plan_type FROM subscriptions WHERE user_id = $1 LIMIT 1",
         [userId]
      );

      const planType = subResult.rows[0]?.plan_type || "free";

      // إذا كان الاشتراك free، نتحقق من عدد المناحل
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

      // ✅ insert main_production (default 'honey' if not provided)
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
         [
            apiary_name,
            location,
            commune,
            department,
            land_owner_name,
            phone,
            userId,
            main_production || "honey",
         ]
      );

      const apiary = insertResult.rows[0];

      // ✅ NEW: ensure default production is active in apiary_productions
      try {
         await pool.query(
            `INSERT INTO apiary_productions (apiary_id, production_type)
             VALUES ($1, $2)
             ON CONFLICT DO NOTHING`,
            [apiary.apiary_id, apiary.main_production || "honey"]
         );
      } catch (e) {
         console.error("Error inserting default production for apiary:", e);
         // we don't fail the whole request for this
      }

      return res.status(201).json({ apiary });
   } catch (error) {
      console.error("Error creating apiary:", error);
      return res.status(500).json({ error: "Server error while creating apiary" });
   }
});

// ✅ عدد الخلايا في منحل معين
router.get("/:id/hives/count", async (req, res) => {
   const { id } = req.params;
   try {
      const result = await pool.query("SELECT COUNT(*) AS count FROM hives WHERE apiary_id = $1", [
         id,
      ]);
      res.json({ count: parseInt(result.rows[0].count, 10) });
   } catch (error) {
      console.error("Error fetching hive count:", error);
      res.status(500).json({ error: "Server error while fetching hive count" });
   }
});

// ✅ GET apiaries for the authenticated user only
router.get("/", authenticateUser, async (req, res) => {
   try {
      const userId = req.user.id;

      // ✅ UPDATED: join with apiary_productions and aggregate list of active productions
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

// ✅ خلايا منحل معين
router.get("/:id/hives", async (req, res) => {
   const { id } = req.params;
   try {
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

// ✅ منحل واحد حسب ID
router.get("/:id", async (req, res) => {
   const { id } = req.params;
   try {
      // ✅ UPDATED: also return the list of active productions for that apiary
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
         GROUP BY a.apiary_id
         `,
         [id]
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

// ✅ تحديث منحل
router.put("/:id", authenticateUser, async (req, res) => {
   const { id } = req.params;
   const userId = req.user.id;

   // ✅ accept main_production from body here as well
   const {
      apiary_name,
      location, // "lat,lng" نفس ما تخزّنها في الـ POST
      commune,
      department,
      land_owner_name,
      phone,
      main_production,
   } = req.body;

   try {
      // ✅ update apiary + main_production
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
         [
            apiary_name,
            location,
            commune,
            department,
            land_owner_name,
            phone,
            main_production || "honey",
            id,
            userId,
         ]
      );

      if (result.rows.length === 0) {
         return res.status(404).json({ error: "Apiary not found" });
      }

      const apiary = result.rows[0];

      // ✅ OPTIONAL: sync apiary_productions with new main_production (only honey/swarm later if you want)
      try {
         await pool.query(
            `INSERT INTO apiary_productions (apiary_id, production_type, is_active)
             VALUES ($1, $2, TRUE)
             ON CONFLICT (apiary_id, production_type)
             DO UPDATE SET is_active = TRUE, deactivated_at = NULL`,
            [apiary.apiary_id, apiary.main_production || "honey"]
         );
      } catch (e) {
         console.error("Error syncing main_production with apiary_productions:", e);
      }

      res.json({ apiary });
   } catch (error) {
      console.error("Error updating apiary:", error);
      res.status(500).json({ error: "Server error while updating apiary" });
   }
});

// ✅ حذف منحل
router.delete("/:id", async (req, res) => {
   const { id } = req.params;
   try {
      const result = await pool.query("DELETE FROM apiaries WHERE apiary_id = $1 RETURNING *", [
         id,
      ]);
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
