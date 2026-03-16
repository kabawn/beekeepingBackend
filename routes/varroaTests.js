const express = require("express");
const router = express.Router();

const supabase = require("../utils/supabaseClient");
const authenticateUser = require("../middlewares/authMiddleware");

// -------------------------
// Helpers
// -------------------------
function toNumber(value) {
  if (value === null || value === undefined || value === "") return null;
  const n = Number(value);
  return Number.isNaN(n) ? null : n;
}

function calculateInfestationRate(testType, mitesCount, beesSampled) {
  if (testType === "alcohol_wash" || testType === "sugar_roll") {
    if (!beesSampled || beesSampled <= 0) return null;
    return Number(((mitesCount / beesSampled) * 100).toFixed(3));
  }

  // sticky_board لا نحسب له infestation_rate بنفس المعادلة
  return null;
}

function calculateRiskLevel(testType, infestationRate, mitesCount) {
  if (testType === "alcohol_wash" || testType === "sugar_roll") {
    if (infestationRate == null) return null;
    if (infestationRate < 2) return "low";
    if (infestationRate < 3) return "moderate";
    return "high";
  }

  if (testType === "sticky_board") {
    if (mitesCount <= 2) return "low";
    if (mitesCount <= 5) return "moderate";
    return "high";
  }

  return null;
}

function buildRecommendation(testType, riskLevel) {
  if (!riskLevel) return null;

  if (testType === "sticky_board") {
    if (riskLevel === "low") return "Natural mite fall is low. Continue monitoring.";
    if (riskLevel === "moderate") return "Monitor this hive closely and repeat the sticky board test soon.";
    if (riskLevel === "high") return "High natural mite fall detected. Treatment is recommended.";
  }

  if (riskLevel === "low") {
    return "No treatment needed now. Continue monitoring.";
  }

  if (riskLevel === "moderate") {
    return "Monitor closely and repeat the test soon.";
  }

  if (riskLevel === "high") {
    return "Treatment is recommended for this hive/apiary.";
  }

  return null;
}

function getRequestUserId(req) {
  return (
    req.user?.id ||
    req.user?.user_id ||
    req.auth?.userId ||
    null
  );
}

// -------------------------
// POST /api/varroa-tests
// Create a new varroa test
// -------------------------
router.post("/", authenticateUser, async (req, res) => {
  try {
    const userId = getRequestUserId(req);

    if (!userId) {
      return res.status(401).json({
        success: false,
        message: "Unauthorized",
      });
    }

    const hive_id = toNumber(req.body.hive_id);
    const apiary_id = toNumber(req.body.apiary_id);
    const test_type = req.body.test_type;
    const mites_count = toNumber(req.body.mites_count);
    const bees_sampled = toNumber(req.body.bees_sampled);
    const notes = req.body.notes || null;
    const tested_at = req.body.tested_at || new Date().toISOString();

    const allowedTypes = ["alcohol_wash", "sugar_roll", "sticky_board"];

    if (!hive_id || !apiary_id || !test_type || mites_count === null) {
      return res.status(400).json({
        success: false,
        message: "hive_id, apiary_id, test_type and mites_count are required",
      });
    }

    if (!allowedTypes.includes(test_type)) {
      return res.status(400).json({
        success: false,
        message: "Invalid test_type",
      });
    }

    if (mites_count < 0) {
      return res.status(400).json({
        success: false,
        message: "mites_count must be 0 or greater",
      });
    }

    if (
      (test_type === "alcohol_wash" || test_type === "sugar_roll") &&
      (!bees_sampled || bees_sampled <= 0)
    ) {
      return res.status(400).json({
        success: false,
        message: "bees_sampled is required and must be > 0 for alcohol_wash and sugar_roll",
      });
    }

    const infestation_rate = calculateInfestationRate(
      test_type,
      mites_count,
      bees_sampled
    );

    const risk_level = calculateRiskLevel(
      test_type,
      infestation_rate,
      mites_count
    );

    const recommendation = buildRecommendation(test_type, risk_level);

    const payload = {
      hive_id,
      apiary_id,
      user_id: userId,
      test_type,
      mites_count,
      bees_sampled,
      infestation_rate,
      risk_level,
      recommendation,
      notes,
      tested_at,
    };

    const { data, error } = await supabase
      .from("varroa_tests")
      .insert([payload])
      .select()
      .single();

    if (error) {
      console.error("POST /varroa-tests error:", error);
      return res.status(500).json({
        success: false,
        message: "Failed to create varroa test",
        error: error.message,
      });
    }

    return res.status(201).json({
      success: true,
      message: "Varroa test created successfully",
      data,
    });
  } catch (err) {
    console.error("POST /varroa-tests server error:", err);
    return res.status(500).json({
      success: false,
      message: "Server error while creating varroa test",
    });
  }
});

// -------------------------
// GET /api/varroa-tests/hive/:hiveId
// Get all tests for one hive
// -------------------------
router.get("/hive/:hiveId", authenticateUser, async (req, res) => {
  try {
    const userId = getRequestUserId(req);
    const hiveId = toNumber(req.params.hiveId);

    if (!userId) {
      return res.status(401).json({
        success: false,
        message: "Unauthorized",
      });
    }

    if (!hiveId) {
      return res.status(400).json({
        success: false,
        message: "Invalid hiveId",
      });
    }

    const { data, error } = await supabase
      .from("varroa_tests")
      .select("*")
      .eq("user_id", userId)
      .eq("hive_id", hiveId)
      .order("tested_at", { ascending: false });

    if (error) {
      console.error("GET /varroa-tests/hive/:hiveId error:", error);
      return res.status(500).json({
        success: false,
        message: "Failed to fetch hive varroa tests",
        error: error.message,
      });
    }

    return res.status(200).json({
      success: true,
      data: data || [],
    });
  } catch (err) {
    console.error("GET /varroa-tests/hive/:hiveId server error:", err);
    return res.status(500).json({
      success: false,
      message: "Server error while fetching hive varroa tests",
    });
  }
});

// -------------------------
// GET /api/varroa-tests/apiary/:apiaryId
// Get all tests for one apiary
// -------------------------
router.get("/apiary/:apiaryId", authenticateUser, async (req, res) => {
  try {
    const userId = getRequestUserId(req);
    const apiaryId = toNumber(req.params.apiaryId);

    if (!userId) {
      return res.status(401).json({
        success: false,
        message: "Unauthorized",
      });
    }

    if (!apiaryId) {
      return res.status(400).json({
        success: false,
        message: "Invalid apiaryId",
      });
    }

    const { data, error } = await supabase
      .from("varroa_tests")
      .select("*")
      .eq("user_id", userId)
      .eq("apiary_id", apiaryId)
      .order("tested_at", { ascending: false });

    if (error) {
      console.error("GET /varroa-tests/apiary/:apiaryId error:", error);
      return res.status(500).json({
        success: false,
        message: "Failed to fetch apiary varroa tests",
        error: error.message,
      });
    }

    return res.status(200).json({
      success: true,
      data: data || [],
    });
  } catch (err) {
    console.error("GET /varroa-tests/apiary/:apiaryId server error:", err);
    return res.status(500).json({
      success: false,
      message: "Server error while fetching apiary varroa tests",
    });
  }
});

// -------------------------
// GET /api/varroa-tests/apiary/:apiaryId/summary
// Get latest summary for one apiary
// -------------------------
router.get("/apiary/:apiaryId/summary", authenticateUser, async (req, res) => {
  try {
    const userId = getRequestUserId(req);
    const apiaryId = toNumber(req.params.apiaryId);

    if (!userId) {
      return res.status(401).json({
        success: false,
        message: "Unauthorized",
      });
    }

    if (!apiaryId) {
      return res.status(400).json({
        success: false,
        message: "Invalid apiaryId",
      });
    }

    const { data, error } = await supabase
      .from("varroa_tests")
      .select("*")
      .eq("user_id", userId)
      .eq("apiary_id", apiaryId)
      .order("tested_at", { ascending: false });

    if (error) {
      console.error("GET /varroa-tests/apiary/:apiaryId/summary error:", error);
      return res.status(500).json({
        success: false,
        message: "Failed to fetch apiary varroa summary",
        error: error.message,
      });
    }

    const tests = data || [];

    const latestPerHiveMap = new Map();
    for (const test of tests) {
      if (!latestPerHiveMap.has(test.hive_id)) {
        latestPerHiveMap.set(test.hive_id, test);
      }
    }

    const latestPerHive = Array.from(latestPerHiveMap.values());

    const numericRates = latestPerHive
      .map((item) => Number(item.infestation_rate))
      .filter((n) => !Number.isNaN(n));

    const average_infestation_rate =
      numericRates.length > 0
        ? Number(
            (
              numericRates.reduce((sum, n) => sum + n, 0) / numericRates.length
            ).toFixed(3)
          )
        : null;

    const counts = {
      low: latestPerHive.filter((t) => t.risk_level === "low").length,
      moderate: latestPerHive.filter((t) => t.risk_level === "moderate").length,
      high: latestPerHive.filter((t) => t.risk_level === "high").length,
    };

    let risk_level = "low";
    let recommendation = "Continue monitoring this apiary.";

    if (counts.high > 0 || (average_infestation_rate !== null && average_infestation_rate >= 3)) {
      risk_level = "high";
      recommendation = "High varroa risk detected. Treatment is recommended for this apiary.";
    } else if (
      counts.moderate > 0 ||
      (average_infestation_rate !== null && average_infestation_rate >= 2)
    ) {
      risk_level = "moderate";
      recommendation = "Moderate varroa risk detected. Monitor closely and repeat testing soon.";
    }

    return res.status(200).json({
      success: true,
      data: {
        apiary_id: apiaryId,
        tested_hives_count: latestPerHive.length,
        average_infestation_rate,
        risk_level,
        recommendation,
        counts,
        latest_tests_per_hive: latestPerHive,
      },
    });
  } catch (err) {
    console.error("GET /varroa-tests/apiary/:apiaryId/summary server error:", err);
    return res.status(500).json({
      success: false,
      message: "Server error while fetching apiary varroa summary",
    });
  }
});

// -------------------------
// PUT /api/varroa-tests/:id
// Update one test
// -------------------------
router.put("/:id", authenticateUser, async (req, res) => {
  try {
    const userId = getRequestUserId(req);
    const id = toNumber(req.params.id);

    if (!userId) {
      return res.status(401).json({
        success: false,
        message: "Unauthorized",
      });
    }

    if (!id) {
      return res.status(400).json({
        success: false,
        message: "Invalid id",
      });
    }

    const { data: existing, error: fetchError } = await supabase
      .from("varroa_tests")
      .select("*")
      .eq("id", id)
      .eq("user_id", userId)
      .single();

    if (fetchError || !existing) {
      return res.status(404).json({
        success: false,
        message: "Varroa test not found",
      });
    }

    const test_type = req.body.test_type || existing.test_type;
    const mites_count =
      req.body.mites_count !== undefined
        ? toNumber(req.body.mites_count)
        : existing.mites_count;

    const bees_sampled =
      req.body.bees_sampled !== undefined
        ? toNumber(req.body.bees_sampled)
        : existing.bees_sampled;

    const notes =
      req.body.notes !== undefined ? req.body.notes : existing.notes;

    const tested_at =
      req.body.tested_at !== undefined ? req.body.tested_at : existing.tested_at;

    const allowedTypes = ["alcohol_wash", "sugar_roll", "sticky_board"];
    if (!allowedTypes.includes(test_type)) {
      return res.status(400).json({
        success: false,
        message: "Invalid test_type",
      });
    }

    if (mites_count === null || mites_count < 0) {
      return res.status(400).json({
        success: false,
        message: "mites_count must be 0 or greater",
      });
    }

    if (
      (test_type === "alcohol_wash" || test_type === "sugar_roll") &&
      (!bees_sampled || bees_sampled <= 0)
    ) {
      return res.status(400).json({
        success: false,
        message: "bees_sampled is required and must be > 0 for alcohol_wash and sugar_roll",
      });
    }

    const infestation_rate = calculateInfestationRate(
      test_type,
      mites_count,
      bees_sampled
    );

    const risk_level = calculateRiskLevel(
      test_type,
      infestation_rate,
      mites_count
    );

    const recommendation = buildRecommendation(test_type, risk_level);

    const payload = {
      test_type,
      mites_count,
      bees_sampled,
      infestation_rate,
      risk_level,
      recommendation,
      notes,
      tested_at,
    };

    const { data, error } = await supabase
      .from("varroa_tests")
      .update(payload)
      .eq("id", id)
      .eq("user_id", userId)
      .select()
      .single();

    if (error) {
      console.error("PUT /varroa-tests/:id error:", error);
      return res.status(500).json({
        success: false,
        message: "Failed to update varroa test",
        error: error.message,
      });
    }

    return res.status(200).json({
      success: true,
      message: "Varroa test updated successfully",
      data,
    });
  } catch (err) {
    console.error("PUT /varroa-tests/:id server error:", err);
    return res.status(500).json({
      success: false,
      message: "Server error while updating varroa test",
    });
  }
});

// -------------------------
// DELETE /api/varroa-tests/:id
// Delete one test
// -------------------------
router.delete("/:id", authenticateUser, async (req, res) => {
  try {
    const userId = getRequestUserId(req);
    const id = toNumber(req.params.id);

    if (!userId) {
      return res.status(401).json({
        success: false,
        message: "Unauthorized",
      });
    }

    if (!id) {
      return res.status(400).json({
        success: false,
        message: "Invalid id",
      });
    }

    const { error } = await supabase
      .from("varroa_tests")
      .delete()
      .eq("id", id)
      .eq("user_id", userId);

    if (error) {
      console.error("DELETE /varroa-tests/:id error:", error);
      return res.status(500).json({
        success: false,
        message: "Failed to delete varroa test",
        error: error.message,
      });
    }

    return res.status(200).json({
      success: true,
      message: "Varroa test deleted successfully",
    });
  } catch (err) {
    console.error("DELETE /varroa-tests/:id server error:", err);
    return res.status(500).json({
      success: false,
      message: "Server error while deleting varroa test",
    });
  }
});

module.exports = router;