const supabase = require("../utils/supabaseClient");

module.exports = async function requireAdmin(req, res, next) {
   try {
      const userId = req.user?.id; // ✅ your authMiddleware sets this

      if (!userId) {
         return res.status(401).json({ error: "Unauthorized" });
      }

      const { data, error } = await supabase
         .from("user_profiles")
         .select("is_admin")
         .eq("user_id", userId)
         .single();

      if (error) return res.status(500).json({ error: error.message });

      if (!data?.is_admin) {
         return res.status(403).json({ error: "Admin only" });
      }

      next();
   } catch (e) {
      return res.status(500).json({ error: e?.message || "Server error" });
   }
};
