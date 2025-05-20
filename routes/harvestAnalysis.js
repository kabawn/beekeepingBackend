// routes/harvestAnalysis.js
const express = require("express");
const router = express.Router();
const pool = require("../db");
const authenticateUser = require("../middlewares/authMiddleware");

// GET harvest analysis by hive
// GET harvest analysis by hive (restricted to authenticated user)
// GET harvest analysis by hive (filtered by apiary owner)
router.get("/by-hive", authenticateUser, async (req, res) => {
   const userId = req.user.id;

   try {
      const query = `
        SELECT 
          h.hive_id,
          h.hive_code AS hive_identifier,
          a.apiary_name,
          SUM(har.full_weight - s.weight_empty) AS total_honey
        FROM harvests AS har
        JOIN supers AS s ON har.super_id = s.super_id
        JOIN hives AS h ON s.hive_id = h.hive_id
        JOIN apiaries AS a ON h.apiary_id = a.apiary_id
        WHERE a.owner_user_id = $1
        GROUP BY h.hive_id, h.hive_code, a.apiary_name
        ORDER BY total_honey DESC;
      `;

      const result = await pool.query(query, [userId]);
      res.json(result.rows);
   } catch (error) {
      console.error("❌ Error in harvest analysis by hive:", error);
      res.status(500).json({ error: "Server error while fetching harvest analysis by hive" });
   }
});

// GET harvest analysis by apiary
// Example in harvestAnalysis.js
// GET harvest analysis by apiary (restricted to authenticated user)
router.get("/by-apiary", authenticateUser, async (req, res) => {
   const userId = req.user.id;

   try {
      const query = `
        SELECT 
          a.apiary_id, 
          a.apiary_name, 
          SUM(har.full_weight - s.weight_empty) AS total_honey,
          AVG(har.full_weight - s.weight_empty) AS avg_honey_per_hive
        FROM apiaries a
        JOIN hives h ON a.apiary_id = h.apiary_id
        JOIN supers s ON h.hive_id = s.hive_id
        JOIN harvests har ON s.super_id = har.super_id
        WHERE a.owner_user_id = $1
        GROUP BY a.apiary_id, a.apiary_name
        ORDER BY total_honey DESC;
      `;

      const result = await pool.query(query, [userId]);
      res.json(result.rows);
   } catch (error) {
      console.error("❌ Error in harvest analysis by apiary:", error);
      res.status(500).json({ error: "Server error while fetching harvest analysis by apiary" });
   }
});

module.exports = router;
