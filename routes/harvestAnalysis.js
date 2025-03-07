// routes/harvestAnalysis.js
const express = require("express");
const router = express.Router();
const pool = require("../db");

// GET harvest analysis by hive
router.get("/by-hive", async (req, res) => {
   try {
      const query = `
      SELECT 
        h.id AS hive_id,
        h.hive_identifier,
        a.name AS apiary_name,  -- Fetch apiary name
        SUM(har.full_weight - s.weight_empty) AS total_honey
      FROM harvests AS har
      JOIN supers AS s ON har.super_id = s.id
      JOIN hives AS h ON s.hive_id = h.id
      LEFT JOIN apiaries AS a ON h.apiary_id = a.id  -- Ensure LEFT JOIN to include missing data
      GROUP BY h.id, h.hive_identifier, a.name
      ORDER BY total_honey DESC;
    `;

      const result = await pool.query(query);

      console.log("🔹 API Query Result:", result.rows);  // 🚨 Log the fetched data
      res.json(result.rows);
   } catch (error) {
      console.error("❌ Error in harvest analysis by hive:", error);
      res.status(500).json({ error: "Server error while fetching harvest analysis by hive" });
   }
});


// GET harvest analysis by apiary
// Example in harvestAnalysis.js
router.get("/by-apiary", async (req, res) => {
   try {
      const query = `
        SELECT 
          a.id AS apiary_id, 
          a.name AS apiary_name, 
          SUM(hst.full_weight - s.weight_empty) AS total_honey,
          AVG(hst.full_weight - s.weight_empty) AS avg_honey_per_hive
        FROM apiaries a
        JOIN hives h ON a.id = h.apiary_id
        JOIN supers s ON h.id = s.hive_id
        JOIN harvests hst ON s.id = hst.super_id
        GROUP BY a.id, a.name
        ORDER BY total_honey DESC;
      `;
      const result = await pool.query(query);
      res.json(result.rows);
   } catch (error) {
      console.error("Error in harvest analysis by apiary:", error);
      res.status(500).json({ error: "Server error during harvest analysis" });
   }
});


module.exports = router;
