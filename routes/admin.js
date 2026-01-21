const express = require("express");
const router = express.Router();

// For now: public ping (no auth) just to test dashboard can reach backend
router.get("/ping", (req, res) => {
   res.json({ ok: true, message: "admin api is alive" });
});

router.get("/users", async (req, res) => {
   try {
      // ?q= search, ?page=1, ?limit=25
      const q = String(req.query.q || "").trim();
      const page = Math.max(parseInt(req.query.page || "1", 10), 1);
      const limit = Math.min(Math.max(parseInt(req.query.limit || "25", 10), 1), 100);

      const from = (page - 1) * limit;
      const to = from + limit - 1;

      let query = supabase
         .from("user_profile")
         .select("user_id, full_name, avatar_url, phone, user_type, created_at", { count: "exact" })
         .order("created_at", { ascending: false })
         .range(from, to);

      // search (only columns that exist in user_profile)
      if (q) {
         // search by full_name OR phone (safe even if phone is null)
         query = query.or(`full_name.ilike.%${q}%,phone.ilike.%${q}%`);
      }

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

module.exports = router;
