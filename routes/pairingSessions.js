// routes/pairingSessions.js
const express = require("express");
const router = express.Router();
const supabase = require("../utils/supabaseClient");
const authenticateUser = require("../middlewares/authMiddleware");

/**
 * POST /api/pairing-sessions
 * Save a completed session (one-shot).
 * body: {
 *   apiary_id, season_label?, started_at, ended_at, expected_hive_ids: number[],
 *   links: [{hive_id, super_id}], user_id?
 * }
 */
router.post("/", authenticateUser, async (req, res) => {
  const {
    apiary_id,
    season_label,
    started_at,
    ended_at,
    expected_hive_ids,
    links = [],
    user_id,
  } = req.body || {};

  if (!apiary_id || !started_at || !ended_at || !Array.isArray(expected_hive_ids)) {
    return res.status(400).json({ error: "Missing required fields." });
  }

  try {
    const expected_count = expected_hive_ids.length;

    const { data: session, error: sErr } = await supabase
      .from("pairing_sessions")
      .insert([
        {
          apiary_id,
          season_label,
          started_at,
          ended_at,
          expected_hive_ids, // jsonb/array on Supabase
          expected_count,
          user_id,
        },
      ])
      .select()
      .single();

    if (sErr) return res.status(400).json({ error: sErr.message });

    if (links.length) {
      const rows = links.map((l) => ({
        session_id: session.id,
        hive_id: l.hive_id,
        super_id: l.super_id,
      }));
      const { error: lErr } = await supabase.from("pairing_session_links").insert(rows);
      if (lErr) return res.status(400).json({ error: lErr.message });
    }

    return res.status(201).json({ session_id: session.id });
  } catch (e) {
    console.error(e);
    return res.status(500).json({ error: "Unexpected server error" });
  }
});

/**
 * GET /api/pairing-sessions/by-apiary/:apiaryId
 * List sessions for an apiary + quick aggregates.
 */
router.get("/by-apiary/:apiaryId", authenticateUser, async (req, res) => {
  const { apiaryId } = req.params;

  try {
    const { data: sessions, error: sErr } = await supabase
      .from("pairing_sessions")
      .select("*")
      .eq("apiary_id", apiaryId)
      .order("ended_at", { ascending: false });

    if (sErr) return res.status(400).json({ error: sErr.message });
    if (!sessions?.length) return res.json([]);

    const ids = sessions.map((s) => s.id);
    const { data: links, error: lErr } = await supabase
      .from("pairing_session_links")
      .select("session_id,hive_id,super_id")
      .in("session_id", ids);

    if (lErr) return res.status(400).json({ error: lErr.message });

    const bySession = new Map();
    for (const s of sessions) bySession.set(s.id, { supers: 0, hiveSet: new Set() });

    for (const row of links) {
      const agg = bySession.get(row.session_id);
      if (!agg) continue;
      agg.supers += 1;
      agg.hiveSet.add(String(row.hive_id));
    }

    const payload = sessions.map((s) => {
      const agg = bySession.get(s.id) || { supers: 0, hiveSet: new Set() };
      const hivesLinked = agg.hiveSet.size;
      const unlinked = Math.max(0, (s.expected_count || 0) - hivesLinked);
      return {
        id: s.id,
        apiary_id: s.apiary_id,
        season_label: s.season_label,
        started_at: s.started_at,
        ended_at: s.ended_at,
        expected_count: s.expected_count,
        hives_linked_count: hivesLinked,
        supers_count: agg.supers,
        unlinked_count: unlinked,
      };
    });

    return res.json(payload);
  } catch (e) {
    console.error(e);
    return res.status(500).json({ error: "Unexpected server error" });
  }
});

/**
 * GET /api/pairing-sessions/:id
 * Detailed view: session, links grouped by hive, and "unlinked" list.
 */
router.get("/:id", authenticateUser, async (req, res) => {
  const { id } = req.params;

  try {
    const { data: session, error: sErr } = await supabase
      .from("pairing_sessions")
      .select("*")
      .eq("id", id)
      .single();

    if (sErr || !session) return res.status(404).json({ error: "Session not found" });

    const { data: links, error: lErr } = await supabase
      .from("pairing_session_links")
      .select("hive_id, super_id")
      .eq("session_id", id);

    if (lErr) return res.status(400).json({ error: lErr.message });

    // group by hive
    const map = new Map(); // hive_id -> [super_id...]
    for (const row of links) {
      const k = String(row.hive_id);
      if (!map.has(k)) map.set(k, []);
      map.get(k).push(row.super_id);
    }

    // fetch codes for display
    const hiveIds = Array.from(map.keys()).map((x) => Number(x));
    const supIds = links.map((l) => l.super_id);

    const [hivesRes, supersRes] = await Promise.all([
      hiveIds.length
        ? supabase.from("hives").select("hive_id,hive_code").in("hive_id", hiveIds)
        : { data: [] },
      supIds.length
        ? supabase.from("supers").select("super_id,super_code").in("super_id", supIds)
        : { data: [] },
    ]);

    const hiveCodeById = new Map(
      (hivesRes.data || []).map((h) => [String(h.hive_id), h.hive_code])
    );
    const superCodeById = new Map((supersRes.data || []).map((s) => [s.super_id, s.super_code]));

    const linked = Array.from(map.entries()).map(([hid, sids]) => ({
      hive_id: Number(hid),
      hive_code: hiveCodeById.get(hid) || hid,
      supers: sids.map((sid) => ({
        super_id: sid,
        super_code: superCodeById.get(sid) || sid,
      })),
    }));

    // Normalize expected_hive_ids possibly stored as JSON/text
    let expectedIdsRaw = session.expected_hive_ids || [];
    if (typeof expectedIdsRaw === "string") {
      try {
        expectedIdsRaw = JSON.parse(expectedIdsRaw);
      } catch {
        expectedIdsRaw = expectedIdsRaw
          .split(",")
          .map((s) => s.trim())
          .filter(Boolean);
      }
    }

    const expectedIds = Array.isArray(expectedIdsRaw)
      ? expectedIdsRaw.map((x) => Number(x)).filter((n) => Number.isFinite(n))
      : [];

    const linkedIds = new Set(linked.map((x) => String(x.hive_id)));
    const unlinkedIds = expectedIds.filter((id2) => !linkedIds.has(String(id2)));

    let unlinked = [];
    if (unlinkedIds.length) {
      const { data: missing } = await supabase
        .from("hives")
        .select("hive_id,hive_code")
        .in("hive_id", unlinkedIds);
      unlinked = (missing || []).map((m) => ({
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
        expected_count: session.expected_count,
      },
      linked,
      unlinked,
    });
  } catch (e) {
    console.error(e);
    return res.status(500).json({ error: "Unexpected server error" });
  }
});

/**
 * DELETE /api/pairing-sessions/:id
 * Accepts UUID or numeric ids. Removes a session and its link rows.
 */
router.delete("/:id", authenticateUser, async (req, res) => {
  const { id } = req.params; // keep as string (uuid or numeric)

  try {
    // ensure it exists (optional but gives 404 vs silent success)
    const { data: found, error: findErr } = await supabase
      .from("pairing_sessions")
      .select("id")
      .eq("id", id)
      .single();

    if (findErr || !found) return res.status(404).json({ error: "Session not found" });

    // delete child rows first (safe even if you also have ON DELETE CASCADE)
    await supabase.from("pairing_session_links").delete().eq("session_id", id);

    const { error: delErr } = await supabase.from("pairing_sessions").delete().eq("id", id);
    if (delErr) return res.status(400).json({ error: delErr.message });

    return res.status(204).send();
  } catch (e) {
    console.error(e);
    return res.status(500).json({ error: "Unexpected server error" });
  }
});

module.exports = router;
