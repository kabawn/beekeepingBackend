// routes/hives.js
const express = require("express");
const router = express.Router();
const { v4: uuidv4 } = require("uuid");
const QRCode = require("qrcode");
const { createCanvas, loadImage } = require("@napi-rs/canvas");
const supabase = require("../utils/supabaseClient");
const authenticateUser = require("../middlewares/authMiddleware");

// 🐝 إنشاء خلية جديدة
// 🐝 إنشاء خلية جديدة (يدوي أو بمفتاح QR موجود)
// 🐝 إنشاء خلية جديدة
router.post("/", authenticateUser, async (req, res) => {
   const {
      hive_type,
      hive_purpose,
      empty_weight,
      frame_capacity,
      apiary_id,
      public_key, // إذا أتى من QR code
   } = req.body;

   if (!apiary_id) {
      return res.status(400).json({ error: "apiary_id is required." });
   }

   try {
      let finalPublicKey = public_key?.trim().toLowerCase() || uuidv4();
      let finalHiveCode;

      console.log("🔹 Body:", req.body);
      console.log("🔍 Received public_key:", finalPublicKey);

      // ✅ تحقق من تكرار public_key فقط إذا تم تمريره
      if (public_key) {
         const { data: existing, error: checkError } = await supabase
            .from("hives")
            .select("hive_id")
            .ilike("public_key", finalPublicKey.trim())
            .maybeSingle();

         if (existing) {
            console.log("🚫 This public_key is already used in hives table.");
            return res.status(400).json({ error: "Public key already used" });
         }
      }

      if (public_key) {
         const { data: availableKey, error: keyFetchError } = await supabase
            .from("available_public_keys")
            .select("code")
            .ilike("public_key", finalPublicKey.trim())
            .single();

         console.log("🧩 Fetched availableKey from available_public_keys:", availableKey);

         if (!availableKey) {
            console.log("🚫 Public key not found in available_public_keys table.");
            return res.status(400).json({ error: "Public key not found in available list" });
         }

         finalHiveCode = availableKey.code;

         // ❌ ثم احذف المفتاح من الجدول
         const { error: deleteError } = await supabase
            .from("available_public_keys")
            .delete()
            .eq("public_key", finalPublicKey);
         if (deleteError) console.error("⚠️ Failed to delete used public_key:", deleteError);
      } else {
         // ✅ إنشاء hive_code جديد بناء على آخر كود داخل نفس apiary
         const { data: lastHives } = await supabase
            .from("hives")
            .select("hive_code")
            .eq("apiary_id", apiary_id)
            .order("hive_code", { ascending: false })
            .limit(1);

         const lastCode = lastHives?.[0]?.hive_code || `${String(apiary_id).padStart(2, "0")}-00`;
         const [prefix, lastNum] = lastCode.split("-");
         const nextNum = String(parseInt(lastNum) + 1).padStart(2, "0");

         finalHiveCode = `${prefix}-${nextNum}`;
      }

      const qrCode = `https://yourapp.com/hive/${finalPublicKey}`;

      const { data, error } = await supabase
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

      if (error) {
         console.error("🛑 Error inserting hive:", error);
         return res.status(400).json({ error: error.message });
      }

      console.log("✅ Hive created successfully:", {
         hive_code: finalHiveCode,
         public_key: finalPublicKey,
      });

      return res.status(201).json({ message: "✅ Hive created successfully", hive: data });
   } catch (err) {
      console.error("❌ Unexpected error in hive creation:", err);
      return res.status(500).json({ error: "Unexpected server error" });
   }
});

// 🖼️ تحميل صورة QR مع كود الخلية واسم الشركة
router.get("/qr-download/:public_key", async (req, res) => {
   const { public_key } = req.params;

   try {
      const { data: hive } = await supabase
         .from("hives")
         .select("hive_code, apiary_id")
         .eq("public_key", public_key)
         .single();

      if (!hive) {
         return res.status(404).json({ error: "Hive not found" });
      }

      const { data: apiary } = await supabase
         .from("apiaries")
         .select("company_id, owner_user_id")
         .eq("apiary_id", hive.apiary_id)
         .single();

      let label = "Hive Owner";
      if (apiary.company_id) {
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



// ✅ جلب خلية حسب ID
router.get("/:id", authenticateUser, async (req, res) => {
   const { id } = req.params;

   try {
      const { data, error } = await supabase.from("hives").select("*").eq("hive_id", id).single();

      if (error || !data) {
         return res.status(404).json({ error: "Hive not found" });
      }

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
 
     if (hiveError || !hive) {
       return res.status(404).json({ error: "Hive not found" });
     }
 
     const { data: apiary, error: apiaryError } = await supabase
       .from("apiaries")
       .select("apiary_name")
       .eq("apiary_id", hive.apiary_id)
       .single();
 
     if (apiaryError || !apiary) {
       return res.status(404).json({ error: "Apiary not found" });
     }
 
     res.status(200).json({ apiary_name: apiary.apiary_name });
   } catch (err) {
     console.error("Error fetching apiary name:", err);
     res.status(500).json({ error: "Unexpected server error" });
   }
 });

 // ✅ GET hive by hive_code
router.get("/by-code/:code", authenticateUser, async (req, res) => {
   const { code } = req.params;

   try {
      const { data, error } = await supabase
         .from("hives")
         .select("*")
         .eq("hive_code", code)
         .single();

      if (error || !data) {
         return res.status(404).json({ error: "Hive not found" });
      }

      res.status(200).json(data);
   } catch (err) {
      console.error("❌ Error fetching hive by code:", err);
      res.status(500).json({ error: "Unexpected server error" });
   }
});


module.exports = router;
