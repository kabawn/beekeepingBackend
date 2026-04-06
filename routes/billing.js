const express = require("express");
const router = express.Router();
const pool = require("../db");
const authenticateUser = require("../middlewares/authMiddleware");
const { getUserEntitlements } = require("../services/subscriptionService");

const PREMIUM_PRODUCT_ID = "beestats_premium_monthly";
const GOOGLE_PROVIDER = "google";

function addOneMonth(date = new Date()) {
   const d = new Date(date);
   d.setMonth(d.getMonth() + 1);
   return d;
}

// ----------------------------------------------------
// Fallback sync after successful RevenueCat purchase
// ----------------------------------------------------
router.post("/sync-revenuecat", authenticateUser, async (req, res) => {
   const userId = req.user.id;
   const { product_id } = req.body;

   try {
      if (!product_id) {
         return res.status(400).json({
            error: "product_id is required",
         });
      }

      if (product_id !== PREMIUM_PRODUCT_ID) {
         return res.status(400).json({
            error: "Unknown product_id",
         });
      }

      const now = new Date();
      const expiresAt = addOneMonth(now);

      const result = await pool.query(
         `
         UPDATE subscriptions
         SET
            plan_type = 'premium',
            is_active = TRUE,
            started_at = $1,
            expires_at = $2,
            provider = $3,
            provider_product_id = $4,
            status = 'active',
            auto_renew = TRUE,
            last_verified_at = $1
         WHERE user_id = $5
         RETURNING *
         `,
         [now, expiresAt, GOOGLE_PROVIDER, product_id, userId],
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

// ----------------------------------------------------
// RevenueCat webhook
// ----------------------------------------------------
router.post("/webhook/revenuecat", async (req, res) => {
   try {
      const authHeader = req.headers["authorization"];
      const expectedAuthHeader = `Bearer ${process.env.REVENUECAT_WEBHOOK_SECRET}`;

      if (!process.env.REVENUECAT_WEBHOOK_SECRET) {
         console.error("REVENUECAT_WEBHOOK_SECRET is missing");
         return res.status(500).json({ error: "Webhook secret is not configured" });
      }

      if (authHeader !== expectedAuthHeader) {
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

      if (product_id !== PREMIUM_PRODUCT_ID) {
         return res.status(200).json({ message: "Ignored non-premium product" });
      }

      const now = new Date();
      const expiresAt = expiration_at_ms ? new Date(Number(expiration_at_ms)) : null;
      const providerTransactionId = transaction_id || original_transaction_id || null;

      if (type === "INITIAL_PURCHASE" || type === "RENEWAL") {
         const result = await pool.query(
            `
            UPDATE subscriptions
            SET
               plan_type = 'premium',
               is_active = TRUE,
               provider = $1,
               provider_product_id = $2,
               provider_transaction_id = $3,
               status = 'active',
               auto_renew = TRUE,
               started_at = COALESCE(started_at, $4),
               expires_at = $5,
               last_verified_at = $4
            WHERE user_id = $6
            RETURNING *
            `,
            [GOOGLE_PROVIDER, product_id, providerTransactionId, now, expiresAt, app_user_id],
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
               provider = $1,
               provider_product_id = $2,
               provider_transaction_id = $3,
               status = 'canceled',
               auto_renew = FALSE,
               last_verified_at = $4,
               expires_at = COALESCE($5, expires_at)
            WHERE user_id = $6
            RETURNING *
            `,
            [GOOGLE_PROVIDER, product_id, providerTransactionId, now, expiresAt, app_user_id],
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
               provider = $1,
               provider_product_id = $2,
               provider_transaction_id = $3,
               status = 'expired',
               auto_renew = FALSE,
               last_verified_at = $4,
               expires_at = COALESCE($5, expires_at)
            WHERE user_id = $6
            RETURNING *
            `,
            [GOOGLE_PROVIDER, product_id, providerTransactionId, now, expiresAt, app_user_id],
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
