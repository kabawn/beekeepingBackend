const { createClient } = require('@supabase/supabase-js');
require('dotenv').config();

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

const authenticateUser = async (req, res, next) => {
  const token = req.headers.authorization?.split(' ')[1]; // Bearer TOKEN

  if (!token) {
    return res.status(401).json({ error: 'Missing access token' });
  }

  const { data, error } = await supabase.auth.getUser(token);

  if (error || !data?.user) {
    return res.status(401).json({ error: 'Invalid or expired token' });
  }

  const user = data.user;

  // ✅ جلب plan_type من جدول subscriptions
  const { data: subscription, error: subError } = await supabase
    .from("subscriptions")
    .select("plan_type")
    .eq("user_id", user.id)
    .single();

  if (subError) {
    console.error("Error fetching subscription:", subError.message);
  }

  req.user = {
    id: user.id,
    email: user.email,
    plan_type: subscription?.plan_type || "free", // افتراضيًا free إذا لم يوجد شيء
  };

  next();
};

module.exports = authenticateUser;
