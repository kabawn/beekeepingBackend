// routes/availablePublicKeys.js
const express = require("express");
const router = express.Router();
const supabase = require("../utils/supabaseClient");
const authenticateUser = require("../middlewares/authMiddleware");

// ✅ جلب كل المفاتيح المتاحة أو المستخدمة حسب الحاجة
router.get("/", authenticateUser, async (req, res) => {
   try {
      const { used } = req.query;
      let query = supabase.from("available_public_keys").select("*").order("id", { ascending: true });

      if (used === "true") query = query.eq("is_used", true);
      if (used === "false") query = query.eq("is_used", false);

      const { data, error } = await query;
      if (error) throw error;

      res.json(data);
   } catch (err) {
      console.error("Error fetching available keys:", err);
      res.status(500).json({ error: "Unexpected server error" });
   }
});

// ✅ إدخال مفاتيح جديدة (يمكن إدخال دفعة)
router.post("/", authenticateUser, async (req, res) => {
   try {
      const keys = req.body.keys; // [{ public_key, code }, ...]

      if (!Array.isArray(keys) || keys.length === 0) {
         return res.status(400).json({ error: "Keys array is required" });
      }

      const { data, error } = await supabase.from("available_public_keys").insert(keys);
      if (error) throw error;

      res.status(201).json({ message: "✅ Keys inserted", data });
   } catch (err) {
      console.error("Error inserting keys:", err);
      res.status(500).json({ error: "Unexpected server error" });
   }
});

// ✅ استخدام مفتاح معين وربطه
router.patch("/:id/use", authenticateUser, async (req, res) => {
   const { id } = req.params;
   const { used_as, used_id } = req.body; // used_as: 'hive' | 'super'

   if (!used_as || !used_id) {
      return res.status(400).json({ error: "used_as and used_id are required" });
   }

   try {
      const { data, error } = await supabase
         .from("available_public_keys")
         .update({ is_used: true, used_as, used_id })
         .eq("id", id)
         .select("*")
         .single();

      if (error) throw error;

      res.json(data);
   } catch (err) {
      console.error("Error using public key:", err);
      res.status(500).json({ error: "Unexpected server error" });
   }
});

// ✅ جلب أول كود غير مستخدم
router.get("/next-code", authenticateUser, async (req, res) => {
   try {
      const { data, error } = await supabase
         .from("available_public_keys")
         .select("*")
         .eq("is_used", false)
         .order("id", { ascending: true })
         .limit(1)
         .single();

      if (error || !data) {
         return res.status(404).json({ error: "No available codes found" });
      }

      res.json(data);
   } catch (err) {
      console.error("Error fetching next code:", err);
      res.status(500).json({ error: "Unexpected server error" });
   }
});

module.exports = router;
