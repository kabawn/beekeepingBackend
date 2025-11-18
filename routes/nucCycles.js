// routes/nucCycles.js
const express = require("express");
const router = express.Router();
const supabase = require("../utils/supabaseClient");
const authenticateUser = require("../middlewares/authMiddleware");

const ADD_DAYS = (d, days) => {
   const x = new Date(d);
   x.setUTCDate(x.getUTCDate() + days);
   return x.toISOString();
};

async function getHiveByPublicKey(pk) {
   return supabase
      .from("hives")
      .select("hive_id,hive_purpose,apiary_id")
      .eq("public_key", String(pk).toLowerCase())
      .single();
}

router.use(authenticateUser);

/**
 * GET /api/nuc-cycles/overview?apiary_id=123
 * KPIs + backlogs for an apiary
 */
router.get("/overview", async (req, res) => {
   const apiary_id = Number(req.query.apiary_id);
   if (!apiary_id) return res.status(400).json({ error: "apiary_id is required" });

   try {
      const now = new Date().toISOString();

      const { data: all, error } = await supabase
         .from("nuc_cycles")
         .select("*")
         .eq("apiary_id", apiary_id);

      if (error) return res.status(400).json({ error: error.message });

      const produced = all.length;
      const introduced = all.filter((c) => c.cell_introduced_at).length;

      const closed = all.filter((c) => c.closed_at);
      const ok = closed.filter((c) => c.laying_status === "ok").length;
      const success_rate = closed.length ? Math.round((ok / closed.length) * 100) : 0;

      const without_cell = all.filter((c) => !c.cell_introduced_at && !c.closed_at);
      const checks_due = all.filter(
         (c) => c.cell_introduced_at && !c.closed_at && c.check_due_at && c.check_due_at <= now
      );

      return res.json({
         kpis: {
            produced,
            introduced,
            success_rate,
            due_today: checks_due.length,
         },
         backlogs: {
            without_cell,
            checks_due,
         },
      });
   } catch (e) {
      console.error("❌ Error in nuc-cycles overview:", e);
      return res.status(500).json({ error: "Unexpected server error" });
   }
});

/**
 * POST /api/nuc-cycles/inventory
 * body: { ruchette_public_key: string, started_at?: ISO, session_id?: number }
 *
 * Called when scanning a nuc during a swarm-production session.
 * Ensures 1 open cycle per ruchette.
 */
router.post("/inventory", async (req, res) => {
   let { ruchette_public_key, started_at, session_id } = req.body || {};
   if (!ruchette_public_key)
      return res.status(400).json({ error: "ruchette_public_key is required" });

   try {
      const { data: hive, error: hErr } = await getHiveByPublicKey(ruchette_public_key);
      if (hErr || !hive) return res.status(404).json({ error: "Ruchette not found" });

      if ((hive.hive_purpose || "").toLowerCase() !== "ruchette")
         return res.status(400).json({ error: "This QR is not a ruchette" });

      // existing open cycle?
      const { data: existing, error: eErr } = await supabase
         .from("nuc_cycles")
         .select("*")
         .eq("ruchette_hive_id", hive.hive_id)
         .is("closed_at", null)
         .maybeSingle();

      if (eErr) return res.status(400).json({ error: eErr.message });
      if (existing) return res.json({ ok: true, mode: "existing", cycle: existing });

      // If session_id is provided and no started_at => use session.started_at
      if (session_id && !started_at) {
         const { data: session, error: sErr } = await supabase
            .from("nuc_sessions")
            .select("started_at")
            .eq("id", session_id)
            .maybeSingle();

         if (sErr) return res.status(400).json({ error: sErr.message });
         if (session && session.started_at) started_at = session.started_at;
      }

      const payload = {
         apiary_id: hive.apiary_id,
         ruchette_hive_id: hive.hive_id,
         started_at: started_at || new Date().toISOString(),
      };

      if (session_id) payload.session_id = session_id;

      const { data: created, error: cErr } = await supabase
         .from("nuc_cycles")
         .insert([payload])
         .select()
         .single();

      if (cErr) return res.status(400).json({ error: cErr.message });
      return res.status(201).json({ ok: true, mode: "created", cycle: created });
   } catch (e) {
      console.error("❌ Error in nuc-cycles inventory:", e);
      return res.status(500).json({ error: "Unexpected server error" });
   }
});

/**
 * POST /api/nuc-cycles/:id/introduce
 * body: { cell_count?: number, cell_batch?: string, introduced_at?: ISO, check_after_days?: number }
 * Per-ruchette introduce (you may still want it; default 15 days now)
 */
router.post("/:id/introduce", async (req, res) => {
   const { id } = req.params;
   const { cell_count = 1, cell_batch, introduced_at, check_after_days = 15 } = req.body || {};

   try {
      const introduced = introduced_at || new Date().toISOString();
      const due = ADD_DAYS(introduced, check_after_days);

      const { data, error } = await supabase
         .from("nuc_cycles")
         .update({
            cell_introduced_at: introduced,
            cell_count,
            cell_batch,
            check_due_at: due,
         })
         .eq("id", id)
         .is("closed_at", null)
         .select()
         .single();

      if (error) return res.status(400).json({ error: error.message });
      return res.json({ ok: true, cycle: data });
   } catch (e) {
      console.error("❌ Error introducing cells:", e);
      return res.status(500).json({ error: "Unexpected server error" });
   }
});

/**
 * POST /api/nuc-cycles/:id/check
 * body: { result: 'ok' | 'no_eggs', reintroduce?: boolean, check_after_days?: number }
 * -> Control laying for a single nuc
 */
router.post("/:id/check", async (req, res) => {
   const { id } = req.params;
   const { result, reintroduce = false, check_after_days = 15 } = req.body || {};
   if (!["ok", "no_eggs"].includes(result || "")) {
      return res.status(400).json({ error: "result must be 'ok' or 'no_eggs'" });
   }

   try {
      const now = new Date().toISOString();

      if (result === "ok") {
         const { data, error } = await supabase
            .from("nuc_cycles")
            .update({
               laying_status: "ok",
               laying_checked_at: now,
               closed_at: now,
            })
            .eq("id", id)
            .is("closed_at", null)
            .select()
            .single();
         if (error) return res.status(400).json({ error: error.message });
         return res.json({ ok: true, cycle: data });
      }

      // result === 'no_eggs'
      if (reintroduce) {
         const introduced = now;
         const due = ADD_DAYS(introduced, check_after_days);

         const { data, error } = await supabase
            .from("nuc_cycles")
            .update({
               laying_status: "no_eggs",
               laying_checked_at: now,
               cell_introduced_at: introduced,
               check_due_at: due,
            })
            .eq("id", id)
            .is("closed_at", null)
            .select()
            .single();
         if (error) return res.status(400).json({ error: error.message });
         return res.json({ ok: true, cycle: data, reintroduced: true });
      } else {
         const { data, error } = await supabase
            .from("nuc_cycles")
            .update({
               laying_status: "no_eggs",
               laying_checked_at: now,
            })
            .eq("id", id)
            .is("closed_at", null)
            .select()
            .single();
         if (error) return res.status(400).json({ error: error.message });
         return res.json({ ok: true, cycle: data, reintroduced: false });
      }
   } catch (e) {
      console.error("❌ Error checking nuc cycle:", e);
      return res.status(500).json({ error: "Unexpected server error" });
   }
});

/**
 * GET /api/nuc-cycles/by-apiary/:apiaryId/list
 * Returns ruchettes in the apiary + their open cycle (if any)
 */
router.get("/by-apiary/:apiaryId/list", async (req, res) => {
   const apiary_id = Number(req.params.apiaryId);
   if (!apiary_id) return res.status(400).json({ error: "apiaryId is required" });

   try {
      const { data: ruchettes, error: hErr } = await supabase
         .from("hives")
         .select(
            "hive_id,hive_code,public_key,hive_type,frame_capacity,in_service,hive_purpose,apiary_id"
         )
         .eq("apiary_id", apiary_id);

      if (hErr) return res.status(400).json({ error: hErr.message });

      const onlyRuchettes = (ruchettes || []).filter(
         (h) => String(h.hive_purpose || "").toLowerCase() === "ruchette"
      );

      if (!onlyRuchettes.length) return res.json([]);

      const ids = onlyRuchettes.map((h) => h.hive_id);

      const { data: cycles, error: cErr } = await supabase
         .from("nuc_cycles")
         .select("*")
         .in("ruchette_hive_id", ids)
         .is("closed_at", null);

      if (cErr) return res.status(400).json({ error: cErr.message });

      const byRuchetteId = new Map();
      for (const c of cycles || []) byRuchetteId.set(Number(c.ruchette_hive_id), c);

      const payload = onlyRuchettes.map((r) => ({
         ruchette: {
            hive_id: r.hive_id,
            hive_code: r.hive_code,
            public_key: r.public_key,
            hive_type: r.hive_type,
            frame_capacity: r.frame_capacity,
            in_service: r.in_service,
         },
         cycle: byRuchetteId.get(Number(r.hive_id)) || null,
      }));

      return res.json(payload);
   } catch (e) {
      console.error("❌ Error listing nuc-cycles by apiary:", e);
      return res.status(500).json({ error: "Unexpected server error" });
   }
});

/**
 * GET /api/nuc-cycles/by-session/:sessionId/list
 * -> All cycles for a given session + basic hive info
 */
router.get("/by-session/:sessionId/list", async (req, res) => {
   const session_id = Number(req.params.sessionId);
   if (!session_id) return res.status(400).json({ error: "sessionId is required" });

   try {
      const { data: cycles, error: cErr } = await supabase
         .from("nuc_cycles")
         .select(
            "id, apiary_id, ruchette_hive_id, started_at, cell_introduced_at, check_due_at, laying_status, laying_checked_at, closed_at, cell_count, cell_batch"
         )
         .eq("session_id", session_id);

      if (cErr) return res.status(400).json({ error: cErr.message });

      if (!cycles || !cycles.length) return res.json([]);

      const hiveIds = [...new Set(cycles.map((c) => c.ruchette_hive_id))];

      const { data: hives, error: hErr } = await supabase
         .from("hives")
         .select("hive_id,hive_code,public_key,hive_type,frame_capacity")
         .in("hive_id", hiveIds);

      if (hErr) return res.status(400).json({ error: hErr.message });

      const hiveMap = new Map(hives.map((h) => [Number(h.hive_id), h]));

      const payload = cycles.map((c) => ({
         cycle: c,
         ruchette: hiveMap.get(Number(c.ruchette_hive_id)) || null,
      }));

      return res.json(payload);
   } catch (e) {
      console.error("❌ Error listing nuc-cycles by session:", e);
      return res.status(500).json({ error: "Unexpected server error" });
   }
});

module.exports = router;
