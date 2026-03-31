const { getUserEntitlements } = require("../services/subscriptionService");

function requireFeature(featureKey) {
  return async (req, res, next) => {
    try {
      const userId = req.user?.id;

      if (!userId) {
        return res.status(401).json({
          error: "Unauthorized",
        });
      }

      const result = await getUserEntitlements(userId);
      const feature = result?.entitlements?.features?.[featureKey];

      if (!feature || feature.enabled !== true) {
        return res.status(403).json({
          code: "FEATURE_NOT_AVAILABLE",
          feature: featureKey,
          message: `The feature '${featureKey}' is not available in your current plan.`,
        });
      }

      req.entitlements = result.entitlements;
      req.subscription = result.subscription;
      req.plan = result.plan;

      next();
    } catch (error) {
      console.error("requireFeature error:", error);
      return res.status(500).json({
        error: "Failed to verify feature access",
      });
    }
  };
}

module.exports = requireFeature;