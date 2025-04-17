const express = require("express");
const router = express.Router();
const supabase = require("../utils/supabaseClient");
const authenticateUser = require("../middlewares/authenticateUser");

// 📡 راوت جلب بيانات الخلية من public_key + حماية
router.get("/public/:public_key", authenticateUser, async (req, res) => {
   const { public_key } = req.params;
   const user_id = req.user.id;

   try {
      // 🐝 جلب بيانات الخلية
      const { data: hive, error: hiveError } = await supabase
         .from("hives")
         .select(`
            hive_id,
            hive_code,
            hive_type,
            hive_purpose,
            empty_weight,
            frame_capacity,
            apiary_id,
            created_at,
            public_key
         `)
         .eq("public_key", public_key)
         .single();

      if (hiveError || !hive) {
         return res.status(404).json({ error: "Hive not found" });
      }

      // 🌱 جلب بيانات المنحل المرتبط بالخلية
      const { data: apiary } = await supabase
         .from("apiaries")
         .select("apiary_name, commune, department, company_id, owner_user_id")
         .eq("apiary_id", hive.apiary_id)
         .single();

      if (!apiary) {
         return res.status(404).json({ error: "Apiary not found" });
      }

      // 🔐 تحقق من الصلاحية
      let hasAccess = false;

      // 👤 إذا كان المستخدم هو صاحب المنحل
      if (apiary.owner_user_id === user_id) {
         hasAccess = true;
      }

      // 🏢 أو إذا كان المستخدم تابع لنفس الشركة
      else if (apiary.company_id) {
         const { data: userProfile } = await supabase
            .from("user_profiles")
            .select("company_id")
            .eq("user_id", user_id)
            .single();

         if (userProfile?.company_id === apiary.company_id) {
            hasAccess = true;
         }
      }

      if (!hasAccess) {
         return res.status(403).json({ error: "Access denied" });
      }

      // 🎫 إعداد الليبل للعرض
      let label = "Hive Owner";
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

      return res.json({
         hive,
         apiary,
         label,
      });
   } catch (err) {
      console.error("❌ Server Error:", err);
      return res.status(500).json({ error: "Unexpected server error" });
   }
});

module.exports = router;
