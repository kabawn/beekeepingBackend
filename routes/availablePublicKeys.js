// routes/availablePublicKeys.js
const express = require("express");
const router = express.Router();
const supabase = require("../utils/supabaseClient");
const authenticateUser = require("../middlewares/authMiddleware");

// ✅ Get all available keys for the CURRENT user
router.get("/", authenticateUser, async (req, res) => {
   try {
      const { used } = req.query;
      const userId = req.user?.id;

      if (!userId) {
         return res.status(401).json({ error: "Missing user in request" });
      }

      let query = supabase
         .from("available_public_keys")
         .select("*")
         .eq("user_id", userId) // 👈 only this user's stock
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

// ✅ Insert new keys for CURRENT user (batch)
router.post("/", authenticateUser, async (req, res) => {
   try {
      const userId = req.user?.id;
      if (!userId) {
         return res.status(401).json({ error: "Missing user in request" });
      }

      const keys = req.body.keys; // [{ public_key, code }, ...]

      if (!Array.isArray(keys) || keys.length === 0) {
         return res.status(400).json({ error: "Keys array is required" });
      }

      // attach user_id to each key
      const payload = keys.map((k) => ({
         ...k,
         user_id: userId,
         is_used: k.is_used ?? false,
         used_as: k.used_as ?? null,
         used_id: k.used_id ?? null,
      }));

      const { data, error } = await supabase.from("available_public_keys").insert(payload);

      if (error) throw error;

      res.status(201).json({ message: "✅ Keys inserted", data });
   } catch (err) {
      console.error("Error inserting keys:", err);
      res.status(500).json({ error: "Unexpected server error" });
   }
});

// ✅ Mark a key as used (still implicitly scoped by RLS on user_id)
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

// ✅ Resolve a public key → only if it belongs to THIS user
router.get("/resolve/:public_key", authenticateUser, async (req, res) => {
   const { public_key } = req.params;
   const userId = req.user?.id;

   if (!userId) {
      return res.status(401).json({ error: "Missing user in request" });
   }

   try {
      // 1) Look in available_public_keys for THIS user
      const { data: apk, error: aErr } = await supabase
         .from("available_public_keys")
         .select("code, is_used, used_as, used_id, public_key")
         .eq("public_key", public_key)
         .eq("user_id", userId) // 👈 here is the key change
         .maybeSingle();

      if (aErr) throw aErr;

      if (apk?.code) {
         const alreadyUsed = apk.is_used === true || !!apk.used_as || apk.used_id != null;

         return res.status(200).json({
            source: "available_public_keys",
            public_key: apk.public_key,
            code: String(apk.code), // human label "44-47"
            exists: true,
            is_used: alreadyUsed,
         });
      }

      // 2) Not in this user's available keys? Maybe already a super
      // (optional: your RLS should already protect foreign data)
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
            code: String(s.super_code),
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

// ✅ Get FIRST unused code for THIS user
router.get("/next-code", authenticateUser, async (req, res) => {
   try {
      const userId = req.user?.id;
      if (!userId) {
         return res.status(401).json({ error: "Missing user in request" });
      }

      const { data, error } = await supabase
         .from("available_public_keys")
         .select("*")
         .eq("user_id", userId) // 👈 only this user's stock
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
