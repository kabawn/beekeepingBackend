const express = require("express");
const router = express.Router();
const supabase = require("../utils/supabaseClient");

const authenticateUser = require("../middlewares/authMiddleware");
const requireAdmin = require("../middlewares/requireAdmin");

router.use(authenticateUser);
router.use(requireAdmin);

router.get("/ping", (req, res) => {
   res.json({ ok: true, message: "admin api is alive (protected)" });
});

router.get("/users", async (req, res) => {
   try {
      const q = String(req.query.q || "").trim();
      const page = Math.max(parseInt(req.query.page || "1", 10), 1);
      const limit = Math.min(Math.max(parseInt(req.query.limit || "25", 10), 1), 100);

      const from = (page - 1) * limit;
      const to = from + limit - 1;

      let query = supabase
         .from("user_profiles")
         .select("user_id, full_name, avatar_url, phone, user_type, created_at", { count: "exact" })
         .order("created_at", { ascending: false })
         .range(from, to);

      if (q) query = query.or(`full_name.ilike.%${q}%,phone.ilike.%${q}%`);

      const { data, error, count } = await query;

      if (error) return res.status(500).json({ error: error.message });

      return res.json({
         items: (data || []).map((u) => ({
            id: u.user_id,
            user_id: u.user_id,
            full_name: u.full_name,
            avatar_url: u.avatar_url,
            phone: u.phone,
            user_type: u.user_type,
            created_at: u.created_at,
         })),
         total: count || 0,
         page,
         limit,
      });
   } catch (e) {
      return res.status(500).json({ error: e?.message || "Server error" });
   }
});


router.get("/kpis", async (req, res) => {
  try {
    // Total users
    const { count: totalUsers, error: totalErr } = await supabase
      .from("user_profiles")
      .select("user_id", { count: "exact", head: true });

    if (totalErr) return res.status(500).json({ error: totalErr.message });

    // New users (last 7 days)
    const from7d = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString();

    const { count: new7d, error: new7dErr } = await supabase
      .from("user_profiles")
      .select("user_id", { count: "exact", head: true })
      .gte("created_at", from7d);

    if (new7dErr) return res.status(500).json({ error: new7dErr.message });

    // New users (today)
    const startOfToday = new Date();
    startOfToday.setHours(0, 0, 0, 0);

    const { count: newToday, error: newTodayErr } = await supabase
      .from("user_profiles")
      .select("user_id", { count: "exact", head: true })
      .gte("created_at", startOfToday.toISOString());

    if (newTodayErr) return res.status(500).json({ error: newTodayErr.message });

    return res.json({
      total_users: totalUsers || 0,
      new_users_7d: new7d || 0,
      new_users_today: newToday || 0,
    });
  } catch (e) {
    return res.status(500).json({ error: e?.message || "Server error" });
  }
});


module.exports = router;
