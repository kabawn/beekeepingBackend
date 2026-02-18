const supabase = require("../utils/supabaseClient");

module.exports = async (req, res, next) => {
   try {
      const userId = req.user?.id;
      if (!userId) {
         return res.status(401).json({ error: "Unauthorized" });
      }

      const { data, error } = await supabase
         .from("subscriptions")
         .select("plan_type")
         .eq("user_id", userId)
         .maybeSingle(); // safer than .single()

      if (error) {
         console.error("requirePremium error:", error);
         return res.status(500).json({ error: "Server error" });
      }

      const plan = data?.plan_type || "free";

      if (plan !== "premium") {
         return res.status(403).json({ error: "Premium plan required" });
      }

      req.plan = plan;
      next();
   } catch (err) {
      console.error("requirePremium unexpected error:", err);
      return res.status(500).json({ error: "Server error" });
   }
};
