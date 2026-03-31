const supabase = require("../utils/supabaseClient");
const { getEntitlementsForPlan } = require("./entitlements");

async function getUserSubscription(userId) {
  if (!userId) {
    throw new Error("userId is required");
  }

  const { data, error } = await supabase
    .from("subscriptions")
    .select("id, user_id, plan_type, is_active, started_at, expires_at")
    .eq("user_id", userId)
    .single();

  if (error) {
    throw error;
  }

  return data;
}

async function getUserPlan(userId) {
  const subscription = await getUserSubscription(userId);

  if (!subscription) {
    return {
      plan: "free",
      isActive: false,
      subscription: null,
    };
  }

  const now = new Date();
  const expiresAt = subscription.expires_at ? new Date(subscription.expires_at) : null;
  const isExpired = expiresAt ? expiresAt < now : false;
  const isReallyActive = subscription.is_active === true && !isExpired;

  return {
    plan: isReallyActive ? subscription.plan_type : "free",
    isActive: isReallyActive,
    subscription,
  };
}

async function getUserEntitlements(userId) {
  const { plan, isActive, subscription } = await getUserPlan(userId);
  const entitlements = getEntitlementsForPlan(plan);

  return {
    plan,
    isActive,
    subscription,
    entitlements,
  };
}

module.exports = {
  getUserSubscription,
  getUserPlan,
  getUserEntitlements,
};