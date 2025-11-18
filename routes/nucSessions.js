// routes/nucSessions.js
const express = require("express");
const router = express.Router();
const supabase = require("../utils/supabaseClient");
const authenticateUser = require("../middlewares/authMiddleware");

const ADD_DAYS = (d, days) => {
   const x = new Date(d);
   x.setUTCDate(x.getUTCDate() + days);
   return x.toISOString();
};

router.use(authenticateUser);

/**
 * POST /api/nuc-sessions
 * body: { apiary_id, started_at?, label?, notes? }
 * -> Create a new swarm-production session in an apiary
 */
router.post("/", async (req, res) => {
   const { apiary_id, started_at, label, notes } = req.body || {};
   if (!apiary_id) return res.status(400).json({ error: "apiary_id is required" });

   try {
      const { data, error } = await supabase
         .from("nuc_sessions")
         .insert([
            {
               apiary_id,
               started_at: started_at || new Date().toISOString(),
               label: label || null,
               notes: notes || null,
            },
         ])
         .select()
         .single();

      if (error) return res.status(400).json({ error: error.message });

      return res.status(201).json({ ok: true, session: data });
   } catch (e) {
      console.error("❌ Error creating nuc session:", e);
      return res.status(500).json({ error: "Unexpected server error" });
   }
});

/**
 * GET /api/nuc-sessions/by-apiary/:apiaryId
 * -> List sessions for an apiary (latest first)
 */
router.get("/by-apiary/:apiaryId", async (req, res) => {
   const apiary_id = Number(req.params.apiaryId);
   if (!apiary_id) return res.status(400).json({ error: "apiaryId is required" });

   try {
      const { data: sessions, error } = await supabase
         .from("nuc_sessions")
         .select("*")
         .eq("apiary_id", apiary_id)
         .order("started_at", { ascending: false });

      if (error) return res.status(400).json({ error: error.message });

      return res.json(sessions || []);
   } catch (e) {
      console.error("❌ Error listing nuc sessions:", e);
      return res.status(500).json({ error: "Unexpected server error" });
   }
});

/**
 * GET /api/nuc-sessions/:id
 * -> Get a session + its nuc cycles
 */
/**
 * GET /api/nuc-sessions/:id
 * -> Get a session + its nuc cycles (with hive_code / ruchette info)
 */
/**
 * GET /api/nuc-sessions/:id
 * -> Get a session + its nuc cycles (with hive_code / ruchette info)
 */
router.get("/:id", async (req, res) => {
   const id = Number(req.params.id);
   if (!id) return res.status(400).json({ error: "session id is required" });

   try {
      // 1) جلب السشن
      const { data: session, error: sErr } = await supabase
         .from("nuc_sessions")
         .select("*")
         .eq("id", id)
         .single();

      if (sErr || !session) {
         console.error("❌ Session not found:", sErr);
         return res.status(404).json({ error: "Session not found" });
      }

      // 2) جلب الـ cycles
      const { data: cycles, error: cErr } = await supabase
         .from("nuc_cycles")
         .select(
            "id, apiary_id, ruchette_hive_id, started_at, cell_introduced_at, check_due_at, laying_status, laying_checked_at, closed_at, cell_count, cell_batch"
         )
         .eq("session_id", id);

      if (cErr) {
         console.error("❌ Error loading cycles:", cErr);
         return res.status(400).json({ error: cErr.message });
      }

      let enrichedCycles = cycles || [];

      // 3) IDs متاع الخلايا
      const hiveIds = [
         ...new Set(
            enrichedCycles
               .map((c) => (c.ruchette_hive_id != null ? Number(c.ruchette_hive_id) : null))
               .filter((v) => v != null && !Number.isNaN(v))
         ),
      ];

      console.log("DEBUG nuc-session", {
         sessionId: id,
         hiveIds,
         cyclesCount: enrichedCycles.length,
      });

      if (hiveIds.length > 0) {
         const { data: hives, error: hErr } = await supabase
            .from("hives")
            .select("hive_id, hive_code, name")
            .in("hive_id", hiveIds);

         console.log("DEBUG hives for nuc-session", { hives, hErr });

         if (!hErr && hives) {
            const hiveMap = {};
            hives.forEach((h) => {
               hiveMap[h.hive_id] = h;
            });

            enrichedCycles = enrichedCycles.map((c) => {
               const hive = hiveMap[c.ruchette_hive_id] || null;
               return {
                  ...c,
                  hive_code: hive?.hive_code || null,
                  ruchette: hive || null,
               };
            });
         }
      }

      return res.json({
         session,
         cycles: enrichedCycles,
      });
   } catch (e) {
      console.error("❌ Error loading nuc session:", e);
      return res.status(500).json({ error: "Unexpected server error" });
   }
});

/**
 * POST /api/nuc-sessions/:id/introduce-cells
 * body: { introduced_at?, check_after_days = 15 }
 * -> Introduce queen cells for ALL open cycles in this session
 *    and set a control date J+15
 */
router.post("/:id/introduce-cells", async (req, res) => {
   const session_id = Number(req.params.id);
   if (!session_id) return res.status(400).json({ error: "session_id is invalid" });

   const { introduced_at, check_after_days = 15 } = req.body || {};

   try {
      const introduced = introduced_at || new Date().toISOString();
      const due = ADD_DAYS(introduced, check_after_days);

      // 1) update session
      const { data: session, error: sErr } = await supabase
         .from("nuc_sessions")
         .update({
            cells_introduced_at: introduced,
            check_due_at: due,
         })
         .eq("id", session_id)
         .select()
         .single();

      if (sErr) return res.status(400).json({ error: sErr.message });

      // 2) update all OPEN cycles in this session
      const { data: updatedCycles, error: uErr } = await supabase
         .from("nuc_cycles")
         .update({
            cell_introduced_at: introduced,
            check_due_at: due,
         })
         .eq("session_id", session_id)
         .is("closed_at", null)
         .select();

      if (uErr) return res.status(400).json({ error: uErr.message });

      return res.json({
         ok: true,
         session,
         updated_cycles: updatedCycles || [],
      });
   } catch (e) {
      console.error("❌ Error introducing cells for session:", e);
      return res.status(500).json({ error: "Unexpected server error" });
   }
});

// DELETE /api/nuc-sessions/:id
router.delete("/:id", authenticateUser, async (req, res) => {
   const { id } = req.params;

   try {
      // Check if this session has any cycles
      const { data: cycles, error: cErr } = await supabase
         .from("nuc_cycles")
         .select("id")
         .eq("session_id", id)
         .limit(1);

      if (cErr) return res.status(400).json({ error: cErr.message });

      if (cycles && cycles.length > 0) {
         return res
            .status(400)
            .json({ error: "Cannot delete a session that already has nuc cycles." });
      }

      const { error: dErr } = await supabase.from("nuc_sessions").delete().eq("id", id);

      if (dErr) return res.status(400).json({ error: dErr.message });

      return res.json({ ok: true, deleted: true });
   } catch (e) {
      console.error("Error deleting nuc session:", e);
      return res.status(500).json({ error: "Unexpected server error" });
   }
});

module.exports = router;
