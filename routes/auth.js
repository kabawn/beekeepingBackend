// routes/auth.js
const express = require("express");
const router = express.Router();
const supabase = require("../utils/supabaseClient");

/* ------------------------- Helpers ------------------------- */
function mapLoginError(err) {
   const raw = String(err?.message || "").toLowerCase();
   const status = err?.status;

   // ✅ Wrong email/password (don’t leak which one)
   if (
      raw.includes("invalid login credentials") ||
      raw.includes("invalid credentials") ||
      raw.includes("invalid email or password")
   ) {
      return {
         http: 401,
         code: "INVALID_CREDENTIALS",
         message: "Invalid email or password.",
      };
   }

   // ✅ Email not confirmed
   if (
      raw.includes("email not confirmed") ||
      raw.includes("confirm your email") ||
      raw.includes("email confirmation")
   ) {
      return {
         http: 403,
         code: "EMAIL_NOT_CONFIRMED",
         message: "Please verify your email address before logging in.",
      };
   }

   // ✅ Rate limit / too many attempts
   if (status === 429 || raw.includes("too many requests") || raw.includes("rate limit")) {
      return {
         http: 429,
         code: "TOO_MANY_ATTEMPTS",
         message: "Too many attempts. Please try again in a few minutes.",
      };
   }

   // ✅ Unknown auth 400/401 -> still show generic message
   if (status === 400 || status === 401) {
      return {
         http: 401,
         code: "INVALID_CREDENTIALS",
         message: "Invalid email or password.",
      };
   }

   // Default (don’t expose internals)
   return {
      http: 500,
      code: "LOGIN_FAILED",
      message: "Unable to log in right now. Please try again.",
   };
}

/* ------------------------- Signup ------------------------- */
router.post("/signup", async (req, res) => {
   const { email, password, full_name } = req.body;

   if (!email || !password || !full_name) {
      return res.status(400).json({
         error: {
            code: "MISSING_FIELDS",
            message: "email, password and full_name are required",
         },
      });
   }

   // 1) Create user
   const { data: userData, error: signUpError } = await supabase.auth.admin.createUser({
      email,
      password,
      email_confirm: true,
   });

   if (signUpError) {
      return res.status(400).json({
         error: {
            code: "SIGNUP_FAILED",
            message: signUpError.message,
         },
      });
   }

   const userId = userData.user.id;

   // 2) Insert profile
   const { error: profileError } = await supabase
      .from("user_profiles")
      .insert([{ user_id: userId, full_name }]);

   if (profileError) {
      return res.status(400).json({
         error: {
            code: "PROFILE_CREATE_FAILED",
            message: profileError.message,
         },
      });
   }

   // 3) Create free subscription
   const { error: subscriptionError } = await supabase
      .from("subscriptions")
      .insert([{ user_id: userId, plan_type: "free" }]);

   if (subscriptionError) {
      return res.status(400).json({
         error: {
            code: "SUBSCRIPTION_CREATE_FAILED",
            message: subscriptionError.message,
         },
      });
   }

   return res.status(201).json({ message: "✅ User created successfully", userId });
});

/* ------------------------- Login ------------------------- */
router.post("/login", async (req, res) => {
   const { email, password } = req.body;

   if (!email || !password) {
      return res.status(400).json({
         error: {
            code: "MISSING_FIELDS",
            message: "Email and password are required.",
         },
      });
   }

   try {
      // 1) Sign in
      const { data: sessionData, error: signInError } = await supabase.auth.signInWithPassword({
         email,
         password,
      });

      if (signInError) {
         const clean = mapLoginError(signInError);
         return res.status(clean.http).json({ error: clean });
      }

      const user = sessionData.user;
      const session = sessionData.session;

      // 2) Get plan type
      const { data: subscriptionData, error: subErr } = await supabase
         .from("subscriptions")
         .select("plan_type")
         .eq("user_id", user.id)
         .single();

      if (subErr) console.warn("subscription fetch error:", subErr.message);

      // 3) Get full_name from user_profiles
      const { data: profileData, error: profileErr } = await supabase
         .from("user_profiles")
         .select("full_name")
         .eq("user_id", user.id)
         .single();

      if (profileErr) console.warn("profile fetch error:", profileErr.message);

      // 4) Return clean payload
      return res.status(200).json({
         message: "✅ Login successful",
         user: {
            ...user,
            full_name: profileData?.full_name || null,
         },
         access_token: session.access_token,
         refresh_token: session.refresh_token,
         plan: subscriptionData?.plan_type || "free",
      });
   } catch (err) {
      console.error("Login error:", err);
      return res.status(500).json({
         error: {
            code: "SERVER_ERROR",
            message: "Unexpected server error. Try again.",
         },
      });
   }
});

/* ------------------------- Forgot password ------------------------- */
router.post("/forgot-password", async (req, res) => {
   const { email } = req.body;

   if (!email) {
      return res.status(400).json({
         error: {
            code: "MISSING_EMAIL",
            message: "Email is required",
         },
      });
   }

   try {
      const { error } = await supabase.auth.resetPasswordForEmail(email, {
         redirectTo: "bstats://reset-password",
      });

      // For security, don’t reveal if email exists or not
      if (error) {
         console.error("🔴 Forgot-password Supabase error:", error);
         // still return generic success if you want maximum privacy:
         // return res.status(200).json({ message: "✅ If this email exists, a reset link has been sent." });
         return res.status(400).json({
            error: {
               code: "FORGOT_PASSWORD_FAILED",
               message: error.message,
            },
         });
      }

      return res.status(200).json({
         message: "✅ If this email exists, a reset link has been sent.",
      });
   } catch (err) {
      console.error("Forgot-password server error:", err);
      return res.status(500).json({
         error: {
            code: "SERVER_ERROR",
            message: "Server error while sending reset email",
         },
      });
   }
});

/* ------------------------- Reset password ------------------------- */
router.post("/reset-password", async (req, res) => {
   const { access_token, new_password } = req.body;

   if (!access_token || !new_password) {
      return res.status(400).json({
         error: {
            code: "MISSING_FIELDS",
            message: "access_token and new_password are required",
         },
      });
   }

   try {
      // 1) Get the user from the recovery access token
      const { data: userData, error: getUserError } = await supabase.auth.getUser(access_token);

      if (getUserError || !userData?.user) {
         console.error("🔴 getUser error:", getUserError);
         return res.status(400).json({
            error: {
               code: "INVALID_OR_EXPIRED_TOKEN",
               message: "Invalid or expired recovery token",
            },
         });
      }

      const userId = userData.user.id;

      // 2) Update password via admin API
      const { error: updateError } = await supabase.auth.admin.updateUserById(userId, {
         password: new_password,
      });

      if (updateError) {
         console.error("🔴 updateUserById error:", updateError);
         return res.status(400).json({
            error: {
               code: "PASSWORD_UPDATE_FAILED",
               message: updateError.message,
            },
         });
      }

      return res.status(200).json({
         message: "✅ Password updated successfully",
      });
   } catch (err) {
      console.error("🔴 reset-password server error:", err);
      return res.status(500).json({
         error: {
            code: "SERVER_ERROR",
            message: "Server error while resetting password",
         },
      });
   }
});

/* ------------------------- Refresh token ------------------------- */
router.post("/refresh", async (req, res) => {
   const { refresh_token } = req.body;

   if (!refresh_token) {
      return res.status(400).json({
         error: {
            code: "MISSING_REFRESH_TOKEN",
            message: "Refresh token is required",
         },
      });
   }

   try {
      const { data, error: refreshError } = await supabase.auth.refreshSession({ refresh_token });

      if (refreshError) {
         console.error("🔴 Supabase refresh error:", refreshError);
         return res.status(401).json({
            error: {
               code: "REFRESH_FAILED",
               message: "Session expired. Please log in again.",
            },
         });
      }

      const { session, user } = data || {};

      if (!session) {
         console.error("🔴 No session in refresh response:", data);
         return res.status(500).json({
            error: {
               code: "NO_SESSION_RETURNED",
               message: "No session returned by Supabase",
            },
         });
      }

      console.log("🔄 REFRESH DEBUG:", {
         in_refresh_token: refresh_token?.slice(0, 12) + "...",
         out_refresh_token: session.refresh_token
            ? session.refresh_token.slice(0, 12) + "..."
            : null,
      });

      return res.status(200).json({
         access_token: session.access_token,
         // if Supabase doesn't send a new one, reuse the old
         refresh_token: session.refresh_token || refresh_token,
         user,
      });
   } catch (err) {
      console.error("Error refreshing token:", err);
      return res.status(500).json({
         error: {
            code: "SERVER_ERROR",
            message: "Server error",
         },
      });
   }
});

module.exports = router;
