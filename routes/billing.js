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

   console.log("======== SYNC REVENUECAT START ========");
   console.log("User ID:", userId);
   console.log("Body:", req.body);

   try {
      if (!product_id) {
         console.log("❌ ERROR: product_id missing");
         return res.status(400).json({
            error: "product_id is required",
         });
      }

      if (product_id !== "beestats_premium_monthly") {
         console.log("❌ ERROR: Unknown product_id:", product_id);
         return res.status(400).json({
            error: "Unknown product_id",
         });
      }

      const now = new Date();
      const expiresAt = new Date(now);
      expiresAt.setMonth(expiresAt.getMonth() + 1);

      console.log("⏳ Updating subscription...");
      console.log("New values:", {
         plan_type: "premium",
         started_at: now,
         expires_at: expiresAt,
      });

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

      console.log("📊 UPDATE RESULT rows:", result.rows.length);

      if (result.rows.length === 0) {
         console.log("❌ ERROR: No subscription row found for user:", userId);
         return res.status(404).json({
            error: "Subscription row not found for this user",
         });
      }

      console.log("✅ UPDATED SUBSCRIPTION:", result.rows[0]);

      const entitlements = await getUserEntitlements(userId);

      console.log("🎯 ENTITLEMENTS AFTER UPDATE:", entitlements);

      console.log("======== SYNC REVENUECAT SUCCESS ========");

      return res.json({
         message: "Subscription synced successfully",
         subscription: result.rows[0],
         entitlements,
      });
   } catch (error) {
      console.error("🔥 SYNC ERROR:", error);
      console.log("======== SYNC REVENUECAT FAILED ========");

      return res.status(500).json({
         error: "Failed to sync RevenueCat subscription",
      });
   }
});

router.post("/webhook/revenuecat", async (req, res) => {
   try {
      const authHeader = req.headers["authorization"];

      if (authHeader !== `Bearer ${process.env.REVENUECAT_WEBHOOK_SECRET}`) {
         return res.status(401).json({ error: "Unauthorized webhook" });
      }

      const event = req.body?.event;

      if (!event) {
         return res.status(400).json({ error: "Missing event payload" });
      }

      const {
         type,
         app_user_id,
         product_id,
         transaction_id,
         original_transaction_id,
         expiration_at_ms,
      } = event;

      if (!app_user_id) {
         return res.status(400).json({ error: "Missing app_user_id" });
      }

      const expiresAt = expiration_at_ms ? new Date(Number(expiration_at_ms)) : null;
      const now = new Date();

      // لاحقًا لو أضفت أكثر من منتج، هنا توسع الـ mapping
      const isPremiumProduct = product_id === "beestats_premium_monthly";

      if (!isPremiumProduct) {
         return res.status(200).json({ message: "Ignored non-premium product" });
      }

      if (type === "INITIAL_PURCHASE" || type === "RENEWAL") {
         const result = await pool.query(
            `
            UPDATE subscriptions
            SET
               plan_type = 'premium',
               is_active = TRUE,
               provider = 'google',
               provider_product_id = $1,
               provider_transaction_id = $2,
               status = 'active',
               auto_renew = TRUE,
               started_at = COALESCE(started_at, $3),
               expires_at = $4,
               last_verified_at = $3
            WHERE user_id = $5
            RETURNING *
            `,
            [
               product_id,
               transaction_id || original_transaction_id || null,
               now,
               expiresAt,
               app_user_id,
            ],
         );

         return res.status(200).json({
            message: `${type} processed`,
            subscription: result.rows[0] || null,
         });
      }

      if (type === "CANCELLATION") {
         const result = await pool.query(
            `
            UPDATE subscriptions
            SET
               provider = 'google',
               provider_product_id = $1,
               provider_transaction_id = $2,
               status = 'canceled',
               auto_renew = FALSE,
               last_verified_at = $3,
               expires_at = COALESCE($4, expires_at)
            WHERE user_id = $5
            RETURNING *
            `,
            [
               product_id,
               transaction_id || original_transaction_id || null,
               now,
               expiresAt,
               app_user_id,
            ],
         );

         return res.status(200).json({
            message: "CANCELLATION processed",
            subscription: result.rows[0] || null,
         });
      }

      if (type === "EXPIRATION") {
         const result = await pool.query(
            `
            UPDATE subscriptions
            SET
               plan_type = 'free',
               is_active = FALSE,
               provider = 'google',
               provider_product_id = $1,
               provider_transaction_id = $2,
               status = 'expired',
               auto_renew = FALSE,
               last_verified_at = $3,
               expires_at = COALESCE($4, expires_at)
            WHERE user_id = $5
            RETURNING *
            `,
            [
               product_id,
               transaction_id || original_transaction_id || null,
               now,
               expiresAt,
               app_user_id,
            ],
         );

         return res.status(200).json({
            message: "EXPIRATION processed",
            subscription: result.rows[0] || null,
         });
      }

      return res.status(200).json({
         message: `Ignored event type: ${type}`,
      });
   } catch (error) {
      console.error("POST /billing/webhook/revenuecat error:", error);
      return res.status(500).json({
         error: "Failed to process RevenueCat webhook",
      });
   }
});
module.exports = router;
