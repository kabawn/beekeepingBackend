// routes/swarmProduction.js
const express = require("express");
const router = express.Router();
const pool = require("../db");
const authenticateUser = require("../middlewares/authMiddleware");

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
// Body: { type: "cell" | "virgin" | "mated", date?, delay_days }
router.post("/sessions/:sessionId/introductions", authenticateUser, async (req, res) => {
   const userId = req.user.id;
   const { sessionId } = req.params;
   const { type, date, delay_days } = req.body || {};

   console.log("🟢 [POST /swarm/sessions/:sessionId/introductions]", {
      userId,
      sessionId,
      type,
      date,
      delay_days,
   });

   const allowedTypes = ["cell", "virgin", "mated"];
   if (!allowedTypes.includes(type)) {
      return res.status(400).json({ error: "Invalid type. Must be 'cell', 'virgin' or 'mated'." });
   }

   const delayDays = parseInt(delay_days, 10);
   if (!Number.isInteger(delayDays) || delayDays < 1 || delayDays > 60) {
      return res.status(400).json({
         error: "Invalid delay_days. It must be an integer between 1 and 60 days.",
      });
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
            [userId, colId, eventType, eventDate, JSON.stringify({ type, delay_days: delayDays })]
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
       h.hive_purpose,
       a.planned_for,
       (a.planned_for::date - NOW()::date) AS days_to_check,

       -- 🟣 queen info (alive queen on this hive)
       q.queen_id,
       q.queen_code,
       q.source_type,
       q.source_cell_lot,
       q.grafting_date,
       q.public_key AS queen_public_key

    FROM swarm_colonies c
    JOIN hives h 
      ON h.hive_id = c.hive_id

    LEFT JOIN swarm_alerts a
      ON a.swarm_colony_id = c.swarm_colony_id
     AND a.alert_type = 'check_laying'
     AND a.is_done = FALSE

    LEFT JOIN queens q
      ON q.hive_id = h.hive_id
     AND q.is_alive = TRUE      -- only current queen
     AND q.owner_user_id = $2   -- safety: same owner

    WHERE c.swarm_session_id = $1
    ORDER BY c.started_at DESC`,
         [sessionId, userId]
      );

      // 🧮 Build stats
      const baseStats = colonies.reduce(
         (acc, col) => {
            acc.total += 1;
            acc.by_status[col.status] = (acc.by_status[col.status] || 0) + 1;
            return acc;
         },
         { total: 0, by_status: {} }
      );

      const success = baseStats.by_status["laying_ok"] || 0;
      const failures =
         (baseStats.by_status["failed"] || 0) +
         (baseStats.by_status["queenless"] || 0) +
         (baseStats.by_status["dead"] || 0);
      const waiting = baseStats.by_status["waiting_check"] || 0;
      const pending = baseStats.by_status["pending"] || 0;

      const success_rate =
         baseStats.total > 0 ? Math.round(100 * (success / baseStats.total) * 10) / 10 : 0;

      const stats = {
         total: baseStats.total,
         by_status: baseStats.by_status,
         success,
         failures,
         waiting,
         pending,
         success_rate,
      };

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

      return res.json({ ok: true, session: closed });
   } catch (err) {
      console.error("🔴 PATCH /swarm/sessions/:sessionId/end error:", err);
      return res.status(err.status || 500).json({ error: err.message || "Server error" });
   }
});

// POST /swarm/colonies/:colonyId/reintroductions
// Body: { type: "cell" | "virgin" | "mated", date?, delay_days }
router.post("/colonies/:colonyId/reintroductions", authenticateUser, async (req, res) => {
   const userId = req.user.id;
   const { colonyId } = req.params;
   const { type, date, delay_days } = req.body || {};

   console.log("🟢 [POST /swarm/colonies/:colonyId/reintroductions]", {
      userId,
      colonyId,
      type,
      date,
      delay_days,
   });

   const allowedTypes = ["cell", "virgin", "mated"];
   if (!allowedTypes.includes(type)) {
      return res.status(400).json({ error: "Invalid type. Must be 'cell', 'virgin' or 'mated'." });
   }

   const delayDays = parseInt(delay_days, 10);
   if (!Number.isInteger(delayDays) || delayDays < 1 || delayDays > 60) {
      return res.status(400).json({
         error: "Invalid delay_days. It must be an integer between 1 and 60 days.",
      });
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
         [
            userId,
            colonyId,
            eventType,
            eventDate,
            JSON.stringify({ type, reintroduction: true, delay_days: delayDays }),
         ]
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

// 🔹 GET /swarm/alerts/upcoming?days=14
// Returns upcoming laying-check alerts for this user (and a bit of late ones)
router.get("/alerts/upcoming", authenticateUser, async (req, res) => {
   const userId = req.user.id;
   const daysAhead = Number(req.query.days) || 14; // how far in future
   const daysPast = 7; // how far in the past we still show late alerts

   console.log("🟢 [GET /swarm/alerts/upcoming]", { userId, daysAhead, daysPast });

   try {
      const { rows } = await pool.query(
         `
         SELECT 
            sa.swarm_alert_id,
            sa.alert_type,
            sa.planned_for,
            a.apiary_id,
            a.apiary_name,
            c.swarm_colony_id,
            h.hive_id,
            h.hive_code,
            h.hive_type,
            h.hive_purpose,
            (sa.planned_for::date - now()::date) AS days_to_check
         FROM swarm_alerts sa
         JOIN apiaries a       ON a.apiary_id = sa.apiary_id
         JOIN swarm_colonies c ON c.swarm_colony_id = sa.swarm_colony_id
         JOIN hives h          ON h.hive_id = c.hive_id
         WHERE sa.owner_user_id = $1
           AND sa.alert_type = 'check_laying'
           AND sa.is_done = FALSE
           AND sa.planned_for::date >= (now()::date - $3 * INTERVAL '1 day')
           AND sa.planned_for::date <= (now()::date + $2 * INTERVAL '1 day')
         ORDER BY sa.planned_for ASC, a.apiary_name, h.hive_code
         `,
         [userId, daysAhead, daysPast]
      );

      console.log("🟢 [GET /swarm/alerts/upcoming] rows =", rows);
      return res.json({ alerts: rows });
   } catch (err) {
      console.error("🔴 GET /swarm/alerts/upcoming error:", err);
      return res.status(500).json({ error: "Server error" });
   }
});

// 🔹 GET /swarm/stats/overview?from=2025-01-01&to=2025-12-31&apiary_id=79 (optional)
router.get("/stats/overview", authenticateUser, async (req, res) => {
   const userId = req.user.id;
   const { from, to, apiary_id } = req.query;

   const today = new Date().toISOString().slice(0, 10);
   const fromDate = from || "2025-01-01"; // you can change this later
   const toDate = to || today;

   try {
      // 1️⃣ Global stats
      const globalSql = `
      SELECT
        COUNT(*) AS total_colonies,
        COUNT(*) FILTER (WHERE c.status = 'laying_ok') AS success,
        COUNT(*) FILTER (WHERE c.status IN ('failed','queenless','dead')) AS failures
      FROM swarm_colonies c
      JOIN swarm_sessions s ON s.swarm_session_id = c.swarm_session_id
      WHERE s.owner_user_id = $1
        AND s.started_at::date BETWEEN $2 AND $3
        ${apiary_id ? "AND c.apiary_id = $4" : ""}
    `;

      const globalParams = apiary_id
         ? [userId, fromDate, toDate, apiary_id]
         : [userId, fromDate, toDate];

      const { rows: globalRows } = await pool.query(globalSql, globalParams);
      const g = globalRows[0] || { total_colonies: 0, success: 0, failures: 0 };

      const globalSuccessRate =
         g.total_colonies > 0 ? Math.round(100 * (g.success / g.total_colonies) * 10) / 10 : 0;

      // 2️⃣ Stats by intro type (cell / virgin / mated)
      const introSql = `
      SELECT
        e.payload->>'type' AS intro_type,
        COUNT(DISTINCT c.swarm_colony_id) AS total_colonies,
        COUNT(DISTINCT c.swarm_colony_id) FILTER (WHERE c.status = 'laying_ok') AS success
      FROM swarm_events e
      JOIN swarm_colonies c ON c.swarm_colony_id = e.swarm_colony_id
      JOIN swarm_sessions s ON s.swarm_session_id = c.swarm_session_id
      WHERE e.owner_user_id = $1
        AND e.event_type IN ('intro_cell','intro_virgin','intro_mated')
        AND e.event_date::date BETWEEN $2 AND $3
        ${apiary_id ? "AND c.apiary_id = $4" : ""}
      GROUP BY intro_type
      ORDER BY intro_type;
    `;

      const { rows: introRows } = await pool.query(introSql, globalParams);

      const byIntro = introRows.map((r) => {
         const total = Number(r.total_colonies);
         const success = Number(r.success);
         const success_rate = total > 0 ? Math.round(100 * (success / total) * 10) / 10 : 0;

         return {
            intro_type: r.intro_type, // 'cell' | 'virgin' | 'mated'
            total,
            success,
            success_rate,
         };
      });

      // 3️⃣ Stats by apiary (only if not filtering by one apiary)
      let byApiary = [];

      if (!apiary_id) {
         const apiarySql = `
        SELECT
          c.apiary_id,
          a.apiary_name,
          COUNT(*) AS total_colonies,
          COUNT(*) FILTER (WHERE c.status = 'laying_ok') AS success
        FROM swarm_colonies c
        JOIN apiaries a ON a.apiary_id = c.apiary_id
        JOIN swarm_sessions s ON s.swarm_session_id = c.swarm_session_id
        WHERE s.owner_user_id = $1
          AND s.started_at::date BETWEEN $2 AND $3
        GROUP BY c.apiary_id, a.apiary_name
        ORDER BY a.apiary_name;
      `;

         const { rows } = await pool.query(apiarySql, [userId, fromDate, toDate]);
         byApiary = rows.map((r) => {
            const total = Number(r.total_colonies);
            const success = Number(r.success);
            const success_rate = total > 0 ? Math.round(100 * (success / total) * 10) / 10 : 0;

            return {
               apiary_id: r.apiary_id,
               apiary_name: r.apiary_name,
               total,
               success,
               success_rate,
            };
         });
      }

      return res.json({
         period: { from: fromDate, to: toDate, apiary_id: apiary_id || null },
         global: {
            total_colonies: Number(g.total_colonies || 0),
            success: Number(g.success || 0),
            failures: Number(g.failures || 0),
            success_rate: globalSuccessRate,
         },
         by_intro_type: byIntro,
         by_apiary: byApiary,
      });
   } catch (err) {
      console.error("🔴 GET /swarm/stats/overview error:", err);
      return res.status(500).json({ error: "Server error" });
   }
});

module.exports = router;
