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

/**
 * GET /api/nuc-cycles/overview?apiary_id=123
 * KPIs + backlogs
 */
router.get("/overview", authenticateUser, async (req, res) => {
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
    console.error(e);
    return res.status(500).json({ error: "Unexpected server error" });
  }
});

/**
 * POST /api/nuc-cycles/inventory
 * body: { ruchette_public_key: string, started_at?: ISO }
 * Ensures 1 open cycle per ruchette.
 */
router.post("/inventory", authenticateUser, async (req, res) => {
  let { ruchette_public_key, started_at } = req.body || {};
  if (!ruchette_public_key) return res.status(400).json({ error: "ruchette_public_key is required" });

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

    // create
    const { data: created, error: cErr } = await supabase
      .from("nuc_cycles")
      .insert([
        {
          apiary_id: hive.apiary_id,
          ruchette_hive_id: hive.hive_id,
          started_at: started_at || new Date().toISOString(),
        },
      ])
      .select()
      .single();

    if (cErr) return res.status(400).json({ error: cErr.message });
    return res.status(201).json({ ok: true, mode: "created", cycle: created });
  } catch (e) {
    console.error(e);
    return res.status(500).json({ error: "Unexpected server error" });
  }
});

/**
 * POST /api/nuc-cycles/:id/introduce
 * body: { cell_count?: number, cell_batch?: string, introduced_at?: ISO, check_after_days?: number }
 */
router.post("/:id/introduce", authenticateUser, async (req, res) => {
  const { id } = req.params;
  const { cell_count = 1, cell_batch, introduced_at, check_after_days = 20 } = req.body || {};

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
    console.error(e);
    return res.status(500).json({ error: "Unexpected server error" });
  }
});

/**
 * POST /api/nuc-cycles/:id/check
 * body: { result: 'ok' | 'no_eggs', reintroduce?: boolean, check_after_days?: number }
 */
router.post("/:id/check", authenticateUser, async (req, res) => {
  const { id } = req.params;
  const { result, reintroduce = false, check_after_days = 20 } = req.body || {};
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
    console.error(e);
    return res.status(500).json({ error: "Unexpected server error" });
  }
});

module.exports = router;
