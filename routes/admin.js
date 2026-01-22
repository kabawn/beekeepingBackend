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

// 1. USER DIRECTORY (With Pagination & Search)
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

// 2. SINGLE USER VIEW
router.get("/users/:id", async (req, res) => {
   try {
      const { id } = req.params;
      const { data, error } = await supabase
         .from("user_profiles")
         .select("user_id, full_name, avatar_url, phone, user_type, created_at")
         .eq("user_id", id)
         .single();

      if (error) {
         if (error.code === "PGRST116") return res.status(404).json({ error: "User not found" });
         return res.status(500).json({ error: error.message });
      }
      return res.json(data);
   } catch (e) {
      return res.status(500).json({ error: e?.message || "Server error" });
   }
});

// 3. THE CONSOLIDATED "OWNER'S PULSE" (Stats + Growth)
// This is what powers your Dashboard cards!
router.get("/stats", async (req, res) => {
   try {
      const now = new Date();
      const startOfToday = new Date(now.getFullYear(), now.getMonth(), now.getDate()).toISOString();
      const sevenDaysAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString();

      // We run all counts in parallel for maximum speed
      const [totalUsers, newUsersToday, newUsers7d, totalHives, totalInspections] =
         await Promise.all([
            // Total Users
            supabase.from("user_profiles").select("*", { count: "exact", head: true }),

            // New Users Today
            supabase
               .from("user_profiles")
               .select("*", { count: "exact", head: true })
               .gte("created_at", startOfToday),

            // New Users Last 7 Days
            supabase
               .from("user_profiles")
               .select("*", { count: "exact", head: true })
               .gte("created_at", sevenDaysAgo),

            // Total Hives
            supabase.from("hives").select("*", { count: "exact", head: true }),

            // Total Inspections
            supabase.from("inspections").select("*", { count: "exact", head: true }),
         ]);

      res.json({
         users: totalUsers.count || 0,
         new_users_today: newUsersToday.count || 0,
         new_users_7d: newUsers7d.count || 0,
         hives: totalHives.count || 0,
         inspections: totalInspections.count || 0,
         updatedAt: new Date().toISOString(),
      });
   } catch (e) {
      res.status(500).json({ error: e.message });
   }
});

module.exports = router;
