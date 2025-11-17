const express = require("express");
const router = express.Router();
const pool = require("../db");
const supabase = require("../utils/supabaseClient");
const authenticateUser = require("../middlewares/authMiddleware");

// إنشاء منحل جديد
router.post("/", authenticateUser, async (req, res) => {
   const userId = req.user.id;
   const { apiary_name, location, commune, department, land_owner_name, phone } = req.body;

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

      // إنشاء المنحل
      const insertResult = await pool.query(
         `INSERT INTO apiaries (apiary_name, location, commune, department, land_owner_name, phone, owner_user_id)
         VALUES ($1, $2, $3, $4, $5, $6, $7)
         RETURNING *`,
         [apiary_name, location, commune, department, land_owner_name, phone, userId]
      );

      return res.status(201).json({ apiary: insertResult.rows[0] });
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
      const result = await pool.query(
         "SELECT * FROM apiaries WHERE owner_user_id = $1 ORDER BY apiary_id ASC",
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
      const result = await pool.query("SELECT * FROM apiaries WHERE apiary_id = $1", [id]);
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
// ✅ تحديث منحل
router.put("/:id", authenticateUser, async (req, res) => {
   const { id } = req.params;
   const userId = req.user.id;

   const {
      apiary_name,
      location, // "lat,lng" نفس ما تخزّنها في الـ POST
      commune,
      department,
      land_owner_name,
      phone,
   } = req.body;

   try {
      const result = await pool.query(
         `UPDATE apiaries
          SET apiary_name = $1,
              location = $2,
              commune = $3,
              department = $4,
              land_owner_name = $5,
              phone = $6
          WHERE apiary_id = $7
          AND owner_user_id = $8
          RETURNING *`,
         [apiary_name, location, commune, department, land_owner_name, phone, id, userId]
      );

      if (result.rows.length === 0) {
         return res.status(404).json({ error: "Apiary not found" });
      }

      // خليه نفس ستايل الـ POST
      res.json({ apiary: result.rows[0] });
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
