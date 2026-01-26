const supabase = require("../utils/supabaseClient");

module.exports = async (req, res, next) => {
  const userId = req.user.id;

  const { data } = await supabase
    .from("subscriptions")
    .select("plan_type")
    .eq("user_id", userId)
    .single();

  if (data?.plan_type !== "pro") {
    return res.status(403).json({ error: "Pro plan required" });
  }

  next();
};
