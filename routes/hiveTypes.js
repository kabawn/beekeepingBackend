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
 * GET /hive-types/:id
 * 👉 Get a single hive type (must belong to current user)
 */
router.get("/:id", authenticateUser, async (req, res) => {
  const userId = getUserId(req);
  const { id } = req.params;

  if (!userId) {
    return res.status(401).json({ error: "Unauthorized: no user id" });
  }

  if (!id) {
    return res.status(400).json({ error: "id param is required" });
  }

  try {
    const { data, error } = await supabase
      .from("hive_types")
      .select("*")
      .eq("owner_user_id", userId)
      .eq("hive_type_id", id)
      .maybeSingle();

    if (error) return res.status(400).json({ error: error.message });

    if (!data) {
      return res.status(404).json({ error: "Hive type not found" });
    }

    return res.status(200).json(data);
  } catch (err) {
    console.error("❌ Error fetching hive type by id:", err);
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
    const { data: existing, error: existingError } = await supabase
      .from("hive_types")
      .select("hive_type_id")
      .eq("owner_user_id", userId)
      .ilike("name", trimmedName)
      .maybeSingle();

    if (existingError) {
      return res.status(400).json({ error: existingError.message });
    }

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

/**
 * PUT /hive-types/:id
 * 👉 Update a hive type (name and/or weight_empty_kg)
 * body: { name?, weight_empty_kg? }
 */
router.put("/:id", authenticateUser, async (req, res) => {
  const userId = getUserId(req);
  const { id } = req.params;

  if (!userId) {
    return res.status(401).json({ error: "Unauthorized: no user id" });
  }

  if (!id) {
    return res.status(400).json({ error: "id param is required" });
  }

  let { name, weight_empty_kg } = req.body || {};

  // Prepare update payload
  const updatePayload = {};

  if (name !== undefined) {
    const trimmedName = String(name || "").trim();
    if (!trimmedName) {
      return res.status(400).json({ error: "name cannot be empty" });
    }

    // Check duplicate name for same user (exclude current id)
    try {
      const { data: existing, error: existingError } = await supabase
        .from("hive_types")
        .select("hive_type_id")
        .eq("owner_user_id", userId)
        .ilike("name", trimmedName)
        .neq("hive_type_id", id)
        .maybeSingle();

      if (existingError) {
        return res.status(400).json({ error: existingError.message });
      }

      if (existing) {
        return res.status(400).json({
          error: "Hive type with this name already exists for this user",
        });
      }
    } catch (err) {
      console.error("❌ Error checking duplicate hive type name:", err);
      return res.status(500).json({ error: "Unexpected server error" });
    }

    updatePayload.name = trimmedName;
  }

  if (weight_empty_kg !== undefined) {
    if (weight_empty_kg === null || weight_empty_kg === "") {
      // allow clearing the value
      updatePayload.weight_empty_kg = null;
    } else {
      const w = Number(weight_empty_kg);
      if (Number.isNaN(w)) {
        return res.status(400).json({ error: "weight_empty_kg must be a number" });
      }
      updatePayload.weight_empty_kg = w;
    }
  }

  if (Object.keys(updatePayload).length === 0) {
    return res.status(400).json({
      error: "Nothing to update. Provide at least one field (name or weight_empty_kg).",
    });
  }

  try {
    const { data, error } = await supabase
      .from("hive_types")
      .update(updatePayload)
      .eq("owner_user_id", userId)
      .eq("hive_type_id", id)
      .select()
      .maybeSingle();

    if (error) return res.status(400).json({ error: error.message });

    if (!data) {
      return res.status(404).json({ error: "Hive type not found" });
    }

    return res.status(200).json({
      message: "✅ Hive type updated successfully",
      hive_type: data,
    });
  } catch (err) {
    console.error("❌ Error updating hive type:", err);
    return res.status(500).json({ error: "Unexpected server error" });
  }
});

/**
 * DELETE /hive-types/:id
 * 👉 Delete a hive type (must belong to current user)
 */
router.delete("/:id", authenticateUser, async (req, res) => {
  const userId = getUserId(req);
  const { id } = req.params;

  if (!userId) {
    return res.status(401).json({ error: "Unauthorized: no user id" });
  }

  if (!id) {
    return res.status(400).json({ error: "id param is required" });
  }

  try {
    const { data, error } = await supabase
      .from("hive_types")
      .delete()
      .eq("owner_user_id", userId)
      .eq("hive_type_id", id)
      .select()
      .maybeSingle();

    if (error) return res.status(400).json({ error: error.message });

    if (!data) {
      return res.status(404).json({ error: "Hive type not found" });
    }

    return res.status(200).json({
      message: "🗑️ Hive type deleted successfully",
      hive_type: data,
    });
  } catch (err) {
    console.error("❌ Error deleting hive type:", err);
    return res.status(500).json({ error: "Unexpected server error" });
  }
});

module.exports = router;
