const supabase = require("../utils/supabaseClient");

async function countUserApiaries(userId) {
  if (!userId) {
    throw new Error("userId is required");
  }

  const { count, error } = await supabase
    .from("apiaries")
    .select("*", { count: "exact", head: true })
    .eq("owner_user_id", userId);

  if (error) {
    throw error;
  }

  return count || 0;
}

module.exports = {
  countUserApiaries,
};