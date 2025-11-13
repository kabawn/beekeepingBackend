// routes/hiveTypes.js
const express = require("express");
const router = express.Router();
const supabase = require("../utils/supabaseClient");
const authenticateUser = require("../middlewares/authMiddleware");

/**
 * Helper to get current user id from auth middleware
 * (adapt this if your auth stores it differently)
 */
function getUserId(req) {
  return req.user?.id || req.user?.user_id || req.user?.sub;
}

/**
 * GET /hive-types
 * 👉 Return all hive types for the current user
 */
router.get("/", authenticateUser, async (req, res) => {
  const userId = getUserId(req);
  if (!userId) {
    return res.status(401).json({ error: "Unauthorized: no user id" });
  }

  try {
    const { data, error } = await supabase
      .from("hive_types")
      .select("*")
      .eq("owner_user_id", userId)
      .order("name", { ascending: true });

    if (error) return res.status(400).json({ error: error.message });

    return res.status(200).json(data || []);
  } catch (err) {
    console.error("❌ Error fetching hive types:", err);
    return res.status(500).json({ error: "Unexpected server error" });
  }
});

/**
 * POST /hive-types
 * 👉 Create a hive type for the current user
 * body: { name, weight_empty_kg? }
 */
router.post("/", authenticateUser, async (req, res) => {
  const userId = getUserId(req);
  if (!userId) {
    return res.status(401).json({ error: "Unauthorized: no user id" });
  }

  const { name, weight_empty_kg } = req.body || {};
  const trimmedName = String(name || "").trim();

  if (!trimmedName) {
    return res.status(400).json({ error: "name is required" });
  }

  try {
    // Optional: avoid duplicate names for the same user
    const { data: existing } = await supabase
      .from("hive_types")
      .select("hive_type_id")
      .eq("owner_user_id", userId)
      .ilike("name", trimmedName)
      .maybeSingle();

    if (existing) {
      return res
        .status(400)
        .json({ error: "Hive type with this name already exists for this user" });
    }

    const payload = {
      owner_user_id: userId,
      name: trimmedName,
    };

    if (weight_empty_kg !== undefined && weight_empty_kg !== null) {
      const w = Number(weight_empty_kg);
      if (!Number.isNaN(w)) {
        payload.weight_empty_kg = w;
      }
    }

    const { data, error } = await supabase
      .from("hive_types")
      .insert([payload])
      .select()
      .single();

    if (error) return res.status(400).json({ error: error.message });

    return res.status(201).json({
      message: "✅ Hive type created successfully",
      hive_type: data,
    });
  } catch (err) {
    console.error("❌ Error creating hive type:", err);
    return res.status(500).json({ error: "Unexpected server error" });
  }
});

module.exports = router;
