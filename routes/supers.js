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

// ✅ Get paginated supers + total count + active count
// ✅ Get paginated supers + total count + active count
router.get("/my", authenticateUser, async (req, res) => {
   const userId = req.user.id;

   const limit = Math.min(Number(req.query.limit) || 100, 500);
   const offset = Number(req.query.offset) || 0;
   const from = offset;
   const to = offset + limit - 1;

   // 🔹 optional filter: ?active=true / ?active=false
   const activeParam = req.query.active; // "true" | "false" | undefined

   try {
      // 1️⃣ Base query for the paginated list
      let pageQuery = supabase
         .from("supers")
         .select("*", { count: "exact" }) // count here is WITH the filter
         .eq("owner_user_id", userId)
         .order("created_at", { ascending: false });

      if (activeParam === "true") {
         pageQuery = pageQuery.eq("active", true);
      } else if (activeParam === "false") {
         pageQuery = pageQuery.eq("active", false);
      }

      const { data, error, count: pageCount } = await pageQuery.range(from, to);
      if (error) throw error;

      // 2️⃣ Global total (all supers, no filter)
      const { count: totalAll, error: totalErr } = await supabase
         .from("supers")
         .select("super_id", { count: "exact", head: true })
         .eq("owner_user_id", userId);
      if (totalErr) throw totalErr;

      // 3️⃣ Global active total (all active supers, no filter)
      const { count: activeAll, error: activeErr } = await supabase
         .from("supers")
         .select("super_id", { count: "exact", head: true })
         .eq("owner_user_id", userId)
         .eq("active", true);
      if (activeErr) throw activeErr;

      res.status(200).json({
         supers: data || [],
         // 🔹 pageCount = total count of THIS FILTER (used if you ever want pagination info)
         filtered_total: pageCount || 0,
         // 🔹 global numbers for header:
         total: totalAll || 0,
         active_total: activeAll || 0,
      });
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

// ✅ Get super by super_code
// ✅ Get super by super_code, for authenticated user only
// ✅ Get super by super_code (for authenticated user only)
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

      // ✅ Return normalized object
      res.json({
         id: data.super_id,
         super_code: data.super_code,
         public_key: data.public_key,
      });
   } catch (err) {
      console.error("❌ Error fetching super by code:", err);
      res.status(500).json({ error: "Unexpected server error" });
   }
});

// ✅ إنشاء عاسلة جديدة (supports super_type_name → auto tare from /super-types)
// ✅ Create a new super (single)
router.post("/", authenticateUser, async (req, res) => {
   // ⬇️ Accept both legacy fields and the new catalog-based name
   const {
      super_type, // (legacy text, still accepted)
      super_type_name, // (NEW) preferred: exact name from super_types.name
      purpose_super,
      qr_code,
      weight_empty, // kg (number). If missing, we try to pull from super_types
      active,
      service_in,
      hive_id,
      public_key,
   } = req.body;

   const owner_user_id = req.user.id; // ✅ authenticated user

   // ✅ add this
   const finalActive = typeof active === "boolean" ? active : true;
   const finalServiceIn = typeof service_in === "boolean" ? service_in : true;

   try {
      let finalPublicKey = public_key ? String(public_key).trim() : null;
      let finalSuperCode = null;

      // ---------- 1) PUBLIC KEY / LABEL HANDLING (same spirit as hives) ----------
      if (finalPublicKey) {
         // 1.a) Check not already used in supers
         const { data: existing, error: existingErr } = await supabase
            .from("supers")
            .select("super_id")
            .eq("public_key", finalPublicKey)
            .maybeSingle();
         if (existingErr) throw existingErr;

         if (existing) {
            return res.status(400).json({ error: "Public key already used" });
         }

         // 1.b) Check that this public_key belongs to THIS user's label pack
         // 1.b) Check that this public_key belongs to THIS user's label pack
         const { data: available, error: availErr } = await supabase
            .from("available_public_keys")
            .select("id, code, owner_user_id") // 👈 use the real column name
            .eq("public_key", finalPublicKey)
            .eq("owner_user_id", owner_user_id) // 👈 match on owner_user_id
            .maybeSingle();

         if (availErr) throw availErr;

         if (!available?.code) {
            return res.status(400).json({ error: "Public key not found in your available keys" });
         }

         // use the human label as super_code
         finalSuperCode = String(available.code).trim();

         // ✅ consume the key → delete row (same logic as hives)
         const { error: delErr } = await supabase
            .from("available_public_keys")
            .delete()
            .eq("id", available.id);

         if (delErr) throw delErr;
      }

      // ---------- 2) If NO label code → generate a super_code + public_key ----------
      // This covers:
      //  - supers without QR (no public_key)
      //  - or weird cases where label had no code (should not happen)
      if (!finalSuperCode) {
         // always ensure we have some public_key
         if (!finalPublicKey) {
            finalPublicKey = uuidv4();
         }

         // Generate next super_code, based on this user's last super
         const { data: lastSuper, error: lastErr } = await supabase
            .from("supers")
            .select("super_code")
            .eq("owner_user_id", owner_user_id) // 👈 sequence per user
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

      // ---------- 3) Ensure uniqueness of super_code / public_key ----------
      const { data: already, error: alreadyErr } = await supabase
         .from("supers")
         .select("super_id")
         .or(`super_code.eq.${finalSuperCode},public_key.eq.${finalPublicKey}`)
         .maybeSingle();

      if (alreadyErr) throw alreadyErr;

      if (already) {
         return res.status(400).json({ error: "Super code or public key already exists" });
      }

      // ---------- 4) Resolve type + tare (kg) ----------
      let finalTypeText = (super_type || "").trim(); // keep legacy text column updated
      let finalWeightEmptyKg = typeof weight_empty === "number" ? weight_empty : null;

      // If client provided a catalog name and didn't send weight, fetch tare from super_types
      if ((!Number.isFinite(finalWeightEmptyKg) || finalWeightEmptyKg <= 0) && super_type_name) {
         const { data: st, error: stErr } = await supabase
            .from("super_types")
            .select("name, weight_empty_kg")
            .eq("owner_user_id", owner_user_id)
            .eq("name", super_type_name.trim())
            .maybeSingle();

         if (stErr) throw stErr;
         if (!st) {
            return res.status(400).json({ error: "super_type_name not found in your catalog" });
         }

         finalWeightEmptyKg = Number(st.weight_empty_kg);
         finalTypeText = st.name;
      }

      // If still no weight, reject with clear message
      if (!Number.isFinite(finalWeightEmptyKg) || finalWeightEmptyKg <= 0) {
         return res.status(400).json({
            error: "Missing empty weight. Provide weight_empty (kg) or a valid super_type_name",
         });
      }

      // ---------- 5) INSERT ----------
      const { data, error } = await supabase
         .from("supers")
         .insert([
            {
               super_code: finalSuperCode,
               super_type: finalTypeText, // text label
               purpose_super,
               qr_code: qr_code || `https://yourapp.com/super/${finalPublicKey}`,
               weight_empty: finalWeightEmptyKg, // KG
               active: finalActive, // ✅ always true if not sent
               service_in: finalServiceIn, // ✅ always true if not sent
               hive_id: hive_id || null,
               public_key: finalPublicKey,
               owner_user_id, // tie to authenticated user
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

      res.status(201).json(data);
   } catch (err) {
      console.error("❌ Error creating super:", err);
      res.status(500).json({ error: "Unexpected server error" });
   }
});

// POST /supers/batch  -> [{ public_key, super_type_name, purpose_super? }, ...]
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

      // ✅ same logic as single create
      const finalActive = typeof active === "boolean" ? active : true;
      const finalServiceIn = typeof service_in === "boolean" ? service_in : true;

      try {
         // 1) Resolve super type (tare) for this user
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

         // 2) Uniqueness check on supers.public_key
         const { data: existing } = await supabase
            .from("supers")
            .select("super_id")
            .eq("public_key", public_key)
            .maybeSingle();
         if (existing) {
            results.push({ ok: false, public_key, error: "Public key already used" });
            continue;
         }

         // 3) Try to claim a code from available_public_keys using this public_key
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

         // 4) If no code from available_public_keys → generate next sequential code
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

         // 5) Insert the super
         const { data: created, error: insErr } = await supabase
            .from("supers")
            .insert([
               {
                  super_code: finalSuperCode,
                  super_type: st.name,
                  purpose_super,
                  qr_code: null,
                  weight_empty: Number(st.weight_empty_kg),
                  active: finalActive, // ✅ default true if not sent
                  service_in: finalServiceIn, // ✅ default true if not sent
                  hive_id: null,
                  public_key,
                  owner_user_id,
               },
            ])
            .select("super_id, super_code, super_type, weight_empty, public_key")
            .single();
         if (insErr) throw insErr;

         // 6) If we claimed a key from available_public_keys → DELETE it now
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

   res.status(207).json({ results });
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
// ✅ راوت جلب بيانات العاسلة من public_key + حماية
// routes/supers.js (replace the whole /public/:public_key handler)
router.get("/public/:public_key", authenticateUser, async (req, res) => {
   const { public_key } = req.params;
   const auth = req.user || {}; // may be station or user

   try {
      // 1) Fetch the super by public_key
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

      // 2) If the token is a station → allow read-only minimal response (no ownership checks)
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
            label: "Station", // or your LOCATION if you want
         });
      }

      // 3) Otherwise (normal user): keep your existing ownership/company access logic
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

// 🔗 Link a super to a hive by code or QR
router.post("/link", authenticateUser, async (req, res) => {
   const { super_code, public_key, hive_id } = req.body;

   if (!hive_id) {
      return res.status(400).json({ error: "Hive ID is required" });
   }

   try {
      // Allow linking whether hive_id is null or not, but still check for duplicates
      let query = supabase.from("supers").select("*").eq("active", true).single();

      if (super_code) {
         query = query.eq("super_code", super_code);
      } else if (public_key) {
         query = query.eq("public_key", public_key);
      } else {
         return res.status(400).json({ error: "Super code or public key is required" });
      }

      const { data: superData, error } = await query;

      if (error || !superData) {
         return res.status(404).json({ error: "Super not found" });
      }

      // ⛔ Already linked? Return info about the existing hive
      if (superData.hive_id && superData.hive_id !== hive_id) {
         const { data: linkedHive, error: hiveError } = await supabase
            .from("hives")
            .select("hive_id, hive_code, hive_type, apiary_id")
            .eq("hive_id", superData.hive_id)
            .maybeSingle();

         return res.status(409).json({
            error: "Super already linked to another hive",
            linkedHive: linkedHive || { hive_id: superData.hive_id },
            super: superData, // ✅ This is essential
         });
      }

      // ✅ Proceed to link
      const { data, error: updateError } = await supabase
         .from("supers")
         .update({ hive_id })
         .eq("super_id", superData.super_id)
         .select("*")
         .single();

      if (updateError) throw updateError;

      res.status(200).json({ message: "Super linked successfully", super: data });
   } catch (err) {
      console.error("❌ Error linking super:", err);
      res.status(500).json({ error: "Unexpected server error" });
   }
});

// ✅ Get all supers linked to a specific hive
router.get("/hive/:hive_id", authenticateUser, async (req, res) => {
   const { hive_id } = req.params;

   try {
      const { data, error } = await supabase
         .from("supers")
         .select("*")
         .eq("hive_id", hive_id)
         .eq("active", true);

      if (error) throw error;

      res.status(200).json(data);
   } catch (err) {
      console.error("❌ Error fetching supers for hive:", err);
      res.status(500).json({ error: "Unexpected server error" });
   }
});

// ✅ Unlink a super from its hive
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

      res.status(200).json({ message: "Super unlinked successfully", super: data });
   } catch (err) {
      console.error("❌ Error unlinking super:", err);
      res.status(500).json({ error: "Unexpected server error" });
   }
});

module.exports = router;
