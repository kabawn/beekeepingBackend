// routes/supers.js
const express = require("express");
const router = express.Router();
const supabase = require("../utils/supabaseClient");
const authenticateUser = require("../middlewares/authenticateUser");

// ✅ جلب كل العاسلات للمستخدم الحالي
router.get("/", authenticateUser, async (req, res) => {
   try {
      const userId = req.user.id;
      const { data: hives, error: hivesError } = await supabase
         .from("hives")
         .select("hive_id")
         .eq("owner_user_id", userId);

      if (hivesError) throw hivesError;

      const hiveIds = hives.map(h => h.hive_id);

      const { data, error } = await supabase
         .from("supers")
         .select("*")
         .in("hive_id", hiveIds);

      if (error) throw error;

      res.json(data);
   } catch (err) {
      console.error("Error fetching supers:", err);
      res.status(500).json({ error: "Unexpected server error" });
   }
});

// ✅ جلب عاسلة حسب ID
router.get("/:id", authenticateUser, async (req, res) => {
   try {
      const { id } = req.params;
      const { data, error } = await supabase
         .from("supers")
         .select("*")
         .eq("super_id", id)
         .single();

      if (error || !data) {
         return res.status(404).json({ error: "Super not found" });
      }

      res.json(data);
   } catch (err) {
      console.error("Error fetching super:", err);
      res.status(500).json({ error: "Unexpected server error" });
   }
});

// ✅ إنشاء عاسلة جديدة (QR موجود أو جديد تلقائيًا)
router.post("/", authenticateUser, async (req, res) => {
   const {
      super_code,
      super_type,
      purpose_super,
      qr_code,
      weight_empty,
      active,
      service_in,
      hive_id,
      public_key, // يمكن إرساله أو تركه فارغًا
   } = req.body;

   try {
      let finalPublicKey = public_key;
      let finalSuperCode = super_code;

      // 🟢 إذا لم يُرسل public_key → نحاول نأخذ واحد من available_public_keys
      if (!finalPublicKey) {
         const { data: keyData, error: keyError } = await supabase
            .from("available_public_keys")
            .select("public_key")
            .eq("used", false)
            .limit(1)
            .single();

         if (keyError || !keyData) {
            return res.status(400).json({ error: "No available public keys found" });
         }

         finalPublicKey = keyData.public_key;

         // ✅ حدّث المفتاح على أنه مستخدم
         await supabase
            .from("available_public_keys")
            .update({ used: true, used_for: "super" })
            .eq("public_key", finalPublicKey);

         // ✅ حساب آخر super_code لتوليد الكود التالي
         const { data: lastSuper, error: codeError } = await supabase
            .from("supers")
            .select("super_code")
            .order("super_code", { ascending: false })
            .limit(1)
            .maybeSingle();

         if (!codeError && lastSuper?.super_code) {
            const [prefix, suffix] = lastSuper.super_code.split("-").map(Number);
            let newSuffix = suffix + 1;
            let newPrefix = prefix;

            if (newSuffix > 99) {
               newSuffix = 1;
               newPrefix += 1;
            }

            finalSuperCode = `${newPrefix}-${String(newSuffix).padStart(2, "0")}`;
         } else {
            finalSuperCode = "01-01"; // fallback default
         }
      }

      // ✅ تحقق من عدم وجود تكرار
      const { data: existing, error: existingError } = await supabase
         .from("supers")
         .select("*")
         .or(`super_code.eq.${finalSuperCode},public_key.eq.${finalPublicKey}`)
         .maybeSingle();

      if (existing) {
         return res.status(400).json({ error: "Super code or public key already exists" });
      }

      const { data, error } = await supabase
         .from("supers")
         .insert([
            {
               super_code: finalSuperCode,
               super_type,
               purpose_super,
               qr_code,
               weight_empty,
               active,
               service_in,
               hive_id,
               public_key: finalPublicKey,
            },
         ])
         .select("*")
         .single();

      if (error) throw error;

      res.status(201).json(data);
   } catch (err) {
      console.error("Error creating super:", err);
      res.status(500).json({ error: "Unexpected server error" });
   }
});

// ✅ تحديث عاسلة
router.put("/:id", authenticateUser, async (req, res) => {
   const { id } = req.params;
   const updates = req.body;

   try {
      const { data, error } = await supabase
         .from("supers")
         .update(updates)
         .eq("super_id", id)
         .select("*")
         .single();

      if (error) throw error;

      res.json(data);
   } catch (err) {
      console.error("Error updating super:", err);
      res.status(500).json({ error: "Unexpected server error" });
   }
});

// ✅ حذف عاسلة
router.delete("/:id", authenticateUser, async (req, res) => {
   const { id } = req.params;

   try {
      const { data, error } = await supabase
         .from("supers")
         .delete()
         .eq("super_id", id)
         .select("*")
         .single();

      if (error) throw error;

      res.json({ message: "Super deleted successfully", super: data });
   } catch (err) {
      console.error("Error deleting super:", err);
      res.status(500).json({ error: "Unexpected server error" });
   }
});

module.exports = router;
