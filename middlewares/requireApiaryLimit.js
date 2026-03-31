const { getUserEntitlements } = require("../services/subscriptionService");
const { countUserApiaries } = require("../services/usageService");

async function requireApiaryLimit(req, res, next) {
  try {
    const userId = req.user?.id;

    if (!userId) {
      return res.status(401).json({
        error: "Unauthorized",
      });
    }

    const result = await getUserEntitlements(userId);
    const apiariesFeature = result?.entitlements?.features?.apiaries;

    if (!apiariesFeature || apiariesFeature.enabled !== true) {
      return res.status(403).json({
        code: "APIARIES_NOT_AVAILABLE",
        message: "Apiaries feature is not available in your current plan.",
      });
    }

    const max = apiariesFeature.max;

    if (max === null) {
      req.entitlements = result.entitlements;
      req.subscription = result.subscription;
      req.plan = result.plan;
      return next();
    }

    const currentCount = await countUserApiaries(userId);

    if (currentCount >= max) {
      return res.status(403).json({
        code: "APIARY_LIMIT_REACHED",
        message: "You have reached the maximum number of apiaries allowed in your current plan.",
        limit: max,
        currentCount,
        plan: result.plan,
      });
    }

    req.entitlements = result.entitlements;
    req.subscription = result.subscription;
    req.plan = result.plan;

    next();
  } catch (error) {
    console.error("requireApiaryLimit error:", error);
    return res.status(500).json({
      error: "Failed to verify apiary limit",
    });
  }
}

module.exports = requireApiaryLimit;