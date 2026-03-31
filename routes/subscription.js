const express = require("express");
const authenticateUser = require("../middlewares/authMiddleware");
const { getUserPlan, getUserEntitlements } = require("../services/subscriptionService");
const router = express.Router();

router.get("/me/plan", authenticateUser, async (req, res) => {
   try {
      const result = await getUserPlan(req.user.id);
      return res.json(result);
   } catch (error) {
      console.error("GET /me/plan error:", error);
      return res.status(500).json({ error: "Failed to get user plan" });
   }
});

router.get("/me/entitlements", authenticateUser, async (req, res) => {
   try {
      const result = await getUserEntitlements(req.user.id);
      return res.json(result);
   } catch (error) {
      console.error("GET /me/entitlements error:", error);
      return res.status(500).json({ error: "Failed to get user entitlements" });
   }
});

module.exports = router;
