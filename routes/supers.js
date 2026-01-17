// routes/supers.js
const express = require("express");
const router = express.Router();
const supabase = require("../utils/supabaseClient");
const authenticateUser = require("../middlewares/authMiddleware");
const { v4: uuidv4 } = require("uuid");

/**
 * =========================================================
 * ✅ 0) (OPTIONAL) GET /  - Legacy: fetch supers by user's hives
 * =========================================================
 * ⚠️ This can be heavy. Remove if not used by the app.
 */
router.get("/", authenticateUser, async (req, res) => {
   try {
      const userId = req.user.id;

      const { data: hives, error: hivesError } = await supabase
         .from("hives")
         .select("hive_id")
         .eq("owner_user_id", userId);

      if (hivesError) throw hivesError;

      const hiveIds = (hives || []).map((h) => h.hive_id);
      if (!hiveIds.length) return res.json([]);

      const { data, error } = await supabase.from("supers").select("*").in("hive_id", hiveIds);
      if (error) throw error;

      return res.json(data || []);
   } catch (err) {
      console.error("Error fetching supers:", err);
      return res.status(500).json({ error: "Unexpected server error" });
   }
});

/**
 * =========================================================
 * ✅ 1) GET /my  - paginated list
 * =========================================================
 */
router.get("/my", authenticateUser, async (req, res) => {
   const userId = req.user.id;

   const limit = Math.min(Number(req.query.limit) || 50, 200);
   const offset = Number(req.query.offset) || 0;
   const from = offset;
   const to = offset + limit - 1;

   const activeParam = req.query.active; // "true" | "false" | undefined

   try {
      let q = supabase
         .from("supers")
         .select(
            "super_id,super_code,super_type,purpose_super,weight_empty,active,service_in,hive_id,public_key,created_at"
         )
         .eq("owner_user_id", userId)
         .order("created_at", { ascending: false })
         .range(from, to);

      if (activeParam === "true") q = q.eq("active", true);
      if (activeParam === "false") q = q.eq("active", false);

      const { data, error } = await q;
      if (error) throw error;

      return res.status(200).json({ supers: data || [] });
   } catch (err) {
      console.error("❌ Error fetching user supers:", err);
      return res.status(500).json({ error: "Unexpected server error" });
   }
});

/**
 * =========================================================
 * ✅ 2) GET /my/stats  - totals (fast)
 * =========================================================
 */
router.get("/my/stats", authenticateUser, async (req, res) => {
   const userId = req.user.id;
   const t0 = Date.now();

   try {
      const { data, error } = await supabase
         .from("supers")
         .select("active")
         .eq("owner_user_id", userId);

      if (error) throw error;

      let total = 0;
      let active_total = 0;

      if (Array.isArray(data)) {
         total = data.length;
         active_total = data.filter((s) => s.active).length;
      }

      console.log("🧠 supers stats ms =", Date.now() - t0);

      return res.json({ total, active_total });
   } catch (err) {
      console.error("❌ supers stats error:", err);
      return res.status(500).json({ error: "Unexpected server error" });
   }
});

/**
 * =========================================================
 * ✅ 3) GET /identifier/:super_code
 * =========================================================
 */
router.get("/identifier/:super_code", authenticateUser, async (req, res) => {
   const { super_code } = req.params;
   const userId = req.user.id;

   try {
      const { data, error } = await supabase
         .from("supers")
         .select("super_id, super_code, public_key, owner_user_id")
         .eq("super_code", super_code.trim())
         .eq("owner_user_id", userId)
         .maybeSingle();

      console.log("🧪 Incoming code:", super_code);
      console.log("🧪 User ID:", userId);
      console.log("🧪 Supabase result:", data);
      console.log("🧪 Supabase error:", error);

      if (error || !data) {
         return res.status(404).json({ error: "Super not found or not owned by user" });
      }

      return res.json({
         id: data.super_id,
         super_code: data.super_code,
         public_key: data.public_key,
      });
   } catch (err) {
      console.error("❌ Error fetching super by code:", err);
      return res.status(500).json({ error: "Unexpected server error" });
   }
});

/**
 * =========================================================
 * ✅ 4) GET /public/:public_key  (PROTECTED)
 * =========================================================
 */
router.get("/public/:public_key", authenticateUser, async (req, res) => {
   const { public_key } = req.params;
   const auth = req.user || {}; // may be station or user

   try {
      const { data: superData, error: superError } = await supabase
         .from("supers")
         .select(
            `
            super_id,
            super_code,
            super_type,
            purpose_super,
            weight_empty,
            active,
            service_in,
            hive_id,
            public_key,
            created_at,
            owner_user_id
         `
         )
         .eq("public_key", public_key)
         .maybeSingle();

      if (superError || !superData) {
         return res.status(404).json({ error: "Super not found" });
      }

      // ✅ station token: read-only
      if (auth.role === "station") {
         return res.status(200).json({
            super: {
               super_id: superData.super_id,
               super_code: superData.super_code,
               public_key: superData.public_key,
               weight_empty: superData.weight_empty,
               hive_id: superData.hive_id,
               active: superData.active,
               service_in: superData.service_in,
               created_at: superData.created_at,
            },
            label: "Station",
         });
      }

      // ✅ normal user access logic
      const user_id = auth.id;

      if (!superData.hive_id) {
         let label = "Super Owner";
         if (superData.owner_user_id) {
            const { data: userProfile } = await supabase
               .from("user_profiles")
               .select("full_name")
               .eq("user_id", superData.owner_user_id)
               .maybeSingle();
            if (userProfile?.full_name) label = userProfile.full_name;
         }
         return res.status(200).json({ super: superData, label });
      }

      const { data: hive } = await supabase
         .from("hives")
         .select("apiary_id")
         .eq("hive_id", superData.hive_id)
         .maybeSingle();

      if (!hive?.apiary_id) {
         return res.status(200).json({ super: superData, label: "Super Owner" });
      }

      const { data: apiary } = await supabase
         .from("apiaries")
         .select("apiary_name, commune, department, company_id, owner_user_id")
         .eq("apiary_id", hive.apiary_id)
         .maybeSingle();

      if (!apiary) return res.status(404).json({ error: "Apiary not found" });

      let hasAccess = false;

      if (apiary.owner_user_id === user_id) hasAccess = true;
      else if (apiary.company_id) {
         const { data: userProfile } = await supabase
            .from("user_profiles")
            .select("company_id")
            .eq("user_id", user_id)
            .maybeSingle();
         if (userProfile?.company_id === apiary.company_id) hasAccess = true;
      }

      if (!hasAccess) return res.status(403).json({ error: "Access denied" });

      let label = "Super Owner";

      if (apiary.company_id) {
         const { data: company } = await supabase
            .from("companies")
            .select("company_name")
            .eq("company_id", apiary.company_id)
            .maybeSingle();
         label = company?.company_name || label;
      } else if (apiary.owner_user_id) {
         const { data: user } = await supabase
            .from("user_profiles")
            .select("full_name")
            .eq("user_id", apiary.owner_user_id)
            .maybeSingle();
         label = user?.full_name || label;
      }

      return res.json({ super: superData, label });
   } catch (err) {
      console.error("❌ Error fetching super by public key:", err);
      return res.status(500).json({ error: "Unexpected server error" });
   }
});

/**
 * =========================================================
 * ✅ 5) GET /hive/:hive_id
 * =========================================================
 */
router.get("/hive/:hive_id", authenticateUser, async (req, res) => {
   const { hive_id } = req.params;

   try {
      const { data, error } = await supabase
         .from("supers")
         .select("*")
         .eq("hive_id", hive_id)
         .eq("active", true);

      if (error) throw error;

      return res.status(200).json(data || []);
   } catch (err) {
      console.error("❌ Error fetching supers for hive:", err);
      return res.status(500).json({ error: "Unexpected server error" });
   }
});

/**
 * =========================================================
 * ✅ 6) POST /link
 * =========================================================
 */
router.post("/link", authenticateUser, async (req, res) => {
   const { super_code, public_key, hive_id } = req.body;

   if (!hive_id) {
      return res.status(400).json({ error: "Hive ID is required" });
   }

   try {
      let query = supabase.from("supers").select("*").eq("active", true).single();

      if (super_code) query = query.eq("super_code", super_code);
      else if (public_key) query = query.eq("public_key", public_key);
      else return res.status(400).json({ error: "Super code or public key is required" });

      const { data: superData, error } = await query;

      if (error || !superData) {
         return res.status(404).json({ error: "Super not found" });
      }

      if (superData.hive_id && superData.hive_id !== hive_id) {
         const { data: linkedHive } = await supabase
            .from("hives")
            .select("hive_id, hive_code, hive_type, apiary_id")
            .eq("hive_id", superData.hive_id)
            .maybeSingle();

         return res.status(409).json({
            error: "Super already linked to another hive",
            linkedHive: linkedHive || { hive_id: superData.hive_id },
            super: superData,
         });
      }

      const { data, error: updateError } = await supabase
         .from("supers")
         .update({ hive_id })
         .eq("super_id", superData.super_id)
         .select("*")
         .single();

      if (updateError) throw updateError;

      return res.status(200).json({ message: "Super linked successfully", super: data });
   } catch (err) {
      console.error("❌ Error linking super:", err);
      return res.status(500).json({ error: "Unexpected server error" });
   }
});

/**
 * =========================================================
 * ✅ 7) POST /batch
 * =========================================================
 */
router.post("/batch", authenticateUser, async (req, res) => {
   const owner_user_id = req.user.id;
   const items = Array.isArray(req.body) ? req.body : [];
   if (!items.length) return res.status(400).json({ error: "Empty batch" });

   const results = [];

   for (const row of items) {
      const {
         public_key,
         super_type_name,
         purpose_super = "honey",
         active,
         service_in,
      } = row || {};

      if (!public_key || !super_type_name) {
         results.push({ ok: false, public_key, error: "Missing public_key or super_type_name" });
         continue;
      }

      const finalActive = typeof active === "boolean" ? active : true;
      const finalServiceIn = typeof service_in === "boolean" ? service_in : true;

      try {
         const { data: st, error: stErr } = await supabase
            .from("super_types")
            .select("name, weight_empty_kg")
            .eq("owner_user_id", owner_user_id)
            .eq("name", super_type_name.trim())
            .maybeSingle();
         if (stErr) throw stErr;
         if (!st) {
            results.push({ ok: false, public_key, error: "super_type_name not found" });
            continue;
         }

         const { data: existing } = await supabase
            .from("supers")
            .select("super_id")
            .eq("public_key", public_key)
            .maybeSingle();
         if (existing) {
            results.push({ ok: false, public_key, error: "Public key already used" });
            continue;
         }

         let finalSuperCode = null;
         let claimedAvailableId = null;

         const { data: avail, error: availErr } = await supabase
            .from("available_public_keys")
            .select("id, code")
            .eq("public_key", public_key)
            .maybeSingle();
         if (availErr) throw availErr;

         if (avail?.code) {
            finalSuperCode = String(avail.code).trim();
            claimedAvailableId = avail.id;
         }

         if (!finalSuperCode) {
            finalSuperCode = "01-01";
            const { data: lastSuper, error: lastErr } = await supabase
               .from("supers")
               .select("super_code")
               .order("created_at", { ascending: false })
               .limit(1)
               .maybeSingle();
            if (lastErr) throw lastErr;

            if (lastSuper?.super_code) {
               const [prefix, suffix] = lastSuper.super_code.split("-").map(Number);
               let newSuffix = (Number.isFinite(suffix) ? suffix : 0) + 1;
               let newPrefix = Number.isFinite(prefix) ? prefix : 1;
               if (newSuffix > 99) {
                  newSuffix = 1;
                  newPrefix += 1;
               }
               finalSuperCode = `${String(newPrefix).padStart(2, "0")}-${String(newSuffix).padStart(
                  2,
                  "0"
               )}`;
            }
         }

         const { data: created, error: insErr } = await supabase
            .from("supers")
            .insert([
               {
                  super_code: finalSuperCode,
                  super_type: st.name,
                  purpose_super,
                  qr_code: null,
                  weight_empty: Number(st.weight_empty_kg),
                  active: finalActive,
                  service_in: finalServiceIn,
                  hive_id: null,
                  public_key,
                  owner_user_id,
               },
            ])
            .select("super_id, super_code, super_type, weight_empty, public_key")
            .single();
         if (insErr) throw insErr;

         if (claimedAvailableId) {
            const { error: delErr } = await supabase
               .from("available_public_keys")
               .delete()
               .eq("id", claimedAvailableId);

            if (delErr) {
               results.push({
                  ok: true,
                  public_key,
                  super_code: created.super_code,
                  id: created.super_id,
                  warning: "Super created but failed to delete available_public_keys row",
               });
               continue;
            }
         }

         results.push({
            ok: true,
            public_key,
            super_code: created.super_code,
            id: created.super_id,
         });
      } catch (e) {
         results.push({ ok: false, public_key, error: e.message || "create failed" });
      }
   }

   return res.status(207).json({ results });
});

/**
 * =========================================================
 * ✅ 8) POST /  (create single)
 * =========================================================
 */
router.post("/", authenticateUser, async (req, res) => {
   const {
      super_type,
      super_type_name,
      purpose_super,
      qr_code,
      weight_empty,
      active,
      service_in,
      hive_id,
      public_key,
   } = req.body;

   const owner_user_id = req.user.id;

   const finalActive = typeof active === "boolean" ? active : true;
   const finalServiceIn = typeof service_in === "boolean" ? service_in : true;

   try {
      let finalPublicKey = public_key ? String(public_key).trim() : null;
      let finalSuperCode = null;

      // 1) If public_key provided -> validate + claim label code
      if (finalPublicKey) {
         const { data: existing, error: existingErr } = await supabase
            .from("supers")
            .select("super_id")
            .eq("public_key", finalPublicKey)
            .maybeSingle();
         if (existingErr) throw existingErr;
         if (existing) return res.status(400).json({ error: "Public key already used" });

         const { data: available, error: availErr } = await supabase
            .from("available_public_keys")
            .select("id, code, owner_user_id")
            .eq("public_key", finalPublicKey)
            .eq("owner_user_id", owner_user_id)
            .maybeSingle();
         if (availErr) throw availErr;

         if (!available?.code) {
            return res.status(400).json({ error: "Public key not found in your available keys" });
         }

         finalSuperCode = String(available.code).trim();

         const { error: delErr } = await supabase
            .from("available_public_keys")
            .delete()
            .eq("id", available.id);
         if (delErr) throw delErr;
      }

      // 2) If no code -> generate sequential per user
      if (!finalSuperCode) {
         if (!finalPublicKey) finalPublicKey = uuidv4();

         const { data: lastSuper, error: lastErr } = await supabase
            .from("supers")
            .select("super_code")
            .eq("owner_user_id", owner_user_id)
            .order("created_at", { ascending: false })
            .limit(1)
            .maybeSingle();
         if (lastErr) throw lastErr;

         if (lastSuper?.super_code) {
            const [prefixStr, suffixStr] = lastSuper.super_code.split("-");
            let prefix = Number(prefixStr) || 1;
            let suffix = Number(suffixStr) || 0;

            suffix += 1;
            if (suffix > 99) {
               suffix = 1;
               prefix += 1;
            }

            finalSuperCode = `${String(prefix).padStart(2, "0")}-${String(suffix).padStart(
               2,
               "0"
            )}`;
         } else {
            finalSuperCode = "01-01";
         }
      }

      // 3) Uniqueness safety
      const { data: already, error: alreadyErr } = await supabase
         .from("supers")
         .select("super_id")
         .or(`super_code.eq.${finalSuperCode},public_key.eq.${finalPublicKey}`)
         .maybeSingle();
      if (alreadyErr) throw alreadyErr;
      if (already)
         return res.status(400).json({ error: "Super code or public key already exists" });

      // 4) Resolve type + tare
      let finalTypeText = (super_type || "").trim();
      let finalWeightEmptyKg = typeof weight_empty === "number" ? weight_empty : null;

      if ((!Number.isFinite(finalWeightEmptyKg) || finalWeightEmptyKg <= 0) && super_type_name) {
         const { data: st, error: stErr } = await supabase
            .from("super_types")
            .select("name, weight_empty_kg")
            .eq("owner_user_id", owner_user_id)
            .eq("name", super_type_name.trim())
            .maybeSingle();

         if (stErr) throw stErr;
         if (!st)
            return res.status(400).json({ error: "super_type_name not found in your catalog" });

         finalWeightEmptyKg = Number(st.weight_empty_kg);
         finalTypeText = st.name;
      }

      if (!Number.isFinite(finalWeightEmptyKg) || finalWeightEmptyKg <= 0) {
         return res.status(400).json({
            error: "Missing empty weight. Provide weight_empty (kg) or a valid super_type_name",
         });
      }

      // 5) Insert
      const { data, error } = await supabase
         .from("supers")
         .insert([
            {
               super_code: finalSuperCode,
               super_type: finalTypeText,
               purpose_super,
               qr_code: qr_code || `https://yourapp.com/super/${finalPublicKey}`,
               weight_empty: finalWeightEmptyKg,
               active: finalActive,
               service_in: finalServiceIn,
               hive_id: hive_id || null,
               public_key: finalPublicKey,
               owner_user_id,
            },
         ])
         .select("*")
         .single();

      if (error) throw error;

      console.log("✅ Super created:", {
         super_code: finalSuperCode,
         public_key: finalPublicKey,
         owner_user_id,
         super_type: finalTypeText,
         weight_empty: finalWeightEmptyKg,
      });

      return res.status(201).json(data);
   } catch (err) {
      console.error("❌ Error creating super:", err);
      return res.status(500).json({ error: "Unexpected server error" });
   }
});

/**
 * =========================================================
 * ✅ 9) PATCH /:id/unlink  (MUST be before /:id)
 * =========================================================
 */
router.patch("/:id/unlink", authenticateUser, async (req, res) => {
   const { id } = req.params;

   try {
      const { data, error } = await supabase
         .from("supers")
         .update({ hive_id: null })
         .eq("super_id", id)
         .select("*")
         .single();

      if (error) throw error;

      return res.status(200).json({ message: "Super unlinked successfully", super: data });
   } catch (err) {
      console.error("❌ Error unlinking super:", err);
      return res.status(500).json({ error: "Unexpected server error" });
   }
});

/**
 * =========================================================
 * ✅ 10) GET /:id
 * =========================================================
 */
router.get("/:id", authenticateUser, async (req, res) => {
   try {
      const { id } = req.params;
      const { data, error } = await supabase.from("supers").select("*").eq("super_id", id).single();

      if (error || !data) return res.status(404).json({ error: "Super not found" });

      return res.json(data);
   } catch (err) {
      console.error("Error fetching super:", err);
      return res.status(500).json({ error: "Unexpected server error" });
   }
});

/**
 * =========================================================
 * ✅ 11) PUT /:id
 * =========================================================
 */
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

      return res.json(data);
   } catch (err) {
      console.error("Error updating super:", err);
      return res.status(500).json({ error: "Unexpected server error" });
   }
});

/**
 * =========================================================
 * ✅ 12) DELETE /:id
 * =========================================================
 */
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

      return res.json({ message: "Super deleted successfully", super: data });
   } catch (err) {
      console.error("Error deleting super:", err);
      return res.status(500).json({ error: "Unexpected server error" });
   }
});

module.exports = router;
