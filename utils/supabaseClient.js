// utils/supabaseClient.js
const { createClient } = require("@supabase/supabase-js");
require("dotenv").config();

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY, {
   auth: {
      autoRefreshToken: false, // 🔴 stop background refresh on the server
      persistSession: false, // 🔴 don't keep any session in memory
      detectSessionInUrl: false,
   },
});

module.exports = supabase;
