// routes/hives.js
const express = require("express");
const router = express.Router();
const { v4: uuidv4 } = require("uuid");
const QRCode = require("qrcode");
const { createCanvas, loadImage } = require("@napi-rs/canvas");
const supabase = require("../utils/supabaseClient");
const authenticateUser = require("../middlewares/authMiddleware");

/**
 * -----------------------------
 * ✅ Helpers: Authorization
 * -----------------------------
 */

// ✅ Ensure apiary belongs to current user
async function assertApiaryOwnership(apiaryId, userId) {
   const { data, error } = await supabase
      .from("apiaries")
      .select("apiary_id, owner_user_id")
      .eq("apiary_id", apiaryId)
      .eq("owner_user_id", userId)
      .maybeSingle();

   if (error) return { ok: false, error: error.message };
   if (!data) return { ok: false, error: "Forbidden" };
   return { ok: true, apiary: data };
}

// ✅ Get hive only if it belongs to current user (via apiary owner)
async function getHiveIfOwnedByUser(hiveId, userId, select = "*") {
   const { data, error } = await supabase
      .from("hives")
      .select(
         `
         ${select},
         apiaries!inner(owner_user_id, apiary_name, company_id)
       `
      )
      .eq("hive_id", hiveId)
      .eq("apiaries.owner_user_id", userId)
      .maybeSingle();

   if (error) return { ok: false, error: error.message };
   if (!data) return { ok: false, error: "Hive not found" };
   return { ok: true, hive: data };
}

// ✅ Get hive by code only if owned
async function getHiveByCodeIfOwned(code, userId, select = "*") {
   const { data, error } = await supabase
      .from("hives")
      .select(
         `
         ${select},
         apiaries!inner(owner_user_id, apiary_name, company_id)
       `
      )
      .eq("hive_code", code)
      .eq("apiaries.owner_user_id", userId)
      .maybeSingle();

   if (error) return { ok: false, error: error.message };
   if (!data) return { ok: false, error: "Hive not found" };
   return { ok: true, hive: data };
}

// ✅ Get hive by public_key only if owned
async function getHiveByPublicKeyIfOwned(
   publicKey,
   userId,
   select = "hive_code, apiary_id, public_key"
) {
   const { data, error } = await supabase
      .from("hives")
      .select(
         `
         ${select},
         apiaries!inner(owner_user_id, apiary_name, company_id)
       `
      )
      .eq("public_key", publicKey)
      .eq("apiaries.owner_user_id", userId)
      .maybeSingle();

   if (error) return { ok: false, error: error.message };
   if (!data) return { ok: false, error: "Hive not found" };
   return { ok: true, hive: data };
}

/**
 * -----------------------------
 * ✅ POST /hives
 * Create hive (manual OR from available_public_keys)
 * -----------------------------
 */
router.post("/", authenticateUser, async (req, res) => {
   const {
      hive_type,
      hive_purpose,
      empty_weight,
      frame_capacity,
      apiary_id,
      public_key, // optional (QR)
   } = req.body;

   const userId = req.user.id;

   if (!apiary_id) return res.status(400).json({ error: "apiary_id is required." });

   try {
      // ✅ 0) Ensure apiary belongs to this user
      const ownApiary = await assertApiaryOwnership(apiary_id, userId);
      if (!ownApiary.ok) return res.status(403).json({ error: "Forbidden: apiary not yours" });

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
      } else {
         // ✅ No public_key → generate hive_code as before (per apiary)
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

/**
 * -----------------------------
 * ✅ GET /hives/count/global
 * Count all hives for logged user
 * -----------------------------
 */
router.get("/count/global", authenticateUser, async (req, res) => {
   const userId = req.user.id;

   try {
      const { data: apiaries, error: apiaryError } = await supabase
         .from("apiaries")
         .select("apiary_id")
         .eq("owner_user_id", userId);

      if (apiaryError) {
         console.error("Error fetching user apiaries:", apiaryError);
         return res.status(500).json({ error: "Failed to fetch apiaries" });
      }

      if (!apiaries || apiaries.length === 0) {
         return res.json({ hives: 0 });
      }

      const apiaryIds = apiaries.map((a) => a.apiary_id);

      const { count, error: hiveError } = await supabase
         .from("hives")
         .select("hive_id", { count: "exact", head: true })
         .in("apiary_id", apiaryIds);

      if (hiveError) {
         console.error("Error counting hives:", hiveError);
         return res.status(500).json({ error: "Failed to count hives" });
      }

      return res.json({ hives: count || 0 });
   } catch (err) {
      console.error("Unexpected error in /hives/count/global:", err);
      return res.status(500).json({ error: "Unexpected server error" });
   }
});

/**
 * -----------------------------
 * ✅ GET /hives/qr-download/:public_key
 * 🔒 Protected + ownership check
 * -----------------------------
 */
router.get("/qr-download/:public_key", authenticateUser, async (req, res) => {
   const { public_key } = req.params;
   const userId = req.user.id;

   try {
      // ✅ Only allow if hive belongs to this user
      const owned = await getHiveByPublicKeyIfOwned(
         public_key,
         userId,
         "hive_code, apiary_id, public_key"
      );
      if (!owned.ok) {
         // return 404 to avoid leaking existence
         return res.status(404).json({ error: "Hive not found" });
      }

      const hive = owned.hive;

      // label: company name if exists
      let label = "Hive Owner";
      if (hive.apiaries?.company_id) {
         const { data: company } = await supabase
            .from("companies")
            .select("company_name")
            .eq("company_id", hive.apiaries.company_id)
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
 * ⚠️ ORDER MATTERS: put /by-code BEFORE /:id
 */

// ✅ GET hive by hive_code (🔒 ownership protected)
router.get("/by-code/:code", authenticateUser, async (req, res) => {
   const { code } = req.params;
   const userId = req.user.id;

   try {
      const owned = await getHiveByCodeIfOwned(code, userId, "*");
      if (!owned.ok) return res.status(404).json({ error: "Hive not found" });

      // remove join object if you don't want it in response:
      const { apiaries, ...cleanHive } = owned.hive;
      return res.status(200).json(cleanHive);
   } catch (err) {
      console.error("❌ Error fetching hive by code:", err);
      res.status(500).json({ error: "Unexpected server error" });
   }
});

// ✅ PATCH hive (🔒 ownership protected)
router.patch("/:id", authenticateUser, async (req, res) => {
   const { id } = req.params;
   const userId = req.user.id;
   const patch = req.body || {};

   const allowed = ["apiary_id", "hive_type", "hive_purpose", "empty_weight", "frame_capacity"];
   const updatePayload = Object.fromEntries(
      Object.entries(patch).filter(([k]) => allowed.includes(k))
   );

   if (Object.keys(updatePayload).length === 0) {
      return res.status(400).json({ error: "No valid fields to update." });
   }

   try {
      // ✅ 1) ensure hive belongs to user
      const owned = await getHiveIfOwnedByUser(id, userId, "hive_id, apiary_id");
      if (!owned.ok) return res.status(404).json({ error: "Hive not found" });

      // ✅ 2) if apiary_id is being changed, ensure NEW apiary is owned too
      if (updatePayload.apiary_id) {
         const ownApiary = await assertApiaryOwnership(updatePayload.apiary_id, userId);
         if (!ownApiary.ok)
            return res.status(403).json({ error: "Forbidden: target apiary not yours" });
      }

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

// (Optional) dedicated reassign endpoint (🔒 ownership protected)
router.patch("/:id/reassign", authenticateUser, async (req, res) => {
   const { id } = req.params;
   const userId = req.user.id;
   const { apiary_id } = req.body;

   if (!apiary_id) return res.status(400).json({ error: "apiary_id is required." });

   try {
      // ✅ ensure hive belongs to user
      const owned = await getHiveIfOwnedByUser(id, userId, "hive_id, apiary_id");
      if (!owned.ok) return res.status(404).json({ error: "Hive not found" });

      // ✅ ensure target apiary belongs to user
      const ownApiary = await assertApiaryOwnership(apiary_id, userId);
      if (!ownApiary.ok)
         return res.status(403).json({ error: "Forbidden: target apiary not yours" });

      const { data, error } = await supabase
         .from("hives")
         .update({ apiary_id })
         .eq("hive_id", id)
         .select()
         .maybeSingle();

      if (error) return res.status(400).json({ error: error.message });
      if (!data) return res.status(404).json({ error: "Hive not found" });

      return res.status(200).json({ hive: data, message: "Hive reassigned successfully" });
   } catch (err) {
      console.error("❌ Error reassigning hive:", err);
      res.status(500).json({ error: "Unexpected server error" });
   }
});

// ✅ GET hive by ID (🔒 ownership protected)
router.get("/:id", authenticateUser, async (req, res) => {
   const { id } = req.params;
   const userId = req.user.id;

   try {
      const owned = await getHiveIfOwnedByUser(id, userId, "*");
      if (!owned.ok) return res.status(404).json({ error: "Hive not found" });

      const { apiaries, ...cleanHive } = owned.hive;
      return res.status(200).json(cleanHive);
   } catch (err) {
      console.error("Error fetching hive:", err);
      return res.status(500).json({ error: "Unexpected server error while fetching hive" });
   }
});

// 🔍 Get apiary name by hive_id (🔒 ownership protected)
router.get("/:id/apiary-name", authenticateUser, async (req, res) => {
   const { id } = req.params;
   const userId = req.user.id;

   try {
      const owned = await getHiveIfOwnedByUser(id, userId, "apiary_id");
      if (!owned.ok) return res.status(404).json({ error: "Hive not found" });

      const apiaryName = owned.hive.apiaries?.apiary_name || null;
      if (!apiaryName) return res.status(404).json({ error: "Apiary not found" });

      return res.status(200).json({ apiary_name: apiaryName });
   } catch (err) {
      console.error("Error fetching apiary name:", err);
      return res.status(500).json({ error: "Unexpected server error" });
   }
});

module.exports = router;
