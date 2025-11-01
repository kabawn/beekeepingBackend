// middlewares/authMiddleware.js
const jwt = require("jsonwebtoken");
const { createClient } = require('@supabase/supabase-js');
require('dotenv').config();

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

module.exports = async function authenticateUser(req, res, next) {
  const auth = req.headers.authorization || "";
  const token = auth.split(" ")[1]; // Bearer xxx
  if (!token) return res.status(401).json({ error: "Missing access token" });

  // 1) Accept device (station) tokens signed with JWT_SECRET
  try {
    const payload = jwt.verify(token, process.env.JWT_SECRET);
    if (payload.role === "station") {
      req.user = { id: null, role: "station", station: payload.station || "unknown" };
      return next();
    }
  } catch (_) { /* not a station token → continue */ }

  // 2) Fallback: normal Supabase user tokens (unchanged)
  const { data, error } = await supabase.auth.getUser(token);
  if (error || !data?.user) return res.status(401).json({ error: "Invalid or expired token" });

  const user = data.user;

  const { data: subscription } = await supabase
    .from("subscriptions")
    .select("plan_type")
    .eq("user_id", user.id)
    .single();

  req.user = { id: user.id, email: user.email, plan_type: subscription?.plan_type || "free" };
  next();
};
