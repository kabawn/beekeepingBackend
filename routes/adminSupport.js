const express = require("express");
const { createClient } = require("@supabase/supabase-js");

const router = express.Router();

// Service role key ONLY in backend
const supabaseAdmin = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);

// Optional simple protection (recommended) — set ADMIN_SUPPORT_SECRET in .env
router.post("/support/fix-email-and-reset", async (req, res) => {
   try {
      // 🔐 Simple protection (optional but recommended)
      const secret = process.env.ADMIN_SUPPORT_SECRET;
      if (secret) {
         const got = req.headers["x-admin-secret"];
         if (got !== secret) {
            return res.status(401).json({ ok: false, error: "Unauthorized" });
         }
      }

      const { userId, newEmail } = req.body;
      if (!userId || !newEmail) {
         return res.status(400).json({ ok: false, error: "userId and newEmail are required" });
      }

      // 1) Update Auth email
      const { data: updated, error: updateErr } = await supabaseAdmin.auth.admin.updateUserById(
         userId,
         {
            email: newEmail,
            email_confirm: true,
         },
      );

      if (updateErr) {
         return res.status(400).json({ ok: false, error: updateErr.message });
      }

      // 2) Send reset password email
      const { error: resetErr } = await supabaseAdmin.auth.resetPasswordForEmail(newEmail, {
         redirectTo: "beestats://reset-password",
      });

      if (resetErr) {
         return res.status(400).json({ ok: false, error: resetErr.message });
      }

      return res.json({ ok: true, user: updated.user });
   } catch (e) {
      return res.status(500).json({ ok: false, error: e.message });
   }
});

router.post("/support/set-temp-password", async (req, res) => {
   try {
      const { userId, newPassword } = req.body;

      if (!userId || !newPassword) {
         return res.status(400).json({ ok: false, error: "userId and newPassword are required" });
      }

      const { data, error } = await supabaseAdmin.auth.admin.updateUserById(userId, {
         password: newPassword,
      });

      if (error) {
         return res.status(400).json({ ok: false, error: error.message });
      }

      return res.json({ ok: true, message: "Password updated successfully" });
   } catch (e) {
      return res.status(500).json({ ok: false, error: e.message });
   }
});

module.exports = router;
