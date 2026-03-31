const PLAN_ENTITLEMENTS = {
   free: {
      plan: "free",
      features: {
         apiaries: {
            enabled: true,
            max: 1,
         },
         hives: {
            enabled: true,
            max: 10,
         },
         queens: {
            enabled: true,
         },
         exports: {
            enabled: false,
         },
         advancedAnalytics: {
            enabled: false,
         },
         weather: {
            enabled: true,
         },
         flora: {
            enabled: true,
         },
         varroa: {
            enabled: true,
         },
      },
   },

   premium: {
      plan: "premium",
      features: {
         apiaries: {
            enabled: true,
            max: null,
         },
         hives: {
            enabled: true,
            max: null,
         },
         queens: {
            enabled: true,
         },
         exports: {
            enabled: true,
         },
         advancedAnalytics: {
            enabled: true,
         },
         weather: {
            enabled: true,
         },
         flora: {
            enabled: true,
         },
         varroa: {
            enabled: true,
         },
      },
   },
};

function getEntitlementsForPlan(plan) {
   return PLAN_ENTITLEMENTS[plan] || PLAN_ENTITLEMENTS.free;
}

module.exports = {
   PLAN_ENTITLEMENTS,
   getEntitlementsForPlan,
};
