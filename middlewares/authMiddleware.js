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

  // 1) Station tokens (Pi device)
  try {
    const payload = jwt.verify(token, process.env.JWT_SECRET);

    if (payload.role === "station") {
      // 🔥 المرحلة الأولى: فقط ميزان واحد لجون-فرانسوا
      const jfmUserId = "76b4f5ae-03d7-41de-bdf6-9c1915b49009";

      req.user = {
        id: jfmUserId,                  // 👈 هذا هو المهم
        role: "station",
        station: payload.station || "unknown",
      };

      return next();
    }
  } catch (_) {
    // إذا مش توكن محطة → نجرب Supabase
  }

  // 2) Supabase user tokens (mobile/web users)
  const { data, error } = await supabase.auth.getUser(token);
  if (error || !data?.user) {
    return res.status(401).json({ error: "Invalid or expired token" });
  }

  const user = data.user;

  const { data: subscription } = await supabase
    .from("subscriptions")
    .select("plan_type")
    .eq("user_id", user.id)
    .single();

  req.user = {
    id: user.id,
    email: user.email,
    plan_type: subscription?.plan_type || "free",
  };

  next();
};
