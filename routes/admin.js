const express = require("express");
const router = express.Router();
const supabase = require("../utils/supabaseAdmin");

const authenticateUser = require("../middlewares/authMiddleware");
const requireAdmin = require("../middlewares/requireAdmin");
const { DateTime } = require("luxon");

router.use(authenticateUser);
router.use(requireAdmin);

router.get("/ping", (req, res) => {
   res.json({ ok: true, message: "admin api is alive (protected)" });
});

// 1. USER DIRECTORY (With Pagination & Search)
router.get("/users", async (req, res) => {
   try {
      const q = String(req.query.q || "").trim();
      const status = req.query.status; // 'active', 'idle', 'at_risk'
      const page = Math.max(parseInt(req.query.page || "1", 10), 1);
      const limit = Math.min(Math.max(parseInt(req.query.limit || "25", 10), 1), 100);

      const from = (page - 1) * limit;
      const to = from + limit - 1;

      // 1. Base Query
      let userQuery = supabase
         .from("user_profiles")
         .select("user_id, full_name, avatar_url, phone, user_type, created_at", { count: "exact" })
         .order("created_at", { ascending: false });

      if (q) userQuery = userQuery.or(`full_name.ilike.%${q}%,phone.ilike.%${q}%`);

      const { data: users, error: userError, count } = await userQuery;
      if (userError) return res.status(500).json({ error: userError.message });

      // 2. Fetch Activities
      const userIds = users.map((u) => u.user_id);
      const { data: activities } = await supabase
         .from("hive_inspections")
         .select("user_id, inspection_date")
         .in("user_id", userIds)
         .order("inspection_date", { ascending: false });

      // 3. Merge & Logic
      let items = users.map((u) => {
         const lastInsp = activities?.find((a) => a.user_id === u.user_id);
         const lastActiveDate = lastInsp ? lastInsp.inspection_date : null;

         // Calculate Status
         let calculatedStatus = "never";
         if (lastActiveDate) {
            const days = Math.ceil((new Date() - new Date(lastActiveDate)) / (1000 * 60 * 60 * 24));
            if (days <= 7) calculatedStatus = "active";
            else if (days <= 21) calculatedStatus = "idle";
            else calculatedStatus = "at_risk";
         } else {
            calculatedStatus = "at_risk"; // Never active users are at risk
         }

         return {
            ...u,
            id: u.user_id,
            last_active: lastActiveDate,
            status: calculatedStatus,
         };
      });

      // 4. SERVER-SIDE FILTERING
      // If a status filter is requested, we filter the merged list
      if (status && status !== "all") {
         items = items.filter((item) => item.status === status);
      }

      return res.json({
         items,
         total: status && status !== "all" ? items.length : count || 0,
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
// 3. THE CONSOLIDATED "OWNER'S PULSE" (Stats + Growth)
router.get("/stats", async (req, res) => {
   try {
      const { DateTime } = require("luxon");

      const startOfTodayParis = DateTime.now().setZone("Europe/Paris").startOf("day").toISO();
      const sevenDaysAgoParis = DateTime.now().setZone("Europe/Paris").minus({ days: 7 }).toISO();

      const [
         totalUsers,
         newUsersToday,
         newUsers7d,
         totalApiaries,
         apiariesToday,
         totalHives,
         totalInspections,
      ] = await Promise.all([
         supabase.from("user_profiles").select("user_id", { count: "exact", head: true }),
         supabase
            .from("user_profiles")
            .select("user_id", { count: "exact", head: true })
            .gte("created_at", startOfTodayParis),
         supabase
            .from("user_profiles")
            .select("user_id", { count: "exact", head: true })
            .gte("created_at", sevenDaysAgoParis),

         // ✅ use a real column (and catch errors)
         supabase.from("apiaries").select("apiary_id", { count: "exact", head: true }),
         supabase
            .from("apiaries")
            .select("apiary_id", { count: "exact", head: true })
            .gte("created_at", startOfTodayParis),

         supabase.from("hives").select("*", { count: "exact", head: true }),
         supabase.from("hive_inspections").select("*", { count: "exact", head: true }),
      ]);

      // ✅ HARD FAIL on any error (so you don't get fake zeros)
      const err =
         totalUsers.error ||
         newUsersToday.error ||
         newUsers7d.error ||
         totalApiaries.error ||
         apiariesToday.error ||
         totalHives.error ||
         totalInspections.error;

      if (err) {
         return res.status(500).json({ error: err.message || "Supabase query failed" });
      }

      return res.json({
         users: totalUsers.count || 0,
         new_users_today: newUsersToday.count || 0,
         new_users_7d: newUsers7d.count || 0,
         apiaries: totalApiaries.count || 0,
         apiaries_today: apiariesToday.count || 0,
         hives: totalHives.count || 0,
         inspections: totalInspections.count || 0,
         updatedAt: new Date().toISOString(),
         timezone: "Europe/Paris",
      });
   } catch (e) {
      return res.status(500).json({ error: e?.message || "Server error" });
   }
});

router.get("/apiaries/today", async (req, res) => {
   try {
      const startOfTodayParis = DateTime.now().setZone("Europe/Paris").startOf("day").toISO();

      const limit = Math.min(Math.max(parseInt(req.query.limit || "10", 10), 1), 50);

      const { data, error } = await supabase
         .from("apiaries")
         .select("id, apiary_name, city, country, created_at, user_id")
         .gte("created_at", startOfTodayParis)
         .order("created_at", { ascending: false })
         .limit(limit);

      if (error) return res.status(500).json({ error: error.message });

      return res.json({
         items: data || [],
         total: data?.length || 0,
         timezone: "Europe/Paris",
      });
   } catch (e) {
      return res.status(500).json({ error: e?.message || "Server error" });
   }
});

module.exports = router;
