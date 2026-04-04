const express = require("express");
const router = express.Router();
const pool = require("../db");
const authenticateUser = require("../middlewares/authMiddleware");
const { getUserEntitlements } = require("../services/subscriptionService");

const PRODUCT_PLAN_MAP = {
   beestats_premium_monthly: "premium",
};

function addOneMonth(date = new Date()) {
   const d = new Date(date);
   d.setMonth(d.getMonth() + 1);
   return d;
}

router.post("/verify", authenticateUser, async (req, res) => {
   const userId = req.user.id;
   const { provider, product_id, transaction_id } = req.body;

   try {
      // 1) basic validation
      if (!provider || !product_id || !transaction_id) {
         return res.status(400).json({
            error: "provider, product_id, and transaction_id are required",
         });
      }

      if (!["apple", "google"].includes(provider)) {
         return res.status(400).json({
            error: "provider must be either 'apple' or 'google'",
         });
      }

      const planType = PRODUCT_PLAN_MAP[product_id];

      if (!planType) {
         return res.status(400).json({
            error: "Unknown product_id",
         });
      }

      const now = new Date();
      const expiresAt = addOneMonth(now);

      // 2) update subscription
      const result = await pool.query(
         `
         UPDATE subscriptions
         SET
            plan_type = $1,
            is_active = TRUE,
            started_at = $2,
            expires_at = $3,
            provider = $4,
            provider_product_id = $5,
            provider_transaction_id = $6,
            status = 'active',
            auto_renew = TRUE,
            last_verified_at = $2
         WHERE user_id = $7
         RETURNING *
         `,
         [planType, now, expiresAt, provider, product_id, transaction_id, userId],
      );

      if (result.rows.length === 0) {
         return res.status(404).json({
            error: "Subscription not found for this user",
         });
      }

      // 3) return fresh entitlements
      const entitlements = await getUserEntitlements(userId);

      return res.json({
         message: "Subscription verified successfully",
         subscription: result.rows[0],
         entitlements,
      });
   } catch (error) {
      console.error("POST /billing/verify error:", error);
      return res.status(500).json({
         error: "Failed to verify subscription",
      });
   }
});

router.post("/sync-revenuecat", authenticateUser, async (req, res) => {
   const userId = req.user.id;
   const { product_id } = req.body;

   try {
      if (!product_id) {
         return res.status(400).json({
            error: "product_id is required",
         });
      }

      if (product_id !== "beestats_premium_monthly") {
         return res.status(400).json({
            error: "Unknown product_id",
         });
      }

      const now = new Date();
      const expiresAt = new Date(now);
      expiresAt.setMonth(expiresAt.getMonth() + 1);

      const result = await pool.query(
         `
         UPDATE subscriptions
         SET
            plan_type = 'premium',
            is_active = TRUE,
            started_at = $1,
            expires_at = $2,
            provider = 'google',
            provider_product_id = $3,
            status = 'active',
            auto_renew = TRUE,
            last_verified_at = $1
         WHERE user_id = $4
         RETURNING *
         `,
         [now, expiresAt, product_id, userId],
      );

      if (result.rows.length === 0) {
         return res.status(404).json({
            error: "Subscription row not found for this user",
         });
      }

      const entitlements = await getUserEntitlements(userId);

      return res.json({
         message: "Subscription synced successfully",
         subscription: result.rows[0],
         entitlements,
      });
   } catch (error) {
      console.error("POST /billing/sync-revenuecat error:", error);
      return res.status(500).json({
         error: "Failed to sync RevenueCat subscription",
      });
   }
});

module.exports = router;