// routes/supers.js
const express = require("express");
const router = express.Router();
const supabase = require("../utils/supabaseClient");
const authenticateUser = require("../middlewares/authMiddleware");

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

// ✅ إنشاء عاسلة جديدة
router.post("/", authenticateUser, async (req, res) => {
  const {
     super_type,
     purpose_super,
     qr_code,
     weight_empty,
     active,
     service_in,
     hive_id,
     public_key
  } = req.body;

  try {
     let finalPublicKey = public_key?.trim() || null;
     let finalSuperCode = null;

     // ✅ إذا تم تمرير public_key
     if (finalPublicKey) {
        // تحقق هل تم استخدامه من قبل
        const { data: existing } = await supabase
           .from("supers")
           .select("super_id")
           .eq("public_key", finalPublicKey)
           .maybeSingle();

        if (existing) {
           return res.status(400).json({ error: "Public key already used" });
        }

        // جلب super_code من جدول available_public_keys
        const { data: available } = await supabase
           .from("available_public_keys")
           .select("code")
           .eq("public_key", finalPublicKey)
           .single();

        if (!available?.code) {
           return res.status(400).json({ error: "Public key not found in available list" });
        }

        finalSuperCode = available.code;

        // حذف المفتاح بعد الاستخدام
        await supabase
           .from("available_public_keys")
           .delete()
           .eq("public_key", finalPublicKey);
     }

     // ✅ إذا لم يتم تمرير public_key → توليد تلقائي
     if (!finalPublicKey || !finalSuperCode) {
        const { data: keyData } = await supabase
           .from("available_public_keys")
           .select("public_key")
           .eq("used", false)
           .is("used_for", null)
           .limit(1)
           .maybeSingle();

        if (keyData?.public_key) {
           finalPublicKey = keyData.public_key;

           await supabase
              .from("available_public_keys")
              .update({ used: true, used_for: "super" })
              .eq("public_key", finalPublicKey);
        } else {
           finalPublicKey = uuidv4();
        }

        // توليد super_code تلقائيًا
        const { data: lastSuper } = await supabase
           .from("supers")
           .select("super_code")
           .order("created_at", { ascending: false })
           .limit(1)
           .maybeSingle();

        if (lastSuper?.super_code) {
           const [prefix, suffix] = lastSuper.super_code.split("-").map(Number);
           let newSuffix = suffix + 1;
           let newPrefix = prefix;

           if (newSuffix > 99) {
              newSuffix = 1;
              newPrefix += 1;
           }

           finalSuperCode = `${String(newPrefix).padStart(2, "0")}-${String(newSuffix).padStart(2, "0")}`;
        } else {
           finalSuperCode = "01-01";
        }
     }

     // ✅ تحقق من التكرار الأخير قبل الإدراج
     const { data: already } = await supabase
        .from("supers")
        .select("super_id")
        .or(`super_code.eq.${finalSuperCode},public_key.eq.${finalPublicKey}`)
        .maybeSingle();

     if (already) {
        return res.status(400).json({ error: "Super code or public key already exists" });
     }

     // ✅ إدراج العاسلة
     const { data, error } = await supabase
        .from("supers")
        .insert([{
           super_code: finalSuperCode,
           super_type,
           purpose_super,
           qr_code: qr_code || `https://yourapp.com/super/${finalPublicKey}`,
           weight_empty,
           active,
           service_in,
           hive_id: hive_id || null,
           public_key: finalPublicKey
        }])
        .select("*")
        .single();

     if (error) throw error;

     console.log("✅ Super created:", { super_code: finalSuperCode, public_key: finalPublicKey });

     res.status(201).json(data);
  } catch (err) {
     console.error("❌ Error creating super:", err);
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
