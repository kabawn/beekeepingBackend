// routes/notationSessions.js
const express = require("express");
const router = express.Router();
const supabase = require("../utils/supabaseClient");
const authenticateUser = require("../middlewares/authMiddleware");

/**
 * Helpers
 */
function normalizeNumberArray(input) {
   if (!input) return [];
   if (Array.isArray(input)) {
      return input.map((x) => Number(x)).filter((n) => Number.isFinite(n));
   }
   if (typeof input === "string") {
      // try JSON first
      try {
         const arr = JSON.parse(input);
         if (Array.isArray(arr)) {
            return arr.map((x) => Number(x)).filter((n) => Number.isFinite(n));
         }
      } catch {}
      // fallback: "1,2,3"
      return input
         .split(",")
         .map((s) => Number(s.trim()))
         .filter((n) => Number.isFinite(n));
   }
   return [];
}

function normalizeTextArray(input) {
   if (!input) return [];
   if (Array.isArray(input)) {
      return input.map((s) => String(s)).filter(Boolean);
   }
   if (typeof input === "string") {
      try {
         const arr = JSON.parse(input);
         if (Array.isArray(arr)) return arr.map((s) => String(s)).filter(Boolean);
      } catch {}
      return input
         .split(",")
         .map((s) => s.trim())
         .filter(Boolean);
   }
   return [];
}

/**
 * GET /api/notation-sessions/catalog
 * Active notation types list (from notations_catalog).
 */
router.get("/catalog", authenticateUser, async (_req, res) => {
   try {
      const { data, error } = await supabase
         .from("notations_catalog")
         .select("*")
         .eq("active", true)
         .order("sort_order", { ascending: true });

      if (error) return res.status(400).json({ error: error.message });
      return res.json(data || []);
   } catch (e) {
      console.error(e);
      return res.status(500).json({ error: "Unexpected server error" });
   }
});

/**
 * POST /api/notation-sessions
 * Create a new notation session (started when the user begins).
 * body: {
 *   apiary_id: number,
 *   season_label?: string,
 *   selected_keys: string[],             // keys from notations_catalog
 *   expected_hive_ids: number[],         // full list of hives in apiary at start
 *   started_at?: string (ISO),           // default now
 *   user_id?: uuid
 * }
 */
router.post("/", authenticateUser, async (req, res) => {
   const { apiary_id, season_label, selected_keys, expected_hive_ids, started_at, user_id } =
      req.body || {};

   if (!apiary_id || !Array.isArray(selected_keys) || !Array.isArray(expected_hive_ids)) {
      return res.status(400).json({ error: "Missing required fields." });
   }

   try {
      const normalizedKeys = normalizeTextArray(selected_keys);
      const normalizedExpected = normalizeNumberArray(expected_hive_ids);
      const expected_count = normalizedExpected.length;
      const startedAt = started_at || new Date().toISOString();

      const { data: session, error: sErr } = await supabase
         .from("notations_sessions")
         .insert([
            {
               apiary_id,
               season_label,
               selected_keys: normalizedKeys,
               expected_hive_ids: normalizedExpected,
               expected_count,
               started_at: startedAt,
               ended_at: null, // stays draft until finish
               user_id,
            },
         ])
         .select()
         .single();

      if (sErr) return res.status(400).json({ error: sErr.message });
      return res.status(201).json({ session_id: session.id, session });
   } catch (e) {
      console.error(e);
      return res.status(500).json({ error: "Unexpected server error" });
   }
});

/**
 * POST /api/notation-sessions/:id/entries
 * Upsert answers for a hive (called repeatedly while scanning/typing).
 * body: {
 *   hive_id?: number,
 *   hive_public_key?: string,          // if provided, we resolve to hive_id
 *   answers: { [notation_key]: any },  // e.g. {"dynamism": 4, "health": 2}
 *   merge?: boolean                    // default true (merge into existing answers)
 * }
 */
router.post("/:id/entries", authenticateUser, async (req, res) => {
   const { id } = req.params;
   let { hive_id, hive_public_key, answers, merge } = req.body || {};
   if (merge === undefined) merge = true;

   if (!answers || typeof answers !== "object") {
      return res.status(400).json({ error: "Answers payload is required." });
   }

   try {
      // Resolve hive_id by public key if needed
      if (!hive_id && hive_public_key) {
         const { data: hr, error: hErr } = await supabase
            .from("hives")
            .select("hive_id")
            .eq("public_key", String(hive_public_key).toLowerCase())
            .single();
         if (hErr || !hr) return res.status(404).json({ error: "Hive not found by public key" });
         hive_id = hr.hive_id;
      }

      if (!hive_id) {
         return res.status(400).json({ error: "hive_id or hive_public_key is required." });
      }

      // Ensure session exists
      const { data: session, error: sErr } = await supabase
         .from("notations_sessions")
         .select("id, apiary_id, expected_hive_ids")
         .eq("id", id)
         .single();

      if (sErr || !session) return res.status(404).json({ error: "Session not found" });

      // Fetch existing entry (if any)
      const { data: existing, error: eErr } = await supabase
         .from("notations_session_entries")
         .select("id, answers")
         .eq("session_id", id)
         .eq("hive_id", hive_id)
         .maybeSingle();

      if (eErr) return res.status(400).json({ error: eErr.message });

      const newAnswers = merge && existing?.answers ? { ...existing.answers, ...answers } : answers;

      if (existing?.id) {
         const { error: upErr } = await supabase
            .from("notations_session_entries")
            .update({ answers: newAnswers, updated_at: new Date().toISOString() })
            .eq("id", existing.id);

         if (upErr) return res.status(400).json({ error: upErr.message });
         return res.json({ ok: true, mode: "updated" });
      } else {
         // Try insert; if a concurrent insert won the race, merge-UPDATE
         const { error: insErr } = await supabase
            .from("notations_session_entries")
            .insert([{ session_id: id, hive_id, answers: newAnswers }]);

         if (insErr) {
            const code = insErr.code || "";
            const msg = insErr.message || "";

            // Postgres unique_violation = 23505
            if (code === "23505" || /duplicate key/i.test(msg)) {
               // Row exists now; fetch, merge, update
               const { data: row, error: selErr } = await supabase
                  .from("notations_session_entries")
                  .select("id, answers")
                  .eq("session_id", id)
                  .eq("hive_id", hive_id)
                  .single();

               if (selErr || !row) return res.status(400).json({ error: insErr.message });

               const merged = { ...(row.answers || {}), ...newAnswers };

               const { error: up2Err } = await supabase
                  .from("notations_session_entries")
                  .update({ answers: merged, updated_at: new Date().toISOString() })
                  .eq("id", row.id);

               if (up2Err) return res.status(400).json({ error: up2Err.message });
               return res.json({ ok: true, mode: "merged" });
            }

            return res.status(400).json({ error: insErr.message });
         }

         return res.status(201).json({ ok: true, mode: "inserted" });
      }
   } catch (e) {
      console.error(e);
      return res.status(500).json({ error: "Unexpected server error" });
   }
});

/**
 * PATCH /api/notation-sessions/:id/finish
 * Mark session finished and optionally replace expected_hive_ids or selected_keys.
 * body: { ended_at?: ISO, expected_hive_ids?: number[], selected_keys?: string[] }
 */
router.patch("/:id/finish", authenticateUser, async (req, res) => {
   const { id } = req.params;
   const { ended_at, expected_hive_ids, selected_keys } = req.body || {};

   try {
      const patch = {
         ended_at: ended_at || new Date().toISOString(),
      };

      if (expected_hive_ids) {
         const normalized = normalizeNumberArray(expected_hive_ids);
         patch.expected_hive_ids = normalized;
         patch.expected_count = normalized.length;
      }

      if (selected_keys) {
         patch.selected_keys = normalizeTextArray(selected_keys);
      }

      const { data, error } = await supabase
         .from("notations_sessions")
         .update(patch)
         .eq("id", id)
         .select()
         .single();

      if (error) return res.status(400).json({ error: error.message });
      return res.json({ ok: true, session: data });
   } catch (e) {
      console.error(e);
      return res.status(500).json({ error: "Unexpected server error" });
   }
});

/**
 * GET /api/notation-sessions/by-apiary/:apiaryId
 * List sessions for an apiary with quick aggregates.
 * Each item: { id, season_label, started_at, ended_at, selected_keys,
 *              expected_count, hives_notated_count, unvisited_count, answers_count }
 */
router.get("/by-apiary/:apiaryId", authenticateUser, async (req, res) => {
   const { apiaryId } = req.params;
   try {
      const { data: sessions, error: sErr } = await supabase
         .from("notations_sessions")
         .select("*")
         .eq("apiary_id", apiaryId)
         .order("started_at", { ascending: false });

      if (sErr) return res.status(400).json({ error: sErr.message });
      if (!sessions?.length) return res.json([]);

      const ids = sessions.map((s) => s.id);

      // entries per session
      const { data: entries, error: eErr } = await supabase
         .from("notations_session_entries")
         .select("session_id,hive_id,answers")
         .in("session_id", ids);

      if (eErr) return res.status(400).json({ error: eErr.message });

      const bySession = new Map(); // id -> { hiveSet:Set, answersCount:number }
      for (const s of sessions) bySession.set(s.id, { hiveSet: new Set(), answersCount: 0 });

      for (const row of entries) {
         const agg = bySession.get(row.session_id);
         if (!agg) continue;
         agg.hiveSet.add(String(row.hive_id));
         if (row.answers && typeof row.answers === "object") {
            agg.answersCount += Object.keys(row.answers).length;
         }
      }

      const payload = sessions.map((s) => {
         const agg = bySession.get(s.id) || { hiveSet: new Set(), answersCount: 0 };
         const hivesNotated = agg.hiveSet.size;
         const unvisited = Math.max(0, (s.expected_count || 0) - hivesNotated);
         return {
            id: s.id,
            apiary_id: s.apiary_id,
            season_label: s.season_label,
            started_at: s.started_at,
            ended_at: s.ended_at,
            selected_keys: s.selected_keys || [],
            expected_count: s.expected_count,
            hives_notated_count: hivesNotated,
            entries_count: hivesNotated,     b
            unvisited_count: unvisited,
            answers_count: agg.answersCount,
         };
      });

      return res.json(payload);
   } catch (e) {
      console.error(e);
      return res.status(500).json({ error: "Unexpected server error" });
   }
});

/**
 * GET /api/notation-sessions/:id
 * Detailed view of a session:
 *  - session meta
 *  - selected notation catalog entries (labels, ranges)
 *  - entries grouped by hive (with hive_code)
 *  - unvisited hives (expected - visited)
 */
router.get("/:id", authenticateUser, async (req, res) => {
   const { id } = req.params;
   try {
      const { data: session, error: sErr } = await supabase
         .from("notations_sessions")
         .select("*")
         .eq("id", id)
         .single();

      if (sErr || !session) return res.status(404).json({ error: "Session not found" });

      const { data: entries, error: eErr } = await supabase
         .from("notations_session_entries")
         .select("hive_id, answers")
         .eq("session_id", id);

      if (eErr) return res.status(400).json({ error: eErr.message });

      // fetch hives for display (codes)
      const hiveIds = Array.from(new Set(entries.map((e) => Number(e.hive_id)))).filter(Boolean);
      const { data: hivesData } = hiveIds.length
         ? await supabase.from("hives").select("hive_id,hive_code").in("hive_id", hiveIds)
         : { data: [] };

      const hiveCodeById = new Map((hivesData || []).map((h) => [String(h.hive_id), h.hive_code]));

      // selected notations metadata
      const selectedKeys = normalizeTextArray(session.selected_keys);
      const { data: catalog } = selectedKeys.length
         ? await supabase
              .from("notations_catalog")
              .select("*")
              .in("key", selectedKeys)
              .order("sort_order", { ascending: true })
         : { data: [] };

      const byHive = entries.map((e) => ({
         hive_id: e.hive_id,
         hive_code: hiveCodeById.get(String(e.hive_id)) || e.hive_id,
         answers: e.answers || {},
      }));

      // Normalize expected ids & compute unvisited
      const expectedIds = normalizeNumberArray(session.expected_hive_ids);
      const visitedSet = new Set(byHive.map((x) => String(x.hive_id)));
      const unlinkedIds = expectedIds.filter((hid) => !visitedSet.has(String(hid)));

      let unvisited = [];
      if (unlinkedIds.length) {
         const { data: miss } = await supabase
            .from("hives")
            .select("hive_id,hive_code")
            .in("hive_id", unlinkedIds);
         unvisited = (miss || []).map((m) => ({
            hive_id: m.hive_id,
            hive_code: m.hive_code,
         }));
      }

      return res.json({
         session: {
            id: session.id,
            apiary_id: session.apiary_id,
            season_label: session.season_label,
            started_at: session.started_at,
            ended_at: session.ended_at,
            selected_keys: selectedKeys,
            expected_count: session.expected_count,
         },
         catalog: catalog || [],
         entries: byHive,
         unvisited,
      });
   } catch (e) {
      console.error(e);
      return res.status(500).json({ error: "Unexpected server error" });
   }
});

/**
 * DELETE /api/notation-sessions/:id
 * Deletes a session and its entries (FK ON DELETE CASCADE).
 */
router.delete("/:id", authenticateUser, async (req, res) => {
   const { id } = req.params;
   try {
      // (Optional) sanity: ensure it exists
      const { data: exists } = await supabase
         .from("notations_sessions")
         .select("id")
         .eq("id", id)
         .maybeSingle();

      if (!exists) return res.status(404).json({ error: "Session not found" });

      const { error: delErr } = await supabase.from("notations_sessions").delete().eq("id", id);

      if (delErr) return res.status(400).json({ error: delErr.message });
      return res.json({ ok: true });
   } catch (e) {
      console.error(e);
      return res.status(500).json({ error: "Unexpected server error" });
   }
});

module.exports = router;
