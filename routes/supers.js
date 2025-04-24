// routes/supers.js
const express = require("express");
const router = express.Router();
const supabase = require("../utils/supabaseClient");
const authenticateUser = require("../middlewares/authMiddleware");
const { v4: uuidv4 } = require("uuid");

// ✅ جلب كل العاسلات للمستخدم الحالي
router.get("/", authenticateUser, async (req, res) => {
   try {
      const userId = req.user.id;
      const { data: hives, error: hivesError } = await supabase
         .from("hives")
         .select("hive_id")
         .eq("owner_user_id", userId);

      if (hivesError) throw hivesError;

      const hiveIds = hives.map((h) => h.hive_id);

      const { data, error } = await supabase.from("supers").select("*").in("hive_id", hiveIds);

      if (error) throw error;

      res.json(data);
   } catch (err) {
      console.error("Error fetching supers:", err);
      res.status(500).json({ error: "Unexpected server error" });
   }
});

// ✅ Get all supers belonging to the authenticated user
router.get("/my", authenticateUser, async (req, res) => {
   const userId = req.user.id;

   try {
      const { data, error } = await supabase.from("supers").select("*").eq("owner_user_id", userId);

      if (error) throw error;

      res.status(200).json(data);
   } catch (err) {
      console.error("❌ Error fetching user supers:", err);
      res.status(500).json({ error: "Unexpected server error" });
   }
});

// ✅ جلب عاسلة حسب ID
router.get("/:id", authenticateUser, async (req, res) => {
   try {
      const { id } = req.params;
      const { data, error } = await supabase.from("supers").select("*").eq("super_id", id).single();

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
      public_key,
   } = req.body;

   const owner_user_id = req.user.id; // ✅ المستخدم المصادق عليه

   try {
      let finalPublicKey = public_key?.trim() || null;
      let finalSuperCode = null;

      // ✅ إذا تم تمرير public_key → تحقق إذا كان مستخدم
      if (finalPublicKey) {
         const { data: existing } = await supabase
            .from("supers")
            .select("super_id")
            .eq("public_key", finalPublicKey)
            .maybeSingle();

         if (existing) {
            return res.status(400).json({ error: "Public key already used" });
         }

         const { data: available } = await supabase
            .from("available_public_keys")
            .select("code")
            .eq("public_key", finalPublicKey)
            .single();

         if (!available?.code) {
            return res.status(400).json({ error: "Public key not found in available list" });
         }

         finalSuperCode = available.code;

         // ✅ حذف المفتاح من قائمة المتاحة بعد استخدامه
         await supabase.from("available_public_keys").delete().eq("public_key", finalPublicKey);
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
            // توليد UUID كـ fallback
            finalPublicKey = uuidv4();
         }

         // توليد super_code تلقائي
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

            finalSuperCode = `${String(newPrefix).padStart(2, "0")}-${String(newSuffix).padStart(
               2,
               "0"
            )}`;
         } else {
            finalSuperCode = "01-01";
         }
      }

      // ✅ تأكد من عدم التكرار
      const { data: already } = await supabase
         .from("supers")
         .select("super_id")
         .or(`super_code.eq.${finalSuperCode},public_key.eq.${finalPublicKey}`)
         .maybeSingle();

      if (already) {
         return res.status(400).json({ error: "Super code or public key already exists" });
      }

      // ✅ الإدراج في جدول العاسلات
      const { data, error } = await supabase
         .from("supers")
         .insert([
            {
               super_code: finalSuperCode,
               super_type,
               purpose_super,
               qr_code: qr_code || `https://yourapp.com/super/${finalPublicKey}`,
               weight_empty,
               active,
               service_in,
               hive_id: hive_id || null,
               public_key: finalPublicKey,
               owner_user_id, // ✅ ربط العاسلة بالمستخدم المصادق عليه
            },
         ])
         .select("*")
         .single();

      if (error) throw error;

      console.log("✅ Super created:", {
         super_code: finalSuperCode,
         public_key: finalPublicKey,
         owner_user_id,
      });

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

// ✅ راوت جلب بيانات العاسلة من public_key + حماية
// 📡 راوت جلب بيانات العاسلة عبر public_key
router.get("/public/:public_key", authenticateUser, async (req, res) => {
   const { public_key } = req.params;
   const user_id = req.user.id;

   try {
      // 🧺 جلب بيانات العاسلة
      const { data: superData, error: superError } = await supabase
         .from("supers")
         .select("super_id, super_code, super_type, weight_empty, hive_id, public_key, created_at")
         .eq("public_key", public_key)
         .single();

      if (superError || !superData) {
         return res.status(404).json({ error: "Super not found" });
      }

      // 🐝 جلب الخلية المرتبطة بالعاسلة
      const { data: hive } = await supabase
         .from("hives")
         .select("apiary_id")
         .eq("hive_id", superData.hive_id)
         .maybeSingle();

      if (!hive?.apiary_id) {
         return res.status(404).json({ error: "Hive or apiary not found" });
      }

      // 🌿 جلب بيانات المنحل
      const { data: apiary } = await supabase
         .from("apiaries")
         .select("owner_user_id, company_id")
         .eq("apiary_id", hive.apiary_id)
         .single();

      if (!apiary) {
         return res.status(404).json({ error: "Apiary not found" });
      }

      // 🔐 تحقق من صلاحية المستخدم
      let hasAccess = false;

      if (apiary.owner_user_id === user_id) {
         hasAccess = true;
      } else if (apiary.company_id) {
         const { data: profile } = await supabase
            .from("user_profiles")
            .select("company_id")
            .eq("user_id", user_id)
            .single();

         if (profile?.company_id === apiary.company_id) {
            hasAccess = true;
         }
      }

      if (!hasAccess) {
         return res.status(403).json({ error: "Access denied" });
      }

      // 🏷️ إعداد اسم العرض
      let label = "Super Owner";

      if (apiary.company_id) {
         const { data: company } = await supabase
            .from("companies")
            .select("company_name")
            .eq("company_id", apiary.company_id)
            .single();

         label = company?.company_name || label;
      } else if (apiary.owner_user_id) {
         const { data: user } = await supabase
            .from("user_profiles")
            .select("full_name")
            .eq("user_id", apiary.owner_user_id)
            .single();

         label = user?.full_name || label;
      }

      // ✅ إرجاع البيانات
      return res.json({
         super: superData,
         label,
      });

   } catch (err) {
      console.error("❌ Error fetching super public data:", err);
      return res.status(500).json({ error: "Unexpected server error" });
   }
});


module.exports = router;
