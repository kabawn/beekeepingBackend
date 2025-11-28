// routes/hives.js
const express = require("express");
const router = express.Router();
const { v4: uuidv4 } = require("uuid");
const QRCode = require("qrcode");
const { createCanvas, loadImage } = require("@napi-rs/canvas");
const supabase = require("../utils/supabaseClient");
const authenticateUser = require("../middlewares/authMiddleware");

// 🐝 إنشاء خلية جديدة (يدوي أو بمفتاح QR موجود)
// routes/hives.js
router.post("/", authenticateUser, async (req, res) => {
   const {
      hive_type,
      hive_purpose,
      empty_weight,
      frame_capacity,
      apiary_id,
      public_key, // optional (QR)
   } = req.body;

   const userId = req.user.id; // 👈 owner of the keys / connected user

   if (!apiary_id) return res.status(400).json({ error: "apiary_id is required." });

   try {
      let finalPublicKey = public_key?.trim().toLowerCase() || uuidv4();
      let finalHiveCode;

      // If public_key provided → ensure not already used
      if (public_key) {
         // 1) Make sure this key is not already used by an existing hive
         const { data: existing } = await supabase
            .from("hives")
            .select("hive_id")
            .ilike("public_key", finalPublicKey.trim())
            .maybeSingle();

         if (existing) {
            return res.status(400).json({ error: "Public key already used" });
         }

         // 2) Fetch from available_public_keys *for THIS USER ONLY*
         const { data: availableKey, error: availableError } = await supabase
            .from("available_public_keys")
            .select("code")
            .ilike("public_key", finalPublicKey.trim())
            .eq("owner_user_id", userId)
            .single();

         if (availableError || !availableKey) {
            return res.status(400).json({
               error: "Public key not found in your available keys",
            });
         }

         finalHiveCode = availableKey.code;

         // ⚠️ We will delete this row AFTER hive insert succeeds
      } else {
         // ✅ No public_key → generate hive_code as before
         const { data: lastHives } = await supabase
            .from("hives")
            .select("hive_code")
            .eq("apiary_id", apiary_id)
            .order("hive_code", { ascending: false })
            .limit(1);

         const lastCode = lastHives?.[0]?.hive_code || `${String(apiary_id).padStart(2, "0")}-00`;
         const [prefix, lastNum] = lastCode.split("-");
         const nextNum = String(parseInt(lastNum, 10) + 1).padStart(2, "0");
         finalHiveCode = `${prefix}-${nextNum}`;
      }

      const qrCode = `https://yourapp.com/hive/${finalPublicKey}`;

      // INSERT HIVE
      const { data: hive, error } = await supabase
         .from("hives")
         .insert([
            {
               hive_code: finalHiveCode,
               hive_type,
               hive_purpose,
               empty_weight,
               frame_capacity,
               public_key: finalPublicKey,
               qr_code: qrCode,
               apiary_id,
            },
         ])
         .select()
         .single();

      if (error) return res.status(400).json({ error: error.message });

      // 🗑 If a public_key was used, delete it from available_public_keys for this user
      if (public_key) {
         await supabase
            .from("available_public_keys")
            .delete()
            .eq("public_key", finalPublicKey)
            .eq("owner_user_id", userId);
      }

      return res.status(201).json({ message: "✅ Hive created successfully", hive });
   } catch (err) {
      console.error("❌ Unexpected error in hive creation:", err);
      return res.status(500).json({ error: "Unexpected server error" });
   }
});

// 🆕 Global hive count for the logged-in user
router.get("/count/global", authenticateUser, async (req, res) => {
   const userId = req.user.id;

   try {
      const { rows } = await pool.query(
         `
      SELECT COUNT(*) AS hives
      FROM hives h
      JOIN apiaries a ON a.apiary_id = h.apiary_id
      WHERE a.owner_user_id = $1
      `,
         [userId]
      );

      const totalHives = Number(rows[0]?.hives || 0);
      res.json({ hives: totalHives });
   } catch (err) {
      console.error("Error fetching global hive count:", err);
      res.status(500).json({ error: "Failed to fetch hive count" });
   }
});

// 🖼️ تحميل صورة QR
router.get("/qr-download/:public_key", async (req, res) => {
   const { public_key } = req.params;
   try {
      const { data: hive } = await supabase
         .from("hives")
         .select("hive_code, apiary_id")
         .eq("public_key", public_key)
         .single();

      if (!hive) return res.status(404).json({ error: "Hive not found" });

      const { data: apiary } = await supabase
         .from("apiaries")
         .select("company_id, owner_user_id")
         .eq("apiary_id", hive.apiary_id)
         .single();

      let label = "Hive Owner";
      if (apiary?.company_id) {
         const { data: company } = await supabase
            .from("companies")
            .select("company_name")
            .eq("company_id", apiary.company_id)
            .single();
         label = company?.company_name || label;
      }

      const canvas = createCanvas(300, 380);
      const ctx = canvas.getContext("2d");
      ctx.fillStyle = "#fff";
      ctx.fillRect(0, 0, canvas.width, canvas.height);

      const qrUrl = `https://yourapp.com/hive/${public_key}`;
      const qrDataUrl = await QRCode.toDataURL(qrUrl);
      const qrImg = await loadImage(qrDataUrl);
      ctx.drawImage(qrImg, 25, 20, 250, 250);

      ctx.fillStyle = "#000";
      ctx.font = "bold 20px Arial";
      ctx.textAlign = "center";
      ctx.fillText(`Ruche: ${hive.hive_code}`, 150, 300);
      ctx.font = "16px Arial";
      ctx.fillText(label, 150, 340);

      const buffer = canvas.toBuffer("image/png");
      res.setHeader("Content-Disposition", `attachment; filename=hive-${public_key}.png`);
      res.setHeader("Content-Type", "image/png");
      res.send(buffer);
   } catch (error) {
      console.error(error);
      res.status(500).json({ error: "❌ Failed to generate QR image" });
   }
});

/**
 * ⚠️ ORDER MATTERS: put /by-code BEFORE /:id so /:id
 * doesn’t swallow /by-code/...
 */
// ✅ GET hive by hive_code (ORDERED BEFORE /:id)
router.get("/by-code/:code", authenticateUser, async (req, res) => {
   const { code } = req.params;
   try {
      const { data, error } = await supabase
         .from("hives")
         .select("*")
         .eq("hive_code", code)
         .single();

      if (error || !data) return res.status(404).json({ error: "Hive not found" });
      res.status(200).json(data);
   } catch (err) {
      console.error("❌ Error fetching hive by code:", err);
      res.status(500).json({ error: "Unexpected server error" });
   }
});

// ✅ PATCH hive (generic update, incl. reassign apiary)
router.patch("/:id", authenticateUser, async (req, res) => {
   const { id } = req.params;
   const patch = req.body || {};

   // Only allow fields you intend to update
   const allowed = [
      "apiary_id",
      "hive_type",
      "hive_purpose",
      "empty_weight",
      "frame_capacity",
      // add other updatable fields here
   ];
   const updatePayload = Object.fromEntries(
      Object.entries(patch).filter(([k]) => allowed.includes(k))
   );

   if (Object.keys(updatePayload).length === 0) {
      return res.status(400).json({ error: "No valid fields to update." });
   }

   try {
      const { data, error } = await supabase
         .from("hives")
         .update(updatePayload)
         .eq("hive_id", id)
         .select()
         .maybeSingle();

      if (error) return res.status(400).json({ error: error.message });
      if (!data) return res.status(404).json({ error: "Hive not found" });

      return res.status(200).json({ hive: data });
   } catch (err) {
      console.error("❌ Error updating hive:", err);
      res.status(500).json({ error: "Unexpected server error" });
   }
});

// (Optional) dedicated reassign endpoint
router.patch("/:id/reassign", authenticateUser, async (req, res) => {
   const { id } = req.params;
   const { apiary_id } = req.body;
   if (!apiary_id) return res.status(400).json({ error: "apiary_id is required." });

   try {
      const { data, error } = await supabase
         .from("hives")
         .update({ apiary_id })
         .eq("hive_id", id)
         .select()
         .maybeSingle();

      if (error) return res.status(400).json({ error: error.message });
      if (!data) return res.status(404).json({ error: "Hive not found" });

      res.status(200).json({ hive: data, message: "Hive reassigned successfully" });
   } catch (err) {
      console.error("❌ Error reassigning hive:", err);
      res.status(500).json({ error: "Unexpected server error" });
   }
});

// ✅ جلب خلية حسب ID
router.get("/:id", authenticateUser, async (req, res) => {
   const { id } = req.params;
   try {
      const { data, error } = await supabase.from("hives").select("*").eq("hive_id", id).single();

      if (error || !data) return res.status(404).json({ error: "Hive not found" });
      res.status(200).json(data);
   } catch (err) {
      console.error("Error fetching hive:", err);
      res.status(500).json({ error: "Unexpected server error while fetching hive" });
   }
});

// 🔍 Get apiary name by hive_id
router.get("/:id/apiary-name", authenticateUser, async (req, res) => {
   const { id } = req.params;
   try {
      const { data: hive, error: hiveError } = await supabase
         .from("hives")
         .select("apiary_id")
         .eq("hive_id", id)
         .single();
      if (hiveError || !hive) return res.status(404).json({ error: "Hive not found" });

      const { data: apiary, error: apiaryError } = await supabase
         .from("apiaries")
         .select("apiary_name")
         .eq("apiary_id", hive.apiary_id)
         .single();
      if (apiaryError || !apiary) return res.status(404).json({ error: "Apiary not found" });

      res.status(200).json({ apiary_name: apiary.apiary_name });
   } catch (err) {
      console.error("Error fetching apiary name:", err);
      res.status(500).json({ error: "Unexpected server error" });
   }
});

module.exports = router;
