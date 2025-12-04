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

// ✅ Forgot password – send reset email
// ✅ Forgot password – send reset email
router.post("/forgot-password", async (req, res) => {
   const { email } = req.body;

   if (!email) {
      return res.status(400).json({ error: "Email is required" });
   }

   try {
      const { data, error } = await supabase.auth.resetPasswordForEmail(email, {
         // 👇 Deep link to your app – we'll handle this in the app
         redirectTo: "exp+beestats://reset-password",
      });

      if (error) {
         console.error("🔴 Forgot-password Supabase error:", error);
         return res.status(400).json({ error: error.message });
      }

      return res.status(200).json({
         message: "✅ If this email exists, a reset link has been sent.",
      });
   } catch (err) {
      console.error("Forgot-password server error:", err);
      return res.status(500).json({ error: "Server error while sending reset email" });
   }
});

// ✅ Reset password using access_token from Supabase recovery link
// ✅ Reset password using access_token from Supabase recovery link
router.post("/reset-password", async (req, res) => {
   const { access_token, new_password } = req.body;

   if (!access_token || !new_password) {
      return res.status(400).json({ error: "access_token and new_password are required" });
   }

   try {
      // 1️⃣ Get the user from the recovery access token
      const { data: userData, error: getUserError } = await supabase.auth.getUser(access_token);

      if (getUserError || !userData?.user) {
         console.error("🔴 getUser error:", getUserError);
         return res.status(400).json({ error: "Invalid or expired recovery token" });
      }

      const userId = userData.user.id;

      // 2️⃣ Update the password via admin API
      const { data: updatedUser, error: updateError } = await supabase.auth.admin.updateUserById(
         userId,
         {
            password: new_password,
         }
      );

      if (updateError) {
         console.error("🔴 updateUserById error:", updateError);
         return res.status(400).json({ error: updateError.message });
      }

      return res.status(200).json({
         message: "✅ Password updated successfully",
      });
   } catch (err) {
      console.error("🔴 reset-password server error:", err);
      return res.status(500).json({ error: "Server error while resetting password" });
   }
});

// ✅ تحديث الـ access_token باستخدام refresh_token
// ✅ تحديث الـ access_token باستخدام refresh_token
router.post("/refresh", async (req, res) => {
   const { refresh_token } = req.body;

   if (!refresh_token) {
      return res.status(400).json({ error: "Refresh token is required" });
   }

   try {
      const { data, error: refreshError } = await supabase.auth.refreshSession({ refresh_token });

      if (refreshError) {
         console.error("🔴 Supabase refresh error:", refreshError);
         return res.status(401).json({ error: refreshError.message });
      }

      const { session, user } = data || {};

      if (!session) {
         console.error("🔴 No session in refresh response:", data);
         return res.status(500).json({ error: "No session returned by Supabase" });
      }

      console.log("🔄 REFRESH DEBUG:", {
         in_refresh_token: refresh_token?.slice(0, 12) + "...",
         out_refresh_token: session.refresh_token
            ? session.refresh_token.slice(0, 12) + "..."
            : null,
      });

      return res.status(200).json({
         access_token: session.access_token,
         // 👇 if Supabase doesn't send a new one, reuse the old
         refresh_token: session.refresh_token || refresh_token,
         user,
      });
   } catch (err) {
      console.error("Error refreshing token:", err);
      return res.status(500).json({ error: "Server error" });
   }
});

module.exports = router;
