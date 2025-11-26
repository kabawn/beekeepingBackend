// routes/swarmProduction.js
const express = require("express");
const router = express.Router();
const pool = require("../db");
const authenticateUser = require("../middlewares/authMiddleware");

// Helper: check that apiary belongs to user
async function assertApiaryOwnership(apiaryId, userId) {
   const { rows } = await pool.query(
      `SELECT apiary_id
       FROM apiaries
       WHERE apiary_id = $1 AND owner_user_id = $2`,
      [apiaryId, userId]
   );
   if (!rows.length) {
      const err = new Error("Apiary not found or not yours");
      err.status = 404;
      throw err;
   }
}

// Helper: get a session by id + user check
async function getUserSessionById(sessionId, userId) {
   const { rows } = await pool.query(
      `SELECT s.*
       FROM swarm_sessions s
       JOIN apiaries a ON a.apiary_id = s.apiary_id
       WHERE s.swarm_session_id = $1
         AND a.owner_user_id = $2`,
      [sessionId, userId]
   );
   if (!rows.length) {
      const err = new Error("Swarm session not found");
      err.status = 404;
      throw err;
   }
   return rows[0];
}

// POST /swarm/sessions
router.post("/sessions", authenticateUser, async (req, res) => {
   const userId = req.user.id;
   const { apiary_id, label } = req.body || {};
   console.log("🟢 [POST /swarm/sessions] user:", userId, "apiary:", apiary_id, "label:", label);

   if (!apiary_id) {
      return res.status(400).json({ error: "apiary_id is required" });
   }

   try {
      await assertApiaryOwnership(apiary_id, userId);

      // Optional: automatically close any other active session on this apiary
      await pool.query(
         `UPDATE swarm_sessions
          SET is_active = FALSE, ended_at = now(), updated_at = now()
          WHERE apiary_id = $1 AND is_active = TRUE AND ended_at IS NULL`,
         [apiary_id]
      );

      const { rows } = await pool.query(
         `INSERT INTO swarm_sessions (
            owner_user_id, apiary_id, label
          )
          VALUES ($1, $2, $3)
          RETURNING *`,
         [userId, apiary_id, label || null]
      );

      return res.status(201).json(rows[0]);
   } catch (err) {
      console.error("POST /swarm/sessions error:", err);
      return res.status(err.status || 500).json({ error: err.message || "Server error" });
   }
});

// POST /swarm/sessions/:sessionId/scan
// Body can be:
//   { "hive_id": 22 }
// or
//   { "hive_public_key": "e26add9c-..." }
router.post("/sessions/:sessionId/scan", authenticateUser, async (req, res) => {
   const userId = req.user.id;
   const { sessionId } = req.params;
   const { hive_id, hive_public_key } = req.body || {};

   console.log("🟢 [POST /swarm/sessions/:sessionId/scan]", {
      userId,
      sessionId,
      hive_id,
      hive_public_key,
   });

   if (!hive_id && !hive_public_key) {
      return res.status(400).json({ error: "You must provide hive_id or hive_public_key" });
   }

   try {
      const session = await getUserSessionById(sessionId, userId);

      if (!session.is_active || session.ended_at) {
         return res.status(400).json({ error: "Session is not active" });
      }

      const apiaryId = session.apiary_id;

      // 🔍 Resolve hive_id if we only have hive_public_key
      let resolvedHiveId = hive_id || null;

      if (!resolvedHiveId && hive_public_key) {
         const { rows: hiveRows } = await pool.query(
            `SELECT h.hive_id
             FROM hives h
             JOIN apiaries a ON a.apiary_id = h.apiary_id
             WHERE h.public_key = $1
               AND a.owner_user_id = $2`,
            [hive_public_key, userId]
         );

         if (!hiveRows.length) {
            return res.status(404).json({ error: "Hive not found for this public_key" });
         }

         resolvedHiveId = hiveRows[0].hive_id;
      }

      if (!resolvedHiveId) {
         return res.status(400).json({ error: "Could not resolve hive_id" });
      }

      // Insert colony
      const { rows: colonyRows } = await pool.query(
         `INSERT INTO swarm_colonies (
            owner_user_id,
            swarm_session_id,
            apiary_id,
            hive_id,
            status
          )
          VALUES ($1, $2, $3, $4, 'pending')
          RETURNING *`,
         [userId, sessionId, apiaryId, resolvedHiveId]
      );

      const colony = colonyRows[0];

      // Add event: scan_arrival
      await pool.query(
         `INSERT INTO swarm_events (
            owner_user_id,
            swarm_colony_id,
            event_type,
            payload
          )
          VALUES ($1, $2, 'scan_arrival', $3)`,
         [
            userId,
            colony.swarm_colony_id,
            JSON.stringify({
               hive_id: resolvedHiveId,
               hive_public_key: hive_public_key || null,
            }),
         ]
      );

      return res.status(201).json(colony);
   } catch (err) {
      console.error("POST /swarm/sessions/:sessionId/scan error:", err);
      return res.status(err.status || 500).json({ error: err.message || "Server error" });
   }
});

// GET /swarm/sessions/:sessionId
// GET /swarm/sessions/:sessionId
router.get("/sessions/:sessionId", authenticateUser, async (req, res) => {
   const userId = req.user.id;
   const { sessionId } = req.params;

   try {
      const session = await getUserSessionById(sessionId, userId);

      const { rows: colonies } = await pool.query(
         `SELECT 
             c.*,
             h.hive_code,
             h.hive_type,
             h.hive_purpose
          FROM swarm_colonies c
          JOIN hives h ON h.hive_id = c.hive_id
          WHERE c.swarm_session_id = $1
          ORDER BY c.started_at DESC`,
         [sessionId]
      );

      // Small stats by status
      const stats = colonies.reduce(
         (acc, col) => {
            acc.total += 1;
            acc.by_status[col.status] = (acc.by_status[col.status] || 0) + 1;
            return acc;
         },
         { total: 0, by_status: {} }
      );

      return res.json({ session, colonies, stats });
   } catch (err) {
      console.error("GET /swarm/sessions/:sessionId error:", err);
      return res.status(err.status || 500).json({ error: err.message || "Server error" });
   }
});

// GET /swarm/apiaries/:apiaryId/active
router.get("/apiaries/:apiaryId/active", authenticateUser, async (req, res) => {
   const userId = req.user.id;
   const { apiaryId } = req.params;

   try {
      await assertApiaryOwnership(apiaryId, userId);

      const { rows } = await pool.query(
         `SELECT s.*
          FROM swarm_sessions s
          JOIN apiaries a ON a.apiary_id = s.apiary_id
          WHERE s.apiary_id = $1
            AND a.owner_user_id = $2
            AND s.is_active = TRUE
            AND s.ended_at IS NULL
          ORDER BY s.started_at DESC
          LIMIT 1`,
         [apiaryId, userId]
      );

      const session = rows[0] || null;

      if (!session) {
         return res.json({ session: null });
      }

      // Optionally fetch colonies + stats directly here (but for clarity, frontend will call /sessions/:id)
      return res.json({ session });
   } catch (err) {
      console.error("GET /swarm/apiaries/:apiaryId/active error:", err);
      return res.status(err.status || 500).json({ error: err.message || "Server error" });
   }
});


module.exports = router;
