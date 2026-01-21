// middlewares/authMiddleware.js
const jwt = require("jsonwebtoken");
const { createClient } = require("@supabase/supabase-js");
require("dotenv").config();

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

module.exports = async function authenticateUser(req, res, next) {
  // 🔹 1) Get token from Authorization header OR query ?access_token=
  let token = null;

  const auth = req.headers.authorization || "";

  if (auth.startsWith("Bearer ")) {
    token = auth.replace("Bearer ", "").trim(); // safer than split
  }

  // used by PDF links opened in browser
  if (!token && req.query?.access_token) {
    token = req.query.access_token;
  }

  // ❌ No token at all
  if (!token) {
    return res.status(401).json({
      where: "AUTH_MIDDLEWARE",
      reason: "MISSING_TOKEN",
      message: "No access token was sent",
      path: req.originalUrl,
      hasAuthorizationHeader: !!req.headers.authorization,
    });
  }

  // 🔹 2) Try station JWT first
  try {
    const payload = jwt.verify(token, process.env.JWT_SECRET);

    if (payload.role === "station") {
      // 🔥 Station user (special case)
      const jfmUserId = "76b4f5ae-03d7-41de-bdf6-9c1915b49009";

      req.user = {
        id: jfmUserId,
        role: "station",
        station: payload.station || "unknown",
      };

      return next();
    }
  } catch (err) {
    // Not a station token → continue with Supabase
  }

  // 🔹 3) Supabase user tokens (mobile/web users)
  const { data, error } = await supabase.auth.getUser(token);

  if (error || !data?.user) {
    return res.status(401).json({
      where: "AUTH_MIDDLEWARE",
      reason: "INVALID_OR_EXPIRED_TOKEN",
      message: "Token was sent but rejected by Supabase",
      path: req.originalUrl,
      tokenSource: auth.startsWith("Bearer ")
        ? "authorization_header"
        : req.query?.access_token
        ? "query_access_token"
        : "unknown",
    });
  }

  const user = data.user;

  // 🔹 4) Load subscription (non-blocking)
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
