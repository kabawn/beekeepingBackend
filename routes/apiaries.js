const express = require("express");
const router = express.Router();
const pool = require("../db");
const supabase = require("../utils/supabaseClient");
const authenticateUser = require("../middlewares/authMiddleware");

/**
 * 🐝 POST /apiaries
 * إنشاء منحل جديد (مع main_production + قائمة productions اختياري)
 */
router.post("/", authenticateUser, async (req, res) => {
   const userId = req.user.id;

   // ✅ نقبل main_production + productions (اختياري)
   const {
      apiary_name,
      location,
      commune,
      department,
      land_owner_name,
      phone,
      main_production, // قيمة واحدة رئيسية
      productions, // 👈 NEW: array of production types (honey, swarm, queen_rearing, ...)
   } = req.body;

   const safeMainProduction = main_production || "honey";

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

      // ✅ نضيف المنحل مع main_production
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
            safeMainProduction,
         ]
      );

      const apiary = insertResult.rows[0];

      // ✅ نبني ليست نهائية لأنواع الإنتاج:
      // - دايمًا نحط main_production
      // - لو فيه productions من الجسم ندمجها
      const prodListRaw = Array.isArray(productions) ? productions : [];
      const allProductions = [safeMainProduction, ...prodListRaw]
         .map((p) => String(p).trim())
         .filter((p) => p.length > 0);

      // نحذف التكرارات
      const uniqueProductions = [...new Set(allProductions)];

      // ✅ نضيف كل نوع إنتاج في apiary_productions
      try {
         for (const pType of uniqueProductions) {
            await pool.query(
               `INSERT INTO apiary_productions (apiary_id, production_type)
                VALUES ($1, $2)
                ON CONFLICT DO NOTHING`,
               [apiary.apiary_id, pType]
            );
         }
      } catch (e) {
         console.error("Error inserting productions for apiary:", e);
         // ما نطيحوش الطلب كامل على خاطر هذي
      }

      return res.status(201).json({ apiary });
   } catch (error) {
      console.error("Error creating apiary:", error);
      return res.status(500).json({ error: "Server error while creating apiary" });
   }
});

/**
 * ✅ عدد الخلايا في منحل معين
 */
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

/**
 * ✅ GET /apiaries
 * كل المناحل لمستخدم معيّن + قائمة productions النشيطة لكل منحل
 */
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

/**
 * ✅ خلايا منحل معين
 */
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

/**
 * ✅ منحل واحد حسب ID + productions
 */
router.get("/:id", async (req, res) => {
   const { id } = req.params;
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

/**
 * ✅ PUT /apiaries/:id
 * تحديث منحل (مع main_production + إمكانية تعديل قائمة productions)
 *
 * لو تبعت productions (array) → نعتبرها "الحقيقة" ونزامن الجدول apiary_productions معها.
 * لو ما تبعتش productions → نحدّث غير main_production ونخلي الباقي كما هو.
 */
router.put("/:id", authenticateUser, async (req, res) => {
   const { id } = req.params;
   const userId = req.user.id;

   const {
      apiary_name,
      location, // "lat,lng" نفس ما تخزنها في الـ POST
      commune,
      department,
      land_owner_name,
      phone,
      main_production,
      productions, // 👈 NEW: نقدر نحدّث بها لائحة الإنتاج
   } = req.body;

   const safeMainProduction = main_production || "honey";

   try {
      // ✅ نحدّث المنحل + main_production
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
            safeMainProduction,
            id,
            userId,
         ]
      );

      if (result.rows.length === 0) {
         return res.status(404).json({ error: "Apiary not found" });
      }

      const apiary = result.rows[0];

      // ✅ نبني الليست النهائية لأنواع الإنتاج
      const prodListRaw = Array.isArray(productions) ? productions : [];
      const allProductions = [safeMainProduction, ...prodListRaw]
         .map((p) => String(p).trim())
         .filter((p) => p.length > 0);
      const uniqueProductions = [...new Set(allProductions)];

      try {
         // لو المستخدم بعث productions → نزامن الجدول apiary_productions
         if (Array.isArray(productions)) {
            // 1) نعطّل كل الأنواع اللي مش موجودة في uniqueProductions
            await pool.query(
               `UPDATE apiary_productions
                SET is_active = FALSE,
                    deactivated_at = NOW()
                WHERE apiary_id = $1
                AND production_type <> ALL($2::text[])`,
               [apiary.apiary_id, uniqueProductions]
            );
         }

         // 2) نفعّل/نضيف كل الأنواع الموجودة في uniqueProductions
         for (const pType of uniqueProductions) {
            await pool.query(
               `INSERT INTO apiary_productions (apiary_id, production_type, is_active)
                VALUES ($1, $2, TRUE)
                ON CONFLICT (apiary_id, production_type)
                DO UPDATE SET is_active = TRUE, deactivated_at = NULL`,
               [apiary.apiary_id, pType]
            );
         }
      } catch (e) {
         console.error("Error syncing productions for apiary:", e);
         // ما نوقفوش الطلب الرئيسي
      }

      res.json({ apiary });
   } catch (error) {
      console.error("Error updating apiary:", error);
      res.status(500).json({ error: "Server error while updating apiary" });
   }
});

/**
 * ✅ حذف منحل
 * (نفس اللي كان عندك، ما لمسناه باش ما نخربش أي شي في الفرونت)
 */
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
