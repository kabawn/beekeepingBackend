// routes/swarmProduction.js
const express = require("express");
const router = express.Router();
const pool = require("../db");
const authenticateUser = require("../middlewares/authMiddleware");

// How many days until laying check, depending on intro type
const INTRO_DELAY_DAYS = {
   cell: 21, // cellule royale
   virgin: 12, // reine vierge
   mated: 7, // reine fécondée
};

// 🔹 Helper: check that apiary belongs to user (uses ONLY apiary_id)
async function assertApiaryOwnership(apiaryIdParam, userId) {
   const apiaryId = parseInt(apiaryIdParam, 10);
   console.log("🟣 assertApiaryOwnership", { apiaryIdParam, apiaryId, userId });

   if (!Number.isInteger(apiaryId)) {
      const err = new Error("Invalid apiary id");
      err.status = 400;
      throw err;
   }

   const { rows } = await pool.query(
      `SELECT apiary_id
       FROM apiaries
       WHERE apiary_id = $1
         AND owner_user_id = $2`,
      [apiaryId, userId]
   );

   console.log("🟣 assertApiaryOwnership rows:", rows);

   if (!rows.length) {
      const err = new Error("Apiary not found or not yours");
      err.status = 404;
      throw err;
   }

   return rows[0].apiary_id; // always the real apiary_id
}

// 🔹 Helper: get a swarm session by id + check user
async function getUserSessionById(sessionIdParam, userId) {
   const sessionId = parseInt(sessionIdParam, 10);
   console.log("🟣 getUserSessionById", { sessionIdParam, sessionId, userId });

   if (!Number.isInteger(sessionId)) {
      const err = new Error("Invalid swarm session id");
      err.status = 400;
      throw err;
   }

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

// 🔹 POST /swarm/sessions  → start a swarm session on an apiary
router.post("/sessions", authenticateUser, async (req, res) => {
   const userId = req.user.id;
   const { apiary_id, label } = req.body || {};
   console.log("🟢 [POST /swarm/sessions]", { userId, apiary_id, label });

   if (!apiary_id) {
      return res.status(400).json({ error: "apiary_id is required" });
   }

   try {
      const resolvedApiaryId = await assertApiaryOwnership(apiary_id, userId);

      // Close any other active session on this apiary
      await pool.query(
         `UPDATE swarm_sessions
          SET is_active = FALSE, ended_at = now(), updated_at = now()
          WHERE apiary_id = $1 AND is_active = TRUE AND ended_at IS NULL`,
         [resolvedApiaryId]
      );

      // ⚠️ Only use owner_user_id if this column exists in your table
      const { rows } = await pool.query(
         `INSERT INTO swarm_sessions (
            owner_user_id, apiary_id, label
          )
          VALUES ($1, $2, $3)
          RETURNING *`,
         [userId, resolvedApiaryId, label || null]
      );

      console.log("🟢 [POST /swarm/sessions] created:", rows[0]);

      return res.status(201).json(rows[0]);
   } catch (err) {
      console.error("🔴 POST /swarm/sessions error:", err);
      return res.status(err.status || 500).json({ error: err.message || "Server error" });
   }
});

// 🔹 POST /swarm/sessions/:sessionId/scan  → add hive to this swarm session
// Body can be:
//   { "hive_id": 22 }
// or
//   { "hive_public_key": "e26add9c-..." }
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
      // 1) Make sure session belongs to this user
      const session = await getUserSessionById(sessionId, userId);

      if (!session.is_active || session.ended_at) {
         return res.status(400).json({ error: "Session is not active" });
      }

      const apiaryId = session.apiary_id;

      // 2) Resolve hive_id
      let resolvedHiveId = hive_id || null;

      if (!resolvedHiveId && hive_public_key) {
         // 🔍 Resolve by public_key + enforce owner + SAME APIARY
         const { rows: hiveRows } = await pool.query(
            `SELECT h.hive_id
             FROM hives h
             JOIN apiaries a ON a.apiary_id = h.apiary_id
             WHERE h.public_key = $1
               AND h.apiary_id = $2         
               AND a.owner_user_id = $3`,
            [hive_public_key, apiaryId, userId]
         );

         if (!hiveRows.length) {
            return res
               .status(404)
               .json({ error: "Hive not found in this apiary for this user (public_key)." });
         }

         resolvedHiveId = hiveRows[0].hive_id;
      }

      // If we got hive_id directly from frontend, still enforce owner + apiary
      if (resolvedHiveId) {
         const { rows: hiveCheck } = await pool.query(
            `SELECT h.hive_id
             FROM hives h
             JOIN apiaries a ON a.apiary_id = h.apiary_id
             WHERE h.hive_id = $1
               AND h.apiary_id = $2        -- same apiary as the session
               AND a.owner_user_id = $3`,
            [resolvedHiveId, apiaryId, userId]
         );

         if (!hiveCheck.length) {
            return res.status(404).json({
               error: "Hive not found in this apiary for this user (invalid hive_id).",
            });
         }
      }

      if (!resolvedHiveId) {
         return res.status(400).json({ error: "Could not resolve hive_id" });
      }

      // 3) Insert colony
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

      // 4) Add event: scan_arrival
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

      console.log("🟢 [SCAN] colony created:", colony);

      return res.status(201).json(colony);
   } catch (err) {
      console.error("🔴 POST /swarm/sessions/:sessionId/scan error:", err);

      if (err.code === "23503" && err.constraint === "swarm_colonies_hive_fk") {
         return res.status(400).json({
            error: "This hive does not exist in your database (invalid hive_id).",
         });
      }

      return res.status(err.status || 500).json({ error: err.message || "Server error" });
   }
});

// POST /swarm/sessions/:sessionId/introductions
// Body: { type: "cell" | "virgin" | "mated", date? }
router.post("/sessions/:sessionId/introductions", authenticateUser, async (req, res) => {
   const userId = req.user.id;
   const { sessionId } = req.params;
   const { type, date } = req.body || {};

   console.log("🟢 [POST /swarm/sessions/:sessionId/introductions]", {
      userId,
      sessionId,
      type,
      date,
   });

   const allowedTypes = ["cell", "virgin", "mated"];
   if (!allowedTypes.includes(type)) {
      return res.status(400).json({ error: "Invalid type. Must be 'cell', 'virgin' or 'mated'." });
   }

   const delayDays = INTRO_DELAY_DAYS[type];
   if (!delayDays) {
      return res.status(500).json({ error: "No delay configured for this type." });
   }

   try {
      // 1️⃣ Check session belongs to this user and is active
      const session = await getUserSessionById(sessionId, userId);

      if (!session.is_active || session.ended_at) {
         return res.status(400).json({ error: "Session is not active" });
      }

      const apiaryId = session.apiary_id;

      // 2️⃣ Get ALL colonies in this session that are still pending
      const { rows: colonies } = await pool.query(
         `SELECT swarm_colony_id
          FROM swarm_colonies
          WHERE swarm_session_id = $1
            AND owner_user_id = $2
            AND status = 'pending'`,
         [session.swarm_session_id, userId]
      );

      if (!colonies.length) {
         return res.status(400).json({
            error: "No pending colonies found for this session.",
         });
      }

      const eventDate = date ? new Date(date) : new Date();

      const results = [];

      for (const row of colonies) {
         const colId = row.swarm_colony_id;

         // 3.a) Insert event
         const eventType =
            type === "cell" ? "intro_cell" : type === "virgin" ? "intro_virgin" : "intro_mated";

         await pool.query(
            `INSERT INTO swarm_events (
               owner_user_id,
               swarm_colony_id,
               event_type,
               event_date,
               payload
            )
            VALUES ($1, $2, $3, $4, $5)`,
            [userId, colId, eventType, eventDate, JSON.stringify({ type })]
         );

         // 3.b) Update colony status → waiting_check
         await pool.query(
            `UPDATE swarm_colonies
             SET status = 'waiting_check'
             WHERE swarm_colony_id = $1`,
            [colId]
         );

         // 3.c) Create alert: check_laying at eventDate + delayDays
         const planned = new Date(eventDate);
         planned.setDate(planned.getDate() + delayDays);

         await pool.query(
            `INSERT INTO swarm_alerts (
               owner_user_id,
               apiary_id,
               swarm_colony_id,
               alert_type,
               planned_for,
               is_done
            )
            VALUES ($1, $2, $3, 'check_laying', $4, FALSE)`,
            [userId, apiaryId, colId, planned]
         );

         results.push({ swarm_colony_id: colId });
      }

      console.log("🟢 Introductions applied to colonies:", results.length);

      return res.json({
         ok: true,
         count: results.length,
         colonies: results,
      });
   } catch (err) {
      console.error("🔴 POST /swarm/sessions/:sessionId/introductions error:", err);
      return res.status(err.status || 500).json({ error: err.message || "Server error" });
   }
});

// PATCH /swarm/colonies/:colonyId/status
router.patch("/colonies/:colonyId/status", authenticateUser, async (req, res) => {
   const userId = req.user.id;
   const { colonyId } = req.params;
   const { status } = req.body || {};

   // allowed statuses
   const allowed = ["pending", "laying_ok", "failed", "queenless", "dead"];
   if (!status || !allowed.includes(status)) {
      return res.status(400).json({ error: "Invalid status" });
   }

   try {
      // 1) Check colony belongs to this user
      const { rows: colRows } = await pool.query(
         `SELECT c.swarm_colony_id, c.apiary_id
          FROM swarm_colonies c
          JOIN apiaries a ON a.apiary_id = c.apiary_id
          WHERE c.swarm_colony_id = $1
            AND a.owner_user_id = $2`,
         [colonyId, userId]
      );

      if (!colRows.length) {
         return res.status(404).json({ error: "Colony not found" });
      }

      // 2) Update colony status
      const { rows: updatedRows } = await pool.query(
         `UPDATE swarm_colonies
          SET status = $1,
              updated_at = now()
          WHERE swarm_colony_id = $2
          RETURNING *`,
         [status, colonyId]
      );

      const colony = updatedRows[0];

      // 3) Optionally close the check_laying alert (if exists)
      await pool.query(
         `UPDATE swarm_alerts
          SET is_done = TRUE,
              done_at = now(),
              updated_at = now()
          WHERE swarm_colony_id = $1
            AND alert_type = 'check_laying'
            AND is_done = FALSE`,
         [colonyId]
      );

      return res.json({ ok: true, colony });
   } catch (err) {
      console.error("🔴 PATCH /swarm/colonies/:colonyId/status error:", err);
      return res.status(500).json({ error: "Server error" });
   }
});

// 🔹 GET /swarm/sessions/:sessionId  → session + colonies + stats
router.get("/sessions/:sessionId", authenticateUser, async (req, res) => {
   const userId = req.user.id;
   const { sessionId } = req.params;

   console.log("🟢 [GET /swarm/sessions/:sessionId]", { userId, sessionId });

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
      console.error("🔴 GET /swarm/sessions/:sessionId error:", err);
      return res.status(err.status || 500).json({ error: err.message || "Server error" });
   }
});

// PATCH /swarm/sessions/:sessionId/end  → close an active swarm session
router.patch("/sessions/:sessionId/end", authenticateUser, async (req, res) => {
   const userId = req.user.id;
   const { sessionId } = req.params;

   console.log("🟢 [PATCH /swarm/sessions/:sessionId/end]", { userId, sessionId });

   try {
      // 1️⃣ Check session belongs to this user
      const session = await getUserSessionById(sessionId, userId);

      // 2️⃣ Already ended?
      if (!session.is_active || session.ended_at) {
         return res
            .status(400)
            .json({ error: "This swarm session is already closed or inactive." });
      }

      // 3️⃣ Close the session
      const { rows } = await pool.query(
         `UPDATE swarm_sessions
          SET is_active = FALSE,
              ended_at = now(),
              updated_at = now()
          WHERE swarm_session_id = $1
          RETURNING *`,
         [sessionId]
      );

      const closed = rows[0];
      console.log("🟢 Swarm session ended:", closed.swarm_session_id);

      // (optional TODO later: close related open alerts, etc.)

      return res.json({ ok: true, session: closed });
   } catch (err) {
      console.error("🔴 PATCH /swarm/sessions/:sessionId/end error:", err);
      return res.status(err.status || 500).json({ error: err.message || "Server error" });
   }
});

// POST /swarm/colonies/:colonyId/reintroductions
// Body: { type: "cell" | "virgin" | "mated", date? }
router.post("/colonies/:colonyId/reintroductions", authenticateUser, async (req, res) => {
   const userId = req.user.id;
   const { colonyId } = req.params;
   const { type, date } = req.body || {};

   console.log("🟢 [POST /swarm/colonies/:colonyId/reintroductions]", {
      userId,
      colonyId,
      type,
      date,
   });

   const allowedTypes = ["cell", "virgin", "mated"];
   if (!allowedTypes.includes(type)) {
      return res.status(400).json({ error: "Invalid type. Must be 'cell', 'virgin' or 'mated'." });
   }

   const delayDays = INTRO_DELAY_DAYS[type];
   if (!delayDays) {
      return res.status(500).json({ error: "No delay configured for this type." });
   }

   try {
      // 1️⃣ Check colony belongs to user and get apiary_id + current status
      const { rows: colRows } = await pool.query(
         `SELECT c.swarm_colony_id, c.apiary_id, c.status
          FROM swarm_colonies c
          JOIN apiaries a ON a.apiary_id = c.apiary_id
          WHERE c.swarm_colony_id = $1
            AND a.owner_user_id = $2`,
         [colonyId, userId]
      );

      if (!colRows.length) {
         return res.status(404).json({ error: "Colony not found" });
      }

      const colony = colRows[0];

      // we only allow re-intro on failed / queenless
      if (!["failed", "queenless"].includes(colony.status)) {
         return res.status(400).json({
            error: "Re-introduction is only allowed for failed or queenless colonies.",
         });
      }

      const apiaryId = colony.apiary_id;
      const eventDate = date ? new Date(date) : new Date();

      // 2️⃣ Insert event (we can reuse same event types but mark reintro in payload)
      const eventType =
         type === "cell" ? "intro_cell" : type === "virgin" ? "intro_virgin" : "intro_mated";

      await pool.query(
         `INSERT INTO swarm_events (
            owner_user_id,
            swarm_colony_id,
            event_type,
            event_date,
            payload
         )
         VALUES ($1, $2, $3, $4, $5)`,
         [userId, colonyId, eventType, eventDate, JSON.stringify({ type, reintroduction: true })]
      );

      // 3️⃣ Update colony back to waiting_check
      const { rows: updatedRows } = await pool.query(
         `UPDATE swarm_colonies
          SET status = 'waiting_check',
              updated_at = now()
          WHERE swarm_colony_id = $1
          RETURNING *`,
         [colonyId]
      );

      const updatedColony = updatedRows[0];

      // 4️⃣ New alert : check_laying in (delayDays)
      const planned = new Date(eventDate);
      planned.setDate(planned.getDate() + delayDays);

      const { rows: alertRows } = await pool.query(
         `INSERT INTO swarm_alerts (
            owner_user_id,
            apiary_id,
            swarm_colony_id,
            alert_type,
            planned_for,
            is_done
         )
         VALUES ($1, $2, $3, 'check_laying', $4, FALSE)
         RETURNING *`,
         [userId, apiaryId, colonyId, planned]
      );

      return res.json({
         ok: true,
         colony: updatedColony,
         alert: alertRows[0],
      });
   } catch (err) {
      console.error("🔴 POST /swarm/colonies/:colonyId/reintroductions error:", err);
      return res.status(500).json({ error: "Server error" });
   }
});

// 🔹 GET /swarm/apiaries/:apiaryId/active  → get active session (or null) for an apiary
router.get("/apiaries/:apiaryId/active", authenticateUser, async (req, res) => {
   const userId = req.user.id;
   const { apiaryId } = req.params;

   console.log("🟢 [GET /swarm/apiaries/:apiaryId/active]", { apiaryId, userId });

   try {
      const resolvedApiaryId = await assertApiaryOwnership(apiaryId, userId);

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
         [resolvedApiaryId, userId]
      );

      const session = rows[0] || null;

      if (!session) {
         console.log("🟢 No active swarm session for apiary:", resolvedApiaryId);
         return res.json({ session: null }); // 200 with null
      }

      console.log("🟢 Active swarm session found:", session.swarm_session_id);
      return res.json({ session });
   } catch (err) {
      console.error("🔴 GET /swarm/apiaries/:apiaryId/active error:", err);
      return res.status(err.status || 500).json({ error: err.message || "Server error" });
   }
});

module.exports = router;
