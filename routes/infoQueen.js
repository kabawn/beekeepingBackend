const express = require("express");
const router = express.Router();
const supabase = require("../utils/supabaseClient");
const authenticateUser = require("../middlewares/authMiddleware");

// routes/infoQueen.js
router.get("/", authenticateUser, async (req, res) => {
   try {
      const { data, error } = await supabase.from("info_queen").select("*");
      if (error) return res.status(400).json({ error: error.message });
      res.status(200).json({ options: data });
   } catch (err) {
      console.error("Fetch info_queen error:", err);
      res.status(500).json({ error: "Unexpected server error" });
   }
});

module.exports = router;
