// routes/superTypes.js
const express = require("express");
const router = express.Router();
const supabase = require("../utils/supabaseClient");
const authenticateUser = require("../middlewares/authMiddleware");

// helper in case your auth format changes later
function getUserId(req) {
  return req.user?.id || req.user?.user_id || req.user?.sub;
}

/**
 * GET /super-types
 * -> list my super types
 */
router.get("/", authenticateUser, async (req, res) => {
  try {
    const userId = getUserId(req);
    if (!userId) {
      return res.status(401).json({ error: "Unauthorized: no user id" });
    }

    const { data, error } = await supabase
      .from("super_types")
      .select("super_type_id, name, weight_empty_kg, created_at")
      .eq("owner_user_id", userId)
      .order("name", { ascending: true });

    if (error) throw error;
    res.json(data || []);
  } catch (err) {
    console.error("❌ Error fetching super types:", err);
    res.status(500).json({ error: "Unexpected server error" });
  }
});

/**
 * GET /super-types/:id
 * -> get a single super type (must belong to current user)
 */
router.get("/:id", authenticateUser, async (req, res) => {
  try {
    const userId = getUserId(req);
    const { id } = req.params;

    if (!userId) {
      return res.status(401).json({ error: "Unauthorized: no user id" });
    }
    if (!id) {
      return res.status(400).json({ error: "id param is required" });
    }

    const { data, error } = await supabase
      .from("super_types")
      .select("super_type_id, name, weight_empty_kg, created_at")
      .eq("owner_user_id", userId)
      .eq("super_type_id", id)
      .maybeSingle();

    if (error) {
      return res.status(400).json({ error: error.message });
    }
    if (!data) {
      return res.status(404).json({ error: "Super type not found" });
    }

    res.json(data);
  } catch (err) {
    console.error("❌ Error fetching super type by id:", err);
    res.status(500).json({ error: "Unexpected server error" });
  }
});

/**
 * POST /super-types
 * -> add one (name + weight in kg)
 */
router.post("/", authenticateUser, async (req, res) => {
  try {
    const userId = getUserId(req);
    if (!userId) {
      return res.status(401).json({ error: "Unauthorized: no user id" });
    }

    const { name, weight_empty_kg } = req.body || {};

    if (!name || typeof name !== "string" || !name.trim()) {
      return res.status(400).json({ error: "name is required" });
    }
    const w = Number(weight_empty_kg);
    if (!Number.isFinite(w) || w <= 0) {
      return res
        .status(400)
        .json({ error: "weight_empty_kg must be a positive number (kg)" });
    }

    // optional: check duplicate name for this user
    const { data: existing, error: existingError } = await supabase
      .from("super_types")
      .select("super_type_id")
      .eq("owner_user_id", userId)
      .ilike("name", name.trim())
      .maybeSingle();

    if (existingError) {
      return res.status(400).json({ error: existingError.message });
    }
    if (existing) {
      return res
        .status(400)
        .json({ error: "Type with this name already exists" });
    }

    const { data, error } = await supabase
      .from("super_types")
      .insert([
        {
          owner_user_id: userId,
          name: name.trim(),
          weight_empty_kg: w,
        },
      ])
      .select("super_type_id, name, weight_empty_kg, created_at")
      .single();

    if (error) throw error;

    res.status(201).json(data);
  } catch (err) {
    console.error("❌ Error creating super type:", err);
    res.status(500).json({ error: "Unexpected server error" });
  }
});

/**
 * PUT /super-types/:id
 * -> update name and/or weight_empty_kg
 * body: { name?, weight_empty_kg? }
 */
router.put("/:id", authenticateUser, async (req, res) => {
  try {
    const userId = getUserId(req);
    const { id } = req.params;

    if (!userId) {
      return res.status(401).json({ error: "Unauthorized: no user id" });
    }
    if (!id) {
      return res.status(400).json({ error: "id param is required" });
    }

    let { name, weight_empty_kg } = req.body || {};
    const updatePayload = {};

    // name validation + duplicate check
    if (name !== undefined) {
      const trimmedName = String(name || "").trim();
      if (!trimmedName) {
        return res.status(400).json({ error: "name cannot be empty" });
      }

      const { data: existing, error: existingError } = await supabase
        .from("super_types")
        .select("super_type_id")
        .eq("owner_user_id", userId)
        .ilike("name", trimmedName)
        .neq("super_type_id", id)
        .maybeSingle();

      if (existingError) {
        return res.status(400).json({ error: existingError.message });
      }
      if (existing) {
        return res
          .status(400)
          .json({ error: "Type with this name already exists" });
      }

      updatePayload.name = trimmedName;
    }

    // weight validation
    if (weight_empty_kg !== undefined) {
      const w = Number(weight_empty_kg);
      if (!Number.isFinite(w) || w <= 0) {
        return res
          .status(400)
          .json({ error: "weight_empty_kg must be a positive number (kg)" });
      }
      updatePayload.weight_empty_kg = w;
    }

    if (Object.keys(updatePayload).length === 0) {
      return res.status(400).json({
        error:
          "Nothing to update. Provide at least one field (name or weight_empty_kg).",
      });
    }

    const { data, error } = await supabase
      .from("super_types")
      .update(updatePayload)
      .eq("owner_user_id", userId)
      .eq("super_type_id", id)
      .select("super_type_id, name, weight_empty_kg, created_at")
      .maybeSingle();

    if (error) {
      return res.status(400).json({ error: error.message });
    }
    if (!data) {
      return res.status(404).json({ error: "Super type not found" });
    }

    res.json({
      message: "✅ Super type updated successfully",
      super_type: data,
    });
  } catch (err) {
    console.error("❌ Error updating super type:", err);
    res.status(500).json({ error: "Unexpected server error" });
  }
});

/**
 * DELETE /super-types/:id
 * -> delete a super type (must belong to current user)
 */
router.delete("/:id", authenticateUser, async (req, res) => {
  try {
    const userId = getUserId(req);
    const { id } = req.params;

    if (!userId) {
      return res.status(401).json({ error: "Unauthorized: no user id" });
    }
    if (!id) {
      return res.status(400).json({ error: "id param is required" });
    }

    const { data, error } = await supabase
      .from("super_types")
      .delete()
      .eq("owner_user_id", userId)
      .eq("super_type_id", id)
      .select("super_type_id, name, weight_empty_kg, created_at")
      .maybeSingle();

    if (error) {
      return res.status(400).json({ error: error.message });
    }
    if (!data) {
      return res.status(404).json({ error: "Super type not found" });
    }

    res.json({
      message: "🗑️ Super type deleted successfully",
      super_type: data,
    });
  } catch (err) {
    console.error("❌ Error deleting super type:", err);
    res.status(500).json({ error: "Unexpected server error" });
  }
});

module.exports = router;
