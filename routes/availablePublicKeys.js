// routes/availablePublicKeys.js
const express = require("express");
const router = express.Router();
const supabase = require("../utils/supabaseClient");
const authenticateUser = require("../middlewares/authMiddleware");

// ✅ جلب كل المفاتيح المتاحة أو المستخدمة حسب الحاجة
router.get("/", authenticateUser, async (req, res) => {
   try {
      const { used } = req.query;
      let query = supabase
         .from("available_public_keys")
         .select("*")
         .order("id", { ascending: true });

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

// routes/availablePublicKeys.js
// routes/availablePublicKeys.js
router.get("/resolve/:public_key", authenticateUser, async (req, res) => {
  const { public_key } = req.params;

  try {
    // 1) Look in available_public_keys FIRST (we're in the "add" flow)
    const { data: apk, error: aErr } = await supabase
      .from("available_public_keys")
      .select("code, is_used, used_as, used_id")
      .eq("public_key", public_key)
      .maybeSingle();
    if (aErr) throw aErr;

    if (apk?.code) {
      const alreadyUsed = apk.is_used === true || !!apk.used_as || apk.used_id != null;
      return res.status(200).json({
        source: "available_public_keys",
        public_key,
        code: String(apk.code),   // ← the human label you want to show on scan
        exists: true,             // ← IMPORTANT: it's found, so true
        is_used: alreadyUsed,
      });
    }

    // 2) Not in available_public_keys? Maybe it already became a super
    const { data: s, error: sErr } = await supabase
      .from("supers")
      .select("super_code, public_key")
      .eq("public_key", public_key)
      .maybeSingle();
    if (sErr) throw sErr;

    if (s?.super_code) {
      return res.status(200).json({
        source: "supers",
        public_key: s.public_key,
        code: String(s.super_code), // keep the same 'code' field name for the client
        exists: true,
        is_used: true,
      });
    }

    // 3) Nothing found anywhere
    return res.status(404).json({ source: null, public_key, exists: false, is_used: false });
  } catch (err) {
    console.error("❌ /available-keys/resolve failed:", err);
    return res.status(500).json({ error: "Unexpected server error" });
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
