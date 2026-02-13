// routes/diag.js
const express = require("express");
const router = express.Router();
const supabase = require("../utils/supabaseClient");

// ✅ IMPORTANT: this endpoint MUST NOT require auth
// It's only for debugging infra/env + DB reachability.
// Remove it after you finish debugging.

router.get("/", async (req, res) => {
   // generate trace id to correlate in logs
   const traceId =
      req.headers["x-request-id"] ||
      req.headers["x-railway-request-id"] ||
      `${Date.now()}-${Math.random().toString(16).slice(2)}`;

   // try a simple DB ping
   let canSelectHives = false;
   let selectError = null;

   try {
      const { data, error } = await supabase.from("hives").select("hive_id").limit(1);

      if (error) {
         selectError = error.message;
      } else {
         canSelectHives = true;
      }
   } catch (e) {
      selectError = e?.message || String(e);
   }

   // set headers so you can see which instance answered
   res.setHeader("x-instance", process.env.RAILWAY_REPLICA_ID || process.env.HOSTNAME || "unknown");
   res.setHeader("x-commit", process.env.RAILWAY_GIT_COMMIT_SHA || "unknown");
   res.setHeader("x-trace-id", traceId);

   return res.json({
      traceId,
      now: new Date().toISOString(),

      // instance / deploy fingerprint
      instance: process.env.RAILWAY_REPLICA_ID || process.env.HOSTNAME || null,
      commit: process.env.RAILWAY_GIT_COMMIT_SHA || null,

      // env sanity (no secrets)
      hasUrl: !!process.env.SUPABASE_URL,
      urlPrefix: process.env.SUPABASE_URL ? process.env.SUPABASE_URL.slice(0, 32) + "..." : null,
      hasServiceRoleKey: !!process.env.SUPABASE_SERVICE_ROLE_KEY,
      keyLen: process.env.SUPABASE_SERVICE_ROLE_KEY
         ? process.env.SUPABASE_SERVICE_ROLE_KEY.length
         : 0,

      // DB ping result
      canSelectHives,
      selectError,
   });
});

module.exports = router;
