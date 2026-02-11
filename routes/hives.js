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

// helper: generate next code (01-01 .. 99-99) based on user's existing hives
async function generateNextHiveCodeForUser(userId) {
   // 1) get all user's apiaries ids
   const { data: apiaries, error: apiErr } = await supabase
      .from("apiaries")
      .select("apiary_id")
      .eq("owner_user_id", userId);

   if (apiErr) throw new Error(apiErr.message);

   const apiaryIds = (apiaries || []).map((a) => a.apiary_id);

   let hiveRows = [];
   if (apiaryIds.length > 0) {
      const { data: hives, error: hiveErr } = await supabase
         .from("hives")
         .select("hive_code")
         .in("apiary_id", apiaryIds);

      if (hiveErr) throw new Error(hiveErr.message);
      hiveRows = hives || [];
   }

   let maxVal = 0;

   for (const row of hiveRows) {
      const code = String(row.hive_code || "");
      const [L, R] = code.split("-");
      const left = parseInt(L, 10);
      const right = parseInt(R, 10);
      if (!Number.isFinite(left) || !Number.isFinite(right)) continue;
      if (left < 1 || left > 99 || right < 1 || right > 99) continue;
      const v = left * 100 + right;
      if (v > maxVal) maxVal = v;
   }

   if (maxVal === 0) return "01-01";

   let left = Math.floor(maxVal / 100);
   let right = maxVal % 100;

   right += 1;
   if (right > 99) {
      right = 1;
      left += 1;
   }
   if (left > 99) throw new Error("HIVE_CODE_LIMIT_REACHED");

   return `${String(left).padStart(2, "0")}-${String(right).padStart(2, "0")}`;
}

// ✅ Strict: distinguish 404 vs 403 vs broken relation
async function getHiveOwnedStrict(hiveId, userId, select = "*") {
   // 1) Does hive exist?
   const { data: exists, error: exErr } = await supabase
      .from("hives")
      .select("hive_id, apiary_id")
      .eq("hive_id", hiveId)
      .maybeSingle();

   if (exErr) return { ok: false, status: 500, error: exErr.message };
   if (!exists) return { ok: false, status: 404, error: "Hive not found" };

   // 2) Check apiary ownership
   const { data: apiary, error: apErr } = await supabase
      .from("apiaries")
      .select("apiary_id, owner_user_id, apiary_name, company_id")
      .eq("apiary_id", exists.apiary_id)
      .maybeSingle();

   if (apErr) return { ok: false, status: 500, error: apErr.message };
   if (!apiary) {
      return { ok: false, status: 409, error: "Broken relation: apiary not found for this hive" };
   }

   if (apiary.owner_user_id !== userId) {
      return { ok: false, status: 403, error: "Forbidden" };
   }

   // 3) Fetch hive fields
   const { data: hive, error: hErr } = await supabase
      .from("hives")
      .select(select)
      .eq("hive_id", hiveId)
      .maybeSingle();

   if (hErr) return { ok: false, status: 500, error: hErr.message };
   if (!hive) return { ok: false, status: 404, error: "Hive not found" };

   return { ok: true, hive: { ...hive, apiaries: apiary } };
}

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
       `,
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
       `,
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
   select = "hive_code, apiary_id, public_key",
) {
   const { data, error } = await supabase
      .from("hives")
      .select(
         `
         ${select},
         apiaries!inner(owner_user_id, apiary_name, company_id)
       `,
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
// 🐝 CREATE HIVE (FINAL LOGIC)
router.post("/", authenticateUser, async (req, res) => {
   const userId = req.user.id;

   const {
      hive_type,
      hive_purpose,
      empty_weight,
      frame_capacity,
      apiary_id,
      public_key, // optional
   } = req.body;

   if (!apiary_id) return res.status(400).json({ error: "apiary_id is required." });

   try {
      // ✅ 1) SECURITY: apiary must belong to this user
      const { data: apiary, error: apiaryErr } = await supabase
         .from("apiaries")
         .select("apiary_id, owner_user_id")
         .eq("apiary_id", apiary_id)
         .maybeSingle();

      if (apiaryErr) return res.status(400).json({ error: apiaryErr.message });
      if (!apiary || apiary.owner_user_id !== userId) {
         return res.status(403).json({ error: "You don't have access to this apiary." });
      }

      // ✅ 2) final public_key
      const finalPublicKey = (public_key?.trim().toLowerCase() || uuidv4()).toLowerCase();

      // ✅ 3) Decide hive_code based on whether user has QR ready or not
      let hive_code = null;

      // ---- CASE A: user provided public_key (QR جاهز) ----
      if (public_key) {
         // (A1) ensure not already used by any hive
         const { data: existingHive, error: existErr } = await supabase
            .from("hives")
            .select("hive_id")
            .eq("public_key", finalPublicKey)
            .maybeSingle();

         if (existErr) return res.status(400).json({ error: existErr.message });
         if (existingHive) return res.status(400).json({ error: "Public key already used" });

         // (A2) fetch fixed code from available_public_keys for THIS user
         const { data: available, error: availableErr } = await supabase
            .from("available_public_keys")
            .select("public_key, code")
            .eq("public_key", finalPublicKey)
            .eq("owner_user_id", userId)
            .maybeSingle();

         if (availableErr) return res.status(400).json({ error: availableErr.message });
         if (!available) {
            return res.status(400).json({ error: "Public key not found in your available keys" });
         }

         // ✅ IMPORTANT: keep the code as-is (fixed)
         hive_code = available.code;
      }

      // ---- CASE B: no public_key => auto-generate NN-NN ----
      if (!public_key) {
         hive_code = await generateNextHiveCodeForUser(userId);
      }

      const qr_code = `https://yourapp.com/hive/${finalPublicKey}`;

      // ✅ 4) insert hive
      const { data: hive, error } = await supabase
         .from("hives")
         .insert([
            {
               hive_code,
               hive_type,
               hive_purpose,
               empty_weight,
               frame_capacity,
               public_key: finalPublicKey,
               qr_code,
               apiary_id,
            },
         ])
         .select()
         .single();

      if (error) {
         if (String(error.message || "").includes("HIVE_CODE_LIMIT_REACHED")) {
            return res.status(400).json({ error: "Hive code limit reached (99-99)." });
         }
         return res.status(400).json({ error: error.message });
      }

      // ✅ 5) if QR key was used, delete it from available_public_keys (after success)
      if (public_key) {
         await supabase
            .from("available_public_keys")
            .delete()
            .eq("public_key", finalPublicKey)
            .eq("owner_user_id", userId);
      }

      return res.status(201).json({ message: "✅ Hive created successfully", hive });
   } catch (err) {
      if (err.message === "HIVE_CODE_LIMIT_REACHED") {
         return res.status(400).json({ error: "Hive code limit reached (99-99)." });
      }
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
      const owned = await getHiveByPublicKeyIfOwned(
         public_key,
         userId,
         "hive_code, apiary_id, public_key",
      );
      if (!owned.ok) {
         return res.status(404).json({ error: "Hive not found" });
      }

      const hive = owned.hive;

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
      Object.entries(patch).filter(([k]) => allowed.includes(k)),
   );

   if (Object.keys(updatePayload).length === 0) {
      return res.status(400).json({ error: "No valid fields to update." });
   }

   try {
      const owned = await getHiveIfOwnedByUser(id, userId, "hive_id, apiary_id");
      if (!owned.ok) return res.status(404).json({ error: "Hive not found" });

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
      const owned = await getHiveIfOwnedByUser(id, userId, "hive_id, apiary_id");
      if (!owned.ok) return res.status(404).json({ error: "Hive not found" });

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
// ✅ GET hive by ID (🔒 ownership protected) + logs on failure
// ✅ GET hive by ID (🔒 ownership protected) + DIAGNOSTIC LOGS (on 404/500 only)
router.get("/:id", authenticateUser, async (req, res) => {
   const { id } = req.params;
   const userId = req.user?.id;

   const traceId =
      req.headers["x-request-id"] ||
      req.headers["x-railway-request-id"] ||
      `${Date.now()}-${Math.random().toString(16).slice(2)}`;

   try {
      const owned = await getHiveIfOwnedByUser(id, userId, "*");

      if (!owned.ok) {
         console.warn("[HIVES:GET:NOT_FOUND_OR_FORBIDDEN]", {
            traceId,
            path: req.originalUrl,
            method: req.method,
            id,
            userId,
            hasAuthHeader: !!req.headers.authorization,
            tokenSource: req.headers.authorization?.startsWith("Bearer ")
               ? "authorization_header"
               : req.query?.access_token
                 ? "query_access_token"
                 : "unknown",
            ip: req.headers["x-forwarded-for"] || req.socket?.remoteAddress,
            time: new Date().toISOString(),
            details: owned.error || null,
         });

         return res.status(404).json({ error: "Hive not found" });
      }

      const { apiaries, ...cleanHive } = owned.hive;
      return res.status(200).json(cleanHive);
   } catch (err) {
      console.error("[HIVES:GET:ERROR]", {
         traceId,
         path: req.originalUrl,
         method: req.method,
         id,
         userId,
         time: new Date().toISOString(),
         message: err?.message,
         stack: err?.stack,
      });

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
