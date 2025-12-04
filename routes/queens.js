// routes/queens.js
const express = require("express");
const router = express.Router();
const { v4: uuidv4 } = require("uuid");
const QRCode = require("qrcode");
const { createCanvas, loadImage } = require("@napi-rs/canvas");
const supabase = require("../utils/supabaseClient");
const authenticateUser = require("../middlewares/authMiddleware");

// 🔹 Helper: get opalite color from season (international marking system)
function getOpaliteColorFromSeason(season) {
   if (!season) return null;
   const lastDigit = Number(String(season).slice(-1));

   // 1 or 6 → white
   if (lastDigit === 1 || lastDigit === 6) return "white";
   // 2 or 7 → yellow
   if (lastDigit === 2 || lastDigit === 7) return "yellow";
   // 3 or 8 → red
   if (lastDigit === 3 || lastDigit === 8) return "red";
   // 4 or 9 → green
   if (lastDigit === 4 || lastDigit === 9) return "green";
   // 5 or 0 → blue
   if (lastDigit === 5 || lastDigit === 0) return "blue";

   return null;
}

// 👑 إنشاء ملكة جديدة
router.post("/", authenticateUser, async (req, res) => {
   const {
      grafting_date,
      strain_name,
      opalite_color,
      expected_traits,
      hive_id,
      forceReplace = false,
   } = req.body;

   const userId = req.user.id; // 👈 المالك الحقيقي للملكة

   try {
      if (hive_id) {
         // نتأكد أن هذه الخلية ليس لها ملكة لهذا المستخدم
         const { data: existingQueen, error: checkError } = await supabase
            .from("queens")
            .select("queen_id")
            .eq("hive_id", hive_id)
            .eq("owner_user_id", userId) // 👈 مهم جداً
            .limit(1)
            .maybeSingle();

         if (checkError) {
            console.error("Error checking existing queen:", checkError);
            return res.status(500).json({ error: "Failed to check hive queen status" });
         }

         if (existingQueen) {
            if (!forceReplace) {
               return res.status(400).json({ error: "This hive already has a queen linked." });
            } else {
               // ✅ Unlink old queen (الخاصة بنفس المستخدم فقط)
               const { error: unlinkError } = await supabase
                  .from("queens")
                  .update({ hive_id: null })
                  .eq("queen_id", existingQueen.queen_id)
                  .eq("owner_user_id", userId);

               if (unlinkError) {
                  console.error("Error unlinking old queen:", unlinkError);
                  return res.status(500).json({ error: "Failed to replace existing queen." });
               }
            }
         }
      }

      // ✅ Create new queen
      // نخلي الكود Q-001, Q-002 ... لكل مستخدم لوحده
      const { data: allQueens, error: countError } = await supabase
         .from("queens")
         .select("queen_id")
         .eq("owner_user_id", userId);

      if (countError) {
         console.error("Error counting queens:", countError);
         return res.status(500).json({ error: "Failed to generate queen code" });
      }

      const count = allQueens?.length || 0;
      const queenCode = `Q-${String(count + 1).padStart(3, "0")}`;
      const publicKey = uuidv4();

      const { data, error } = await supabase
         .from("queens")
         .insert([
            {
               queen_code: queenCode,
               public_key: publicKey,
               grafting_date,
               strain_name,
               opalite_color,
               expected_traits,
               hive_id,
               owner_user_id: userId, // 👈 ربط الملكة بالمستخدم
            },
         ])
         .select();

      if (error) {
         console.error("Insert error:", error);
         return res.status(400).json({ error: error.message });
      }

      return res.status(201).json({
         message: "Queen created successfully",
         queen: data[0],
      });
   } catch (err) {
      console.error("Unexpected error in POST /queens:", err);
      res.status(500).json({ error: "Unexpected server error" });
   }
});

// 👑 Create a queen from a grafted cell QR
// body: { hive_id, qr_payload, forceReplace? }
// 👑 Create a queen from a grafted cell QR
// body: { hive_id, qr_payload, forceReplace? }
router.post("/from-cell", authenticateUser, async (req, res) => {
   const userId = req.user.id;
   const { hive_id, qr_payload, forceReplace = false } = req.body;

   if (!hive_id || !qr_payload) {
      return res.status(400).json({ error: "hive_id and qr_payload are required" });
   }

   try {
      // 1️⃣ Parse QR payload
      let data;
      try {
         data = typeof qr_payload === "string" ? JSON.parse(qr_payload) : qr_payload;
      } catch (e) {
         console.error("Invalid QR payload:", e);
         return res.status(400).json({ error: "Invalid QR payload JSON" });
      }

      console.log("👑 /queens/from-cell QR payload:", data);

      const sourceType = data.type || "queen_cell"; // e.g. 'queen_cell'
      const cellLot = data.cell_lot || data.full_lot_number || data.full_lot || null; // be tolerant
      const strainName = data.strain || data.strain_name || null;
      const graftingDate = data.graft_date || null;

      // 🧬 NEW: parents / grandparents from QR
      const parents = data.parents || null;
      const grandparents = data.grandparents || null;

      // 🔹 Derive season and opalite color
      const season = data.season || (graftingDate ? new Date(graftingDate).getFullYear() : null);
      const opaliteColor = getOpaliteColorFromSeason(season);

      // 2️⃣ Check if this hive already has a queen for this user
      const { data: existingQueen, error: checkError } = await supabase
         .from("queens")
         .select("queen_id")
         .eq("hive_id", hive_id)
         .eq("owner_user_id", userId)
         .limit(1)
         .maybeSingle();

      if (checkError) {
         console.error("Error checking existing queen:", checkError);
         return res.status(500).json({ error: "Failed to check hive queen status" });
      }

      if (existingQueen) {
         if (!forceReplace) {
            return res
               .status(400)
               .json({ error: "This hive already has a queen linked. Use forceReplace." });
         } else {
            const { error: unlinkError } = await supabase
               .from("queens")
               .update({ hive_id: null })
               .eq("queen_id", existingQueen.queen_id)
               .eq("owner_user_id", userId);

            if (unlinkError) {
               console.error("Error unlinking old queen:", unlinkError);
               return res.status(500).json({ error: "Failed to replace existing queen." });
            }
         }
      }

      // 3️⃣ Generate queen_code like before (Q-001, Q-002...) per user
      const { data: allQueens, error: countError } = await supabase
         .from("queens")
         .select("queen_id")
         .eq("owner_user_id", userId);

      if (countError) {
         console.error("Error counting queens:", countError);
         return res.status(500).json({ error: "Failed to generate queen code" });
      }

      const count = allQueens?.length || 0;
      const queenCode = `Q-${String(count + 1).padStart(3, "0")}`;
      const publicKey = uuidv4();

      // 4️⃣ Create queen row linked to hive + graft cell info
      const { data: created, error: insertError } = await supabase
         .from("queens")
         .insert([
            {
               queen_code: queenCode,
               public_key: publicKey,
               grafting_date: graftingDate,
               strain_name: strainName,
               opalite_color: opaliteColor, // 🔹 auto-filled from season
               expected_traits: null,
               hive_id,
               owner_user_id: userId,
               source_type: sourceType, // 👈 linked to graft system
               source_cell_lot: cellLot, // 👈 safe link to graft line
               source_cell_id: null,

               // 🧬 NEW: store pedigree text directly on queen
               parents,
               grandparents,
            },
         ])
         .select()
         .single();

      if (insertError) {
         console.error("Insert error:", insertError);
         return res.status(400).json({ error: insertError.message });
      }

      console.log("✅ Queen created from cell:", created);

      return res.status(201).json({
         message: "Queen created from cell successfully",
         queen: created,
      });
   } catch (err) {
      console.error("Unexpected error in POST /queens/from-cell:", err);
      res.status(500).json({ error: "Unexpected server error" });
   }
});

// 🔍 Get current queen for a hive
// GET /queens/by-hive/:hive_id
router.get("/by-hive/:hive_id", authenticateUser, async (req, res) => {
   const userId = req.user.id;
   const hiveId = parseInt(req.params.hive_id, 10);

   if (!hiveId || Number.isNaN(hiveId)) {
      return res.status(400).json({ error: "Invalid hive_id" });
   }

   try {
      const { data, error } = await supabase
         .from("queens")
         .select("*")
         .eq("owner_user_id", userId)
         .eq("hive_id", hiveId)
         .eq("is_alive", true)
         .order("created_at", { ascending: false })
         .limit(1)
         .maybeSingle();

      if (error) {
         console.error("Error fetching queen by hive:", error);
         return res.status(500).json({ error: "Failed to fetch queen for hive" });
      }

      if (!data) {
         return res.status(200).json({ queen: null });
      }

      return res.status(200).json({ queen: data });
   } catch (err) {
      console.error("Unexpected error in GET /queens/by-hive:", err);
      return res.status(500).json({ error: "Unexpected server error" });
   }
});

// 🖼️ تحميل صورة QR لملكة
// هذا المسار ممكن يظل عام لأنه فقط لطباعة اللاصق
router.get("/qr-download/:public_key", async (req, res) => {
   const { public_key } = req.params;

   try {
      const { data: queen, error } = await supabase
         .from("queens")
         .select("queen_code, strain_name")
         .eq("public_key", public_key)
         .single();

      if (error || !queen) {
         return res.status(404).json({ error: "Queen not found" });
      }

      const qrUrl = `https://yourapp.com/queen/${public_key}`;
      const qrDataUrl = await QRCode.toDataURL(qrUrl);
      const canvas = createCanvas(300, 360);
      const ctx = canvas.getContext("2d");

      ctx.fillStyle = "#fff";
      ctx.fillRect(0, 0, canvas.width, canvas.height);

      const qrImg = await loadImage(qrDataUrl);
      ctx.drawImage(qrImg, 25, 20, 250, 250);

      ctx.fillStyle = "#000";
      ctx.font = "bold 20px Arial";
      ctx.textAlign = "center";
      ctx.fillText(`Reine: ${queen.queen_code}`, 150, 300); // لو حاب تغير النص
      ctx.font = "16px Arial";
      ctx.fillText(queen.strain_name || "", 150, 340);

      const buffer = canvas.toBuffer("image/png");
      res.setHeader("Content-Disposition", `attachment; filename=queen-${queen.queen_code}.png`);
      res.setHeader("Content-Type", "image/png");
      res.send(buffer);
   } catch (err) {
      console.error(err);
      res.status(500).json({ error: "❌ Failed to generate QR image" });
   }
});

// 📋 عرض جميع الملكات
router.get("/", authenticateUser, async (req, res) => {
   const userId = req.user.id;

   try {
      const { data, error } = await supabase
         .from("queens")
         .select("*")
         .eq("owner_user_id", userId) // 👈 فقط ملكاتي
         .order("created_at", { ascending: false });

      if (error) return res.status(400).json({ error: error.message });
      res.status(200).json({ queens: data });
   } catch (err) {
      console.error(err);
      res.status(500).json({ error: "Unexpected server error" });
   }
});

// 🔍 جلب ملكة واحدة بالتفصيل
router.get("/:queen_id", authenticateUser, async (req, res) => {
   const { queen_id } = req.params;
   const userId = req.user.id;

   try {
      const { data, error } = await supabase
         .from("queens")
         .select("*")
         .eq("queen_id", queen_id)
         .eq("owner_user_id", userId) // 👈 تأمين
         .single();

      if (error || !data) {
         return res.status(404).json({ error: "Queen not found" });
      }

      return res.status(200).json({ queen: data });
   } catch (err) {
      console.error("Error fetching queen by ID:", err);
      return res.status(500).json({ error: "Unexpected server error" });
   }
});

// ✏️ تحديث ملكة
router.patch("/:queen_id", authenticateUser, async (req, res) => {
   const { queen_id } = req.params;
   const updateFields = req.body;
   const userId = req.user.id;

   try {
      const { data, error } = await supabase
         .from("queens")
         .update(updateFields)
         .eq("queen_id", queen_id)
         .eq("owner_user_id", userId) // 👈 لا يمكن التعديل على ملكة شخص آخر
         .select();

      if (error) return res.status(400).json({ error: error.message });
      if (!data || !data[0]) {
         return res.status(404).json({ error: "Queen not found" });
      }

      res.status(200).json({ message: "✅ Queen updated successfully", queen: data[0] });
   } catch (err) {
      console.error(err);
      res.status(500).json({ error: "Unexpected server error" });
   }
});

// ❌ حذف ملكة
router.delete("/:queen_id", authenticateUser, async (req, res) => {
   const { queen_id } = req.params;
   const userId = req.user.id;

   try {
      const { error } = await supabase
         .from("queens")
         .delete()
         .eq("queen_id", queen_id)
         .eq("owner_user_id", userId); // 👈 لا يمكن حذف ملكة غيرك

      if (error) {
         console.error("Error deleting queen:", error);
         return res.status(400).json({ error: "Failed to delete queen" });
      }

      res.status(200).json({ message: "✅ Queen deleted successfully" });
   } catch (err) {
      console.error("Unexpected error deleting queen:", err);
      res.status(500).json({ error: "Unexpected server error" });
   }
});

module.exports = router;
