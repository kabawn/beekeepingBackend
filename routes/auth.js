const express = require("express");
const router = express.Router();
const supabase = require("../utils/supabaseClient");

// ✅ تسجيل مستخدم جديد
router.post("/signup", async (req, res) => {
   const { email, password, full_name } = req.body;

   // 1. إنشاء المستخدم
   const { data: userData, error: signUpError } = await supabase.auth.admin.createUser({
      email,
      password,
      email_confirm: true,
   });

   if (signUpError) {
      return res.status(400).json({ error: signUpError.message });
   }

   const userId = userData.user.id;

   // 2. إضافة الملف الشخصي
   const { error: profileError } = await supabase
      .from("user_profiles")
      .insert([{ user_id: userId, full_name }]);

   if (profileError) {
      return res.status(400).json({ error: profileError.message });
   }

   // 3. إنشاء اشتراك مجاني
   const { error: subscriptionError } = await supabase
      .from("subscriptions")
      .insert([{ user_id: userId, plan_type: "free" }]);

   if (subscriptionError) {
      return res.status(400).json({ error: subscriptionError.message });
   }

   return res.status(201).json({ message: "✅ User created successfully", userId });
});


// ✅ تسجيل الدخول
router.post("/login", async (req, res) => {
   const { email, password } = req.body;

   if (!email || !password) {
      return res.status(400).json({ error: "Email and password are required" });
   }

   try {
      // تسجيل الدخول
      const { data: sessionData, error: signInError } = await supabase.auth.signInWithPassword({
         email,
         password,
      });

      if (signInError) {
         return res.status(401).json({ error: signInError.message });
      }

      const user = sessionData.user;
      const session = sessionData.session;

      // جلب نوع الاشتراك
      const { data: subscriptionData } = await supabase
         .from("subscriptions")
         .select("plan_type")
         .eq("user_id", user.id)
         .single();

      return res.status(200).json({
         message: "✅ Login successful",
         user,
         access_token: session.access_token,
         refresh_token: session.refresh_token,
         plan: subscriptionData?.plan_type || "free",
      });
   } catch (err) {
      console.error("Login error:", err.message);
      return res.status(500).json({ error: "Unexpected server error. Try again." });
   }
});

// ✅ تحديث الـ access_token باستخدام refresh_token
router.post("/refresh", async (req, res) => {
   const { refresh_token } = req.body;

   if (!refresh_token) {
      return res.status(400).json({ error: "Refresh token is required" });
   }

   try {
      const { data: refreshedSession, error: refreshError } = await supabase.auth.refreshSession({ refresh_token });

      if (refreshError) {
         return res.status(401).json({ error: refreshError.message });
      }

      return res.status(200).json({
         access_token: refreshedSession.session.access_token,
         refresh_token: refreshedSession.session.refresh_token,
         user: refreshedSession.session.user,
      });
   } catch (err) {
      console.error("Error refreshing token:", err);
      return res.status(500).json({ error: "Server error" });
   }
});


module.exports = router;
