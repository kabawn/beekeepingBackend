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

   if (lastDigit === 1 || lastDigit === 6) return "white";
   if (lastDigit === 2 || lastDigit === 7) return "yellow";
   if (lastDigit === 3 || lastDigit === 8) return "red";
   if (lastDigit === 4 || lastDigit === 9) return "green";
   if (lastDigit === 5 || lastDigit === 0) return "blue";

   return null;
}

function normalizeQueenYear(queenYear, graftingDate) {
   if (queenYear !== undefined && queenYear !== null && queenYear !== "") {
      const parsed = Number(queenYear);
      if (Number.isInteger(parsed)) return parsed;
   }

   if (graftingDate) {
      const parsedDate = new Date(graftingDate);
      if (!Number.isNaN(parsedDate.getTime())) {
         return parsedDate.getFullYear();
      }
   }

   return null;
}

// ✅ Generate next queen code per user (safe, no count)
async function generateNextQueenCodeForUser(userId) {
   const { data: last, error: lastErr } = await supabase
      .from("queens")
      .select("queen_code")
      .eq("owner_user_id", userId)
      .order("created_at", { ascending: false })
      .limit(1)
      .maybeSingle();

   if (lastErr) throw lastErr;

   if (!last?.queen_code) return "Q-001";

   const m = String(last.queen_code).match(/^Q-(\d{3,})$/);
   const n = m ? parseInt(m[1], 10) : 0;

   return `Q-${String(n + 1).padStart(3, "0")}`;
}

// ✅ Retry-safe insert (handles rare race conditions)
async function insertQueenWithRetry({ userId, queenRowBase, maxAttempts = 3 }) {
   let lastError = null;

   for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      const queenCode = await generateNextQueenCodeForUser(userId);
      const publicKey = uuidv4();

      const row = {
         ...queenRowBase,
         owner_user_id: userId,
         queen_code: queenCode,
         public_key: publicKey,
      };

      const { data, error } = await supabase.from("queens").insert([row]).select().single();

      if (!error) return data;

      lastError = error;

      // If unique violation on (owner_user_id, queen_code) → retry
      const pgCode = error?.code;
      const msg = String(error?.message || "").toLowerCase();

      const isUniqueConflict =
         pgCode === "23505" ||
         msg.includes("duplicate key") ||
         msg.includes("unique") ||
         msg.includes("queens_owner_queen_code_key");

      if (!isUniqueConflict) break;
   }

   throw lastError || new Error("Failed to create queen");
}

/**
 * =========================================================
 * 👑 Create queen
 * POST /queens
 * body: {
 *   grafting_date,
 *   strain_name,
 *   strain_id,
 *   queen_year,
 *   opalite_color,
 *   expected_traits,
 *   hive_id,
 *   source_type,
 *   forceReplace?
 * }
 * =========================================================
 */
router.post("/", authenticateUser, async (req, res) => {
   const {
      grafting_date,
      strain_name,
      strain_id,
      queen_year,
      opalite_color,
      expected_traits,
      hive_id,
      source_type = "manual",
      forceReplace = false,
   } = req.body;

   const userId = req.user.id;

   try {
      if (hive_id) {
         // Check if hive already has a queen for this user
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
               return res.status(400).json({ error: "This hive already has a queen linked." });
            }

            // Unlink old queen (same user only)
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

      const normalizedQueenYear = normalizeQueenYear(queen_year, grafting_date);

      const queenRowBase = {
         grafting_date: grafting_date || null,
         strain_name: strain_name || null,
         strain_id: strain_id || null,
         queen_year: normalizedQueenYear,
         opalite_color: opalite_color || null,
         expected_traits: expected_traits || null,
         hive_id: hive_id || null,
         source_type: source_type || "manual",
      };

      const created = await insertQueenWithRetry({ userId, queenRowBase, maxAttempts: 3 });

      return res.status(201).json({
         message: "Queen created successfully",
         queen: created,
      });
   } catch (err) {
      console.error("Unexpected error in POST /queens:", err);
      return res.status(500).json({ error: "Unexpected server error" });
   }
});

/**
 * =========================================================
 * 👑 Create a queen from a grafted cell QR
 * POST /queens/from-cell
 * body: { hive_id, qr_payload, forceReplace? }
 * =========================================================
 */
router.post("/from-cell", authenticateUser, async (req, res) => {
   const userId = req.user.id;
   const { hive_id, qr_payload, forceReplace = false } = req.body;

   if (!hive_id || !qr_payload) {
      return res.status(400).json({ error: "hive_id and qr_payload are required" });
   }

   try {
      // 1) Parse QR payload
      let payload;
      try {
         payload = typeof qr_payload === "string" ? JSON.parse(qr_payload) : qr_payload;
      } catch (e) {
         console.error("Invalid QR payload:", e);
         return res.status(400).json({ error: "Invalid QR payload JSON" });
      }

      const sourceType = payload.type || "queen_cell";
      const cellLot = payload.cell_lot || payload.full_lot_number || payload.full_lot || null;
      const strainName = payload.strain || payload.strain_name || null;
      const strainId = payload.strain_id || null;
      const graftingDate = payload.graft_date || null;

      const parents = payload.parents || null;
      const grandparents = payload.grandparents || null;

      const season = payload.season || (graftingDate ? new Date(graftingDate).getFullYear() : null);
      const queenYear = normalizeQueenYear(payload.queen_year, graftingDate) || season || null;
      const opaliteColor = getOpaliteColorFromSeason(season);

      // 2) Check if hive already has a queen for this user
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
         }

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

      // 3) Insert with retry-safe code generation
      const queenRowBase = {
         grafting_date: graftingDate,
         strain_name: strainName,
         strain_id: strainId,
         queen_year: queenYear,
         opalite_color: opaliteColor,
         expected_traits: null,
         hive_id,
         source_type: sourceType,
         source_cell_lot: cellLot,
         source_cell_id: null,
         parents,
         grandparents,
      };

      const created = await insertQueenWithRetry({ userId, queenRowBase, maxAttempts: 3 });

      return res.status(201).json({
         message: "Queen created from cell successfully",
         queen: created,
      });
   } catch (err) {
      console.error("Unexpected error in POST /queens/from-cell:", err);
      return res.status(500).json({ error: "Unexpected server error" });
   }
});

/**
 * =========================================================
 * 🔎 Search apiaries by queen strain
 * GET /queens/search-by-strain?q=T406
 * =========================================================
 */
router.get("/search-by-strain", authenticateUser, async (req, res) => {
   const userId = req.user.id;
   const q = String(req.query.q || "").trim();

   if (!q) {
      return res.status(400).json({ error: "Query parameter q is required" });
   }

   try {
      // 1) Find matching queens for this user
      const { data: queens, error: queensError } = await supabase
         .from("queens")
         .select("queen_id, queen_code, strain_name, queen_year, hive_id")
         .eq("owner_user_id", userId)
         .eq("is_alive", true)
         .not("hive_id", "is", null)
         .ilike("strain_name", `%${q}%`)
         .order("strain_name", { ascending: true });

      if (queensError) {
         console.error("Error searching queens by strain:", queensError);
         return res.status(500).json({ error: "Failed to search queens by strain" });
      }

      if (!queens || queens.length === 0) {
         return res.status(200).json({
            query: q,
            total_queens: 0,
            apiaries: [],
         });
      }

      const hiveIds = [...new Set(queens.map((q) => q.hive_id).filter(Boolean))];

      // 2) Load hives
      const { data: hives, error: hivesError } = await supabase
         .from("hives")
         .select("hive_id, hive_code, apiary_id")
         .in("hive_id", hiveIds);

      if (hivesError) {
         console.error("Error loading hives for strain search:", hivesError);
         return res.status(500).json({ error: "Failed to load hives" });
      }

      const apiaryIds = [...new Set((hives || []).map((h) => h.apiary_id).filter(Boolean))];

      // 3) Load apiaries
      const { data: apiaries, error: apiariesError } = await supabase
         .from("apiaries")
         .select("apiary_id, apiary_name, owner_user_id")
         .eq("owner_user_id", userId)
         .in("apiary_id", apiaryIds);

      if (apiariesError) {
         console.error("Error loading apiaries for strain search:", apiariesError);
         return res.status(500).json({ error: "Failed to load apiaries" });
      }

      // 4) Build lookup maps
      const hiveMap = new Map((hives || []).map((h) => [String(h.hive_id), h]));
      const apiaryMap = new Map((apiaries || []).map((a) => [String(a.apiary_id), a]));

      // 5) Group by apiary
      const grouped = new Map();

      for (const queen of queens) {
         const hive = hiveMap.get(String(queen.hive_id));
         if (!hive) continue;

         const apiary = apiaryMap.get(String(hive.apiary_id));
         if (!apiary) continue;

         const apiaryKey = String(apiary.apiary_id);

         if (!grouped.has(apiaryKey)) {
            grouped.set(apiaryKey, {
               apiary_id: apiary.apiary_id,
               apiary_name: apiary.apiary_name,
               queens_count: 0,
               hives: [],
            });
         }

         const bucket = grouped.get(apiaryKey);

         bucket.queens_count += 1;
         bucket.hives.push({
            hive_id: hive.hive_id,
            hive_code: hive.hive_code,
            queen_id: queen.queen_id,
            queen_code: queen.queen_code,
            strain_name: queen.strain_name,
            queen_year: queen.queen_year,
         });
      }

      const results = Array.from(grouped.values()).sort((a, b) =>
         String(a.apiary_name || "").localeCompare(String(b.apiary_name || ""), "fr", {
            sensitivity: "base",
         }),
      );

      return res.status(200).json({
         query: q,
         total_queens: queens.length,
         apiaries: results,
      });
   } catch (err) {
      console.error("Unexpected error in GET /queens/search-by-strain:", err);
      return res.status(500).json({ error: "Unexpected server error" });
   }
});

/**
 * =========================================================
 * 🔍 Get current queen for a hive
 * GET /queens/by-hive/:hive_id
 * =========================================================
 */
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

      return res.status(200).json({ queen: data || null });
   } catch (err) {
      console.error("Unexpected error in GET /queens/by-hive:", err);
      return res.status(500).json({ error: "Unexpected server error" });
   }
});

/**
 * =========================================================
 * 🖼️ QR download (public for printing)
 * GET /queens/qr-download/:public_key
 * =========================================================
 */
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
      ctx.fillText(`Reine: ${queen.queen_code}`, 150, 300);
      ctx.font = "16px Arial";
      ctx.fillText(queen.strain_name || "", 150, 340);

      const buffer = canvas.toBuffer("image/png");
      res.setHeader("Content-Disposition", `attachment; filename=queen-${queen.queen_code}.png`);
      res.setHeader("Content-Type", "image/png");
      res.send(buffer);
   } catch (err) {
      console.error(err);
      return res.status(500).json({ error: "❌ Failed to generate QR image" });
   }
});

/**
 * =========================================================
 * 📋 List my queens
 * GET /queens
 * =========================================================
 */
router.get("/", authenticateUser, async (req, res) => {
   const userId = req.user.id;

   try {
      const { data, error } = await supabase
         .from("queens")
         .select("*")
         .eq("owner_user_id", userId)
         .order("created_at", { ascending: false });

      if (error) return res.status(400).json({ error: error.message });
      return res.status(200).json({ queens: data || [] });
   } catch (err) {
      console.error(err);
      return res.status(500).json({ error: "Unexpected server error" });
   }
});

// 🔍 Get one queen by queen_code
// GET /queens/code/:queen_code
router.get("/code/:queen_code", authenticateUser, async (req, res) => {
   const userId = req.user.id;
   const queenCode = String(req.params.queen_code || "").trim();

   try {
      const { data, error } = await supabase
         .from("queens")
         .select("*")
         .eq("owner_user_id", userId)
         .eq("queen_code", queenCode)
         .maybeSingle();

      if (error) return res.status(500).json({ error: "Failed to fetch queen" });
      if (!data) return res.status(404).json({ error: "Queen not found" });

      return res.status(200).json({ queen: data });
   } catch (err) {
      console.error("GET /queens/code error:", err);
      return res.status(500).json({ error: "Unexpected server error" });
   }
});

/**
 * =========================================================
 * 🔍 Get one queen
 * GET /queens/:queen_id
 * =========================================================
 */
router.get("/:queen_id", authenticateUser, async (req, res) => {
   const { queen_id } = req.params;
   const userId = req.user.id;

   try {
      const { data, error } = await supabase
         .from("queens")
         .select("*")
         .eq("queen_id", queen_id)
         .eq("owner_user_id", userId)
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

/**
 * =========================================================
 * ✏️ Update queen
 * PATCH /queens/:queen_id
 * =========================================================
 */
router.patch("/:queen_id", authenticateUser, async (req, res) => {
   const { queen_id } = req.params;
   const userId = req.user.id;

   const allowedFields = [
      "grafting_date",
      "strain_name",
      "strain_id",
      "opalite_color",
      "expected_traits",
      "queen_year",
      "source_type",
      "is_alive",
      "hive_id",
   ];

   const updateFields = Object.fromEntries(
      Object.entries(req.body || {}).filter(([key]) => allowedFields.includes(key)),
   );

   if (Object.keys(updateFields).length === 0) {
      return res.status(400).json({ error: "No valid fields to update" });
   }

   if ("queen_year" in updateFields) {
      updateFields.queen_year = normalizeQueenYear(
         updateFields.queen_year,
         updateFields.grafting_date,
      );
   } else if ("grafting_date" in updateFields && updateFields.grafting_date) {
      updateFields.queen_year = normalizeQueenYear(null, updateFields.grafting_date);
   }

   if ("strain_id" in updateFields && !updateFields.strain_id) {
      updateFields.strain_id = null;
   }

   if ("strain_name" in updateFields && !updateFields.strain_name) {
      updateFields.strain_name = null;
   }

   try {
      const { data, error } = await supabase
         .from("queens")
         .update(updateFields)
         .eq("queen_id", queen_id)
         .eq("owner_user_id", userId)
         .select()
         .single();

      if (error) return res.status(400).json({ error: error.message });
      if (!data) return res.status(404).json({ error: "Queen not found" });

      return res.status(200).json({ message: "✅ Queen updated successfully", queen: data });
   } catch (err) {
      console.error(err);
      return res.status(500).json({ error: "Unexpected server error" });
   }
});

/**
 * =========================================================
 * ❌ Delete queen
 * DELETE /queens/:queen_id
 * =========================================================
 */
router.delete("/:queen_id", authenticateUser, async (req, res) => {
   const { queen_id } = req.params;
   const userId = req.user.id;

   try {
      const { error } = await supabase
         .from("queens")
         .delete()
         .eq("queen_id", queen_id)
         .eq("owner_user_id", userId);

      if (error) {
         console.error("Error deleting queen:", error);
         return res.status(400).json({ error: "Failed to delete queen" });
      }

      return res.status(200).json({ message: "✅ Queen deleted successfully" });
   } catch (err) {
      console.error("Unexpected error deleting queen:", err);
      return res.status(500).json({ error: "Unexpected server error" });
   }
});

module.exports = router;
