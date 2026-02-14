// routes/apiaryChecklist.js
const express = require("express");
const router = express.Router();
const supabase = require("../utils/supabaseClient");
const authenticateUser = require("../middlewares/authMiddleware");

// helper in case your auth format changes later
function getUserId(req) {
  return req.user?.id || req.user?.user_id || req.user?.sub;
}

/**
 * helper: ensure apiary belongs to current user
 */
async function assertApiaryOwned(apiaryId, userId) {
  const { data, error } = await supabase
    .from("apiaries")
    .select("apiary_id, owner_user_id")
    .eq("apiary_id", apiaryId)
    .maybeSingle();

  if (error) return { ok: false, status: 400, error: error.message };
  if (!data) return { ok: false, status: 404, error: "Apiary not found" };
  if (data.owner_user_id !== userId)
    return { ok: false, status: 403, error: "Forbidden" };

  return { ok: true };
}

/**
 * GET /apiary-checklist/apiaries/:apiaryId
 * -> list checklist items for one apiary (owned by current user)
 */
router.get("/apiaries/:apiaryId", authenticateUser, async (req, res) => {
  try {
    const userId = getUserId(req);
    const apiaryId = Number(req.params.apiaryId);

    if (!userId) return res.status(401).json({ error: "Unauthorized: no user id" });
    if (!apiaryId) return res.status(400).json({ error: "apiaryId param is required" });

    const owned = await assertApiaryOwned(apiaryId, userId);
    if (!owned.ok) return res.status(owned.status).json({ error: owned.error });

    const { data, error } = await supabase
      .from("apiary_checklist_items")
      .select("item_id, apiary_id, label, category, is_checked, sort_order, created_at, updated_at")
      .eq("owner_user_id", userId)
      .eq("apiary_id", apiaryId)
      .order("sort_order", { ascending: true })
      .order("item_id", { ascending: true });

    if (error) throw error;
    return res.json(data || []);
  } catch (err) {
    console.error("❌ Error fetching checklist items:", err);
    return res.status(500).json({ error: "Unexpected server error" });
  }
});

/**
 * POST /apiary-checklist/apiaries/:apiaryId
 * body: { label, category?, sort_order? }
 */
router.post("/apiaries/:apiaryId", authenticateUser, async (req, res) => {
  try {
    const userId = getUserId(req);
    const apiaryId = Number(req.params.apiaryId);

    if (!userId) return res.status(401).json({ error: "Unauthorized: no user id" });
    if (!apiaryId) return res.status(400).json({ error: "apiaryId param is required" });

    const { label, category = null, sort_order = 0 } = req.body || {};
    if (!label || typeof label !== "string" || !label.trim()) {
      return res.status(400).json({ error: "label is required" });
    }

    const owned = await assertApiaryOwned(apiaryId, userId);
    if (!owned.ok) return res.status(owned.status).json({ error: owned.error });

    const { data, error } = await supabase
      .from("apiary_checklist_items")
      .insert([
        {
          apiary_id: apiaryId,
          owner_user_id: userId,
          label: label.trim(),
          category: category ? String(category).trim() : null,
          is_checked: false,
          sort_order: Number.isFinite(Number(sort_order)) ? Number(sort_order) : 0,
        },
      ])
      .select("item_id, apiary_id, label, category, is_checked, sort_order, created_at, updated_at")
      .single();

    if (error) throw error;

    return res.status(201).json(data);
  } catch (err) {
    console.error("❌ Error creating checklist item:", err);
    return res.status(500).json({ error: "Unexpected server error" });
  }
});

/**
 * PUT /apiary-checklist/items/:itemId
 * body: { label?, category?, is_checked?, sort_order? }
 */
router.put("/items/:itemId", authenticateUser, async (req, res) => {
  try {
    const userId = getUserId(req);
    const itemId = Number(req.params.itemId);

    if (!userId) return res.status(401).json({ error: "Unauthorized: no user id" });
    if (!itemId) return res.status(400).json({ error: "itemId param is required" });

    const updatePayload = {};
    const { label, category, is_checked, sort_order } = req.body || {};

    if (label !== undefined) {
      const t = String(label || "").trim();
      if (!t) return res.status(400).json({ error: "label cannot be empty" });
      updatePayload.label = t;
    }

    if (category !== undefined) {
      updatePayload.category = category === null ? null : String(category || "").trim() || null;
    }

    if (is_checked !== undefined) {
      if (typeof is_checked !== "boolean") {
        return res.status(400).json({ error: "is_checked must be boolean" });
      }
      updatePayload.is_checked = is_checked;
    }

    if (sort_order !== undefined) {
      const so = Number(sort_order);
      if (!Number.isFinite(so)) {
        return res.status(400).json({ error: "sort_order must be a number" });
      }
      updatePayload.sort_order = so;
    }

    if (Object.keys(updatePayload).length === 0) {
      return res.status(400).json({ error: "Nothing to update" });
    }

    const { data, error } = await supabase
      .from("apiary_checklist_items")
      .update(updatePayload)
      .eq("owner_user_id", userId)
      .eq("item_id", itemId)
      .select("item_id, apiary_id, label, category, is_checked, sort_order, created_at, updated_at")
      .maybeSingle();

    if (error) return res.status(400).json({ error: error.message });
    if (!data) return res.status(404).json({ error: "Checklist item not found" });

    return res.json({
      message: "✅ Checklist item updated successfully",
      item: data,
    });
  } catch (err) {
    console.error("❌ Error updating checklist item:", err);
    return res.status(500).json({ error: "Unexpected server error" });
  }
});

/**
 * POST /apiary-checklist/items/:itemId/toggle
 * -> toggle is_checked
 */
router.post("/items/:itemId/toggle", authenticateUser, async (req, res) => {
  try {
    const userId = getUserId(req);
    const itemId = Number(req.params.itemId);

    if (!userId) return res.status(401).json({ error: "Unauthorized: no user id" });
    if (!itemId) return res.status(400).json({ error: "itemId param is required" });

    const { data: item, error: itemErr } = await supabase
      .from("apiary_checklist_items")
      .select("item_id, is_checked")
      .eq("owner_user_id", userId)
      .eq("item_id", itemId)
      .maybeSingle();

    if (itemErr) return res.status(400).json({ error: itemErr.message });
    if (!item) return res.status(404).json({ error: "Checklist item not found" });

    const { data, error } = await supabase
      .from("apiary_checklist_items")
      .update({ is_checked: !item.is_checked })
      .eq("owner_user_id", userId)
      .eq("item_id", itemId)
      .select("item_id, apiary_id, label, category, is_checked, sort_order, created_at, updated_at")
      .single();

    if (error) throw error;

    return res.json({
      message: "✅ Toggled successfully",
      item: data,
    });
  } catch (err) {
    console.error("❌ Error toggling checklist item:", err);
    return res.status(500).json({ error: "Unexpected server error" });
  }
});

/**
 * DELETE /apiary-checklist/items/:itemId
 */
router.delete("/items/:itemId", authenticateUser, async (req, res) => {
  try {
    const userId = getUserId(req);
    const itemId = Number(req.params.itemId);

    if (!userId) return res.status(401).json({ error: "Unauthorized: no user id" });
    if (!itemId) return res.status(400).json({ error: "itemId param is required" });

    const { data, error } = await supabase
      .from("apiary_checklist_items")
      .delete()
      .eq("owner_user_id", userId)
      .eq("item_id", itemId)
      .select("item_id, label, category, is_checked, sort_order")
      .maybeSingle();

    if (error) return res.status(400).json({ error: error.message });
    if (!data) return res.status(404).json({ error: "Checklist item not found" });

    return res.json({
      message: "🗑️ Checklist item deleted successfully",
      item: data,
    });
  } catch (err) {
    console.error("❌ Error deleting checklist item:", err);
    return res.status(500).json({ error: "Unexpected server error" });
  }
});

/**
 * POST /apiary-checklist/apiaries/:apiaryId/reset
 * -> set all is_checked=false for that apiary
 */
router.post("/apiaries/:apiaryId/reset", authenticateUser, async (req, res) => {
  try {
    const userId = getUserId(req);
    const apiaryId = Number(req.params.apiaryId);

    if (!userId) return res.status(401).json({ error: "Unauthorized: no user id" });
    if (!apiaryId) return res.status(400).json({ error: "apiaryId param is required" });

    const owned = await assertApiaryOwned(apiaryId, userId);
    if (!owned.ok) return res.status(owned.status).json({ error: owned.error });

    const { error } = await supabase
      .from("apiary_checklist_items")
      .update({ is_checked: false })
      .eq("owner_user_id", userId)
      .eq("apiary_id", apiaryId);

    if (error) throw error;

    return res.json({ message: "✅ Checklist reset successfully" });
  } catch (err) {
    console.error("❌ Error resetting checklist:", err);
    return res.status(500).json({ error: "Unexpected server error" });
  }
});

module.exports = router;
