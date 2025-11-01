// routes/superTypes.js
const express = require("express");
const router = express.Router();
const supabase = require("../utils/supabaseClient");
const authenticateUser = require("../middlewares/authMiddleware");

// GET /super-types  -> list my types
router.get("/", authenticateUser, async (req, res) => {
  try {
    const userId = req.user.id;
    const { data, error } = await supabase
      .from("super_types")
      .select("super_type_id, name, weight_empty_kg, created_at")
      .eq("owner_user_id", userId)
      .order("name", { ascending: true });

    if (error) throw error;
    res.json(data);
  } catch (err) {
    console.error("❌ Error fetching super types:", err);
    res.status(500).json({ error: "Unexpected server error" });
  }
});

// POST /super-types  -> add one (name + weight in kg)
router.post("/", authenticateUser, async (req, res) => {
  try {
    const userId = req.user.id;
    const { name, weight_empty_kg } = req.body || {};

    if (!name || typeof name !== "string" || !name.trim()) {
      return res.status(400).json({ error: "name is required" });
    }
    const w = Number(weight_empty_kg);
    if (!Number.isFinite(w) || w <= 0) {
      return res.status(400).json({ error: "weight_empty_kg must be a positive number (kg)" });
    }

    const { data, error } = await supabase
      .from("super_types")
      .insert([{ owner_user_id: userId, name: name.trim(), weight_empty_kg: w }])
      .select("super_type_id, name, weight_empty_kg, created_at")
      .single();

    if (error) {
      // likely unique violation per user
      if (String(error.message || "").toLowerCase().includes("duplicate")) {
        return res.status(409).json({ error: "Type with this name already exists" });
      }
      throw error;
    }

    res.status(201).json(data);
  } catch (err) {
    console.error("❌ Error creating super type:", err);
    res.status(500).json({ error: "Unexpected server error" });
  }
});

module.exports = router;
