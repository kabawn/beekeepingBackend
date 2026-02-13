const express = require("express");
const router = express.Router();
const supabase = require("../utils/supabaseClient");

router.get("/env", async (req, res) => {
  const url = process.env.SUPABASE_URL || "";
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY || "";

  // اختبار بسيط هل PostgREST يقبل المفتاح
  const { data, error } = await supabase
    .from("hives")
    .select("hive_id")
    .limit(1);

  return res.json({
    hasUrl: !!url,
    urlPrefix: url.slice(0, 35) + "...",
    hasServiceRoleKey: !!key,
    keyLen: key.length,
    canSelectHives: !error,
    selectError: error?.message || null,
  });
});

module.exports = router;
