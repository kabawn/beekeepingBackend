// routes/queens.js
const express = require("express");
const router = express.Router();
const { v4: uuidv4 } = require("uuid");
const QRCode = require("qrcode");
const { createCanvas, loadImage } = require("@napi-rs/canvas");
const supabase = require("../utils/supabaseClient");
const authenticateUser = require("../middlewares/authMiddleware");

// 👑 إنشاء ملكة جديدة
router.post("/", authenticateUser, async (req, res) => {
   const {
      grafting_date,
      strain_name,
      opalite_color,
      expected_traits,
      hive_id,
      forceReplace = false, // 👈 READ this
   } = req.body;

   try {
      if (hive_id) {
         const { data: existingQueen, error: checkError } = await supabase
            .from("queens")
            .select("queen_id")
            .eq("hive_id", hive_id)
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
               // ✅ Unlink old queen
               const { error: unlinkError } = await supabase
                  .from("queens")
                  .update({ hive_id: null })
                  .eq("queen_id", existingQueen.queen_id);

               if (unlinkError) {
                  console.error("Error unlinking old queen:", unlinkError);
                  return res.status(500).json({ error: "Failed to replace existing queen." });
               }
            }
         }
      }

      // ✅ Create new queen
      const { data: allQueens } = await supabase.from("queens").select("queen_id");
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

// 🖼️ تحميل صورة QR لملكة
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
      ctx.fillText(`Ruche: ${queen.queen_code}`, 150, 300);
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
   try {
      const { data, error } = await supabase
         .from("queens")
         .select("*")
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

   try {
      const { data, error } = await supabase
         .from("queens")
         .select("*")
         .eq("queen_id", queen_id)
         .single(); // Ensure it returns one row or 404

      if (error || !data) {
         return res.status(404).json({ error: "Queen not found" });
      }

      return res.status(200).json({ queen: data });
   } catch (err) {
      console.error("Error fetching queen by ID:", err);
      return res.status(500).json({ error: "Unexpected server error" });
   }
});

// ✏️ تحديث ملكة (ربطها بخلية أو تعديل بيانات)
// ✏️ تحديث ملكة
router.patch("/:queen_id", authenticateUser, async (req, res) => {
   const { queen_id } = req.params;
   const updateFields = req.body;

   try {
      const { data, error } = await supabase
         .from("queens")
         .update(updateFields)
         .eq("queen_id", queen_id)
         .select();

      if (error) return res.status(400).json({ error: error.message });
      res.status(200).json({ message: "✅ Queen updated successfully", queen: data[0] });
   } catch (err) {
      console.error(err);
      res.status(500).json({ error: "Unexpected server error" });
   }
});

// ❌ حذف ملكة
router.delete("/:queen_id", authenticateUser, async (req, res) => {
   const { queen_id } = req.params;

   try {
      const { error } = await supabase.from("queens").delete().eq("queen_id", queen_id);

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
