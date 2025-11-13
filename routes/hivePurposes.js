// routes/hivePurposes.js
const express = require("express");
const router = express.Router();
const supabase = require("../utils/supabaseClient");
const authenticateUser = require("../middlewares/authMiddleware");

function getUserId(req) {
  return req.user?.id || req.user?.user_id || req.user?.sub;
}

/**
 * GET /hive-purposes
 * 👉 Return all hive purposes for current user
 */
router.get("/", authenticateUser, async (req, res) => {
  const userId = getUserId(req);
  if (!userId) {
    return res.status(401).json({ error: "Unauthorized: no user id" });
  }

  try {
    const { data, error } = await supabase
      .from("hive_purposes")
      .select("*")
      .eq("owner_user_id", userId)
      .order("name", { ascending: true });

    if (error) return res.status(400).json({ error: error.message });

    return res.status(200).json(data || []);
  } catch (err) {
    console.error("❌ Error fetching hive purposes:", err);
    return res.status(500).json({ error: "Unexpected server error" });
  }
});

/**
 * POST /hive-purposes
 * body: { name, color_hex? }
 */
router.post("/", authenticateUser, async (req, res) => {
  const userId = getUserId(req);
  if (!userId) {
    return res.status(401).json({ error: "Unauthorized: no user id" });
  }

  const { name, color_hex } = req.body || {};
  const trimmedName = String(name || "").trim();

  if (!trimmedName) {
    return res.status(400).json({ error: "name is required" });
  }

  try {
    // avoid duplicate per user (case-insensitive)
    const { data: existing } = await supabase
      .from("hive_purposes")
      .select("hive_purpose_id")
      .eq("owner_user_id", userId)
      .ilike("name", trimmedName)
      .maybeSingle();

    if (existing) {
      return res
        .status(400)
        .json({ error: "Hive purpose with this name already exists for this user" });
    }

    const payload = {
      owner_user_id: userId,
      name: trimmedName,
    };

    if (color_hex) {
      payload.color_hex = String(color_hex);
    }

    const { data, error } = await supabase
      .from("hive_purposes")
      .insert([payload])
      .select()
      .single();

    if (error) return res.status(400).json({ error: error.message });

    return res.status(201).json({
      message: "✅ Hive purpose created successfully",
      hive_purpose: data,
    });
  } catch (err) {
    console.error("❌ Error creating hive purpose:", err);
    return res.status(500).json({ error: "Unexpected server error" });
  }
});

module.exports = router;
