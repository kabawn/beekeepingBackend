const express = require("express");
const router = express.Router();

// For now: public ping (no auth) just to test dashboard can reach backend
router.get("/ping", (req, res) => {
  res.json({ ok: true, message: "admin api is alive" });
});

module.exports = router;
