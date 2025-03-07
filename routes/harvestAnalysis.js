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
        SUM( (har.full_weight - s.weight_empty) ) AS total_honey
      FROM harvests AS har
      JOIN supers AS s ON har.super_id = s.id
      JOIN hives AS h ON s.hive_id = h.id
      GROUP BY h.id, h.hive_identifier
      ORDER BY total_honey DESC;
    `;
      const result = await pool.query(query);
      res.json(result.rows);
   } catch (error) {
      console.error("Error in harvest analysis by hive:", error);
      res.status(500).json({ error: "Server error while fetching harvest analysis by hive" });
   }
});

// GET harvest analysis by apiary
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
      JOIN apiaries AS a ON h.apiary_id = a.id  -- Join with apiaries table
      GROUP BY h.id, h.hive_identifier, a.name
      ORDER BY total_honey DESC;
    `;

      const result = await pool.query(query);

      console.log("Fetched Hive Data with Apiary:", result.rows); // Debugging log
      res.json(result.rows);
   } catch (error) {
      console.error("Error in harvest analysis by hive:", error);
      res.status(500).json({ error: "Server error while fetching harvest analysis by hive" });
   }
});


module.exports = router;
