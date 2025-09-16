// routes/inventory.js
const express = require("express");
const { createClient } = require("@supabase/supabase-js");

const router = express.Router();

// ⚠️ Use SERVICE ROLE key on the server
const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);

/**
 * POST /inventory-sessions
 * Body:
 * {
 *   apiary_id: number,
 *   expected_count: number,
 *   present: [{hive_id, hive_code, scanned_at?}],
 *   missing: [{hive_id, hive_code}],
 *   extras:  [{extra_type: 'wrong_apiary'|'unregistered', action?: 'kept'|'reassigned'|'ignored'|'created', hive_id?, hive_code?, public_key?, from_apiary_id?}],
 *   started_at?: string,
 *   ended_at?: string,
 *   company_id?: number,
 *   created_by?: string (uuid),
 *   notes?: string
 * }
 */
router.post("/inventory-sessions", async (req, res) => {
   try {
      const {
         apiary_id,
         expected_count = 0,
         present = [],
         missing = [],
         extras = [],
         started_at,
         ended_at,
         company_id,
         created_by,
         notes,
      } = req.body || {};

      if (!apiary_id) {
         return res.status(400).json({ error: "apiary_id is required" });
      }

      // 1) insert session header
      const { data: sessRows, error: sessErr } = await supabase
         .from("inventory_sessions")
         .insert([
            {
               apiary_id,
               expected_count,
               started_at: started_at || null,
               ended_at: ended_at || null,
               company_id: company_id || null,
               created_by: created_by || null,
               notes: notes || null,
            },
         ])
         .select("id")
         .single();

      if (sessErr) {
         console.error(sessErr);
         return res.status(500).json({ error: sessErr.message });
      }
      const session_id = sessRows.id;

      // 2) insert present
      if (Array.isArray(present) && present.length) {
         const presentRows = present.map((p) => ({
            session_id,
            hive_id: p.hive_id,
            hive_code: p.hive_code || null,
            scanned_at: p.scanned_at || null,
         }));
         const { error: pErr } = await supabase.from("inventory_present").insert(presentRows);
         if (pErr) {
            console.error(pErr);
            // no transaction here; you can manually clean up if you want
            return res.status(500).json({ error: pErr.message, session_id });
         }
      }

      // 3) insert missing
      if (Array.isArray(missing) && missing.length) {
         const missingRows = missing.map((m) => ({
            session_id,
            hive_id: m.hive_id,
            hive_code: m.hive_code || null,
         }));
         const { error: mErr } = await supabase.from("inventory_missing").insert(missingRows);
         if (mErr) {
            console.error(mErr);
            return res.status(500).json({ error: mErr.message, session_id });
         }
      }

      // 4) insert extras
      if (Array.isArray(extras) && extras.length) {
         const extraRows = extras.map((x) => ({
            session_id,
            extra_type: x.extra_type, // 'wrong_apiary' | 'unregistered'
            action: x.action || null, // 'kept' | 'reassigned' | 'ignored' | 'created'
            hive_id: x.hive_id || null,
            hive_code: x.hive_code || null,
            public_key: x.public_key || null,
            from_apiary_id: x.from_apiary_id || null,
         }));
         const { error: eErr } = await supabase.from("inventory_extras").insert(extraRows);
         if (eErr) {
            console.error(eErr);
            return res.status(500).json({ error: eErr.message, session_id });
         }
      }

      return res.status(201).json({ session_id });
   } catch (e) {
      console.error(e);
      res.status(500).json({ error: "server_error" });
   }
});

/**
 * GET /inventory-sessions?apiary_id=123
 */
router.get("/inventory-sessions", async (req, res) => {
   try {
      const apiaryId = Number(req.query.apiary_id);
      if (!apiaryId) return res.status(400).json({ error: "apiary_id is required" });

      const { data, error } = await supabase
         .from("inventory_sessions")
         .select("*")
         .eq("apiary_id", apiaryId)
         .order("created_at", { ascending: false });

      if (error) {
         console.error(error);
         return res.status(500).json({ error: error.message });
      }

      res.json({ sessions: data || [] });
   } catch (e) {
      console.error(e);
      res.status(500).json({ error: "server_error" });
   }
});

/**
 * GET /inventory-sessions/:id
 * Returns session + present + missing + extras
 */
router.get("/inventory-sessions/:id", async (req, res) => {
   try {
      const id = Number(req.params.id);
      if (!id) return res.status(400).json({ error: "invalid id" });

      const [s1, s2, s3, s4] = await Promise.all([
         supabase.from("inventory_sessions").select("*").eq("id", id).single(),
         supabase.from("inventory_present").select("*").eq("session_id", id),
         supabase.from("inventory_missing").select("*").eq("session_id", id),
         supabase.from("inventory_extras").select("*").eq("session_id", id),
      ]);

      if (s1.error || !s1.data) return res.status(404).json({ error: "not_found" });

      res.json({
         session: s1.data,
         present: s2.data || [],
         missing: s3.data || [],
         extras: s4.data || [],
      });
   } catch (e) {
      console.error(e);
      res.status(500).json({ error: "server_error" });
   }
});

// DELETE /inventory-sessions/:id
router.delete("/inventory-sessions/:id", async (req, res) => {
   try {
      const id = Number(req.params.id);
      if (!id) return res.status(400).json({ error: "invalid id" });

      // (Optional) authorize: ensure requester may delete this session
      // If you store created_by/company_id, you can fetch then check here.

      const { data, error } = await supabase
         .from("inventory_sessions")
         .delete()
         .eq("id", id)
         .select("id") // to know if something was deleted
         .single();

      if (error) {
         console.error(error);
         return res.status(500).json({ error: error.message });
      }
      if (!data) return res.status(404).json({ error: "not_found" });

      // Children are removed by FK ON DELETE CASCADE
      return res.status(204).send();
   } catch (e) {
      console.error(e);
      res.status(500).json({ error: "server_error" });
   }
});

module.exports = router;
