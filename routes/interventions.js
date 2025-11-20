const express = require("express");
const router = express.Router();
const supabase = require("../utils/supabaseClient");
const authenticateUser = require("../middlewares/authMiddleware");

// Apply authentication to all routes
router.use(authenticateUser);
console.log("✅ Interventions router loaded (build: 2025-11-20-DEL-01)");

/* ------------------------------------------------------------------
   GET /intervention-types
   Returns ALL intervention types
------------------------------------------------------------------ */
router.get("/intervention-types", async (req, res) => {
   try {
      const { data, error } = await supabase
         .from("intervention_types")
         .select("*")
         .eq("is_active", true)
         .order("order_index", { ascending: true });

      if (error) throw error;

      return res.status(200).json({ types: data });
   } catch (err) {
      console.error("❌ Error fetching intervention types:", err);
      return res.status(500).json({ error: "Failed to fetch intervention types" });
   }
});

/* ------------------------------------------------------------------
   GET /products
   Returns ALL products
------------------------------------------------------------------ */
router.get("/products", async (req, res) => {
   try {
      const { data, error } = await supabase
         .from("products")
         .select("*")
         .order("name", { ascending: true });

      if (error) throw error;

      return res.status(200).json({ products: data });
   } catch (err) {
      console.error("❌ Error fetching products:", err);
      return res.status(500).json({ error: "Failed to fetch products" });
   }
});

/* ------------------------------------------------------------------
   POST /interventions
   Create a new intervention + link it to hives
------------------------------------------------------------------ */
router.post("/", async (req, res) => {
   const userId = req.user.id;

   try {
      const {
         apiary_id,
         intervention_type_id,
         product_id,
         product_used,
         date_time,
         quantity_mode,
         qty_per_hive,
         qty_total_apiary,
         unit,
         hive_ids = [],
         apply_to_all_hives = false,
         notes,
      } = req.body || {};

      // Basic validation
      if (!apiary_id || !intervention_type_id || !quantity_mode) {
         return res.status(400).json({
            error: "apiary_id, intervention_type_id and quantity_mode are required",
         });
      }

      if (!["PER_HIVE", "TOTAL_APIARY"].includes(quantity_mode)) {
         return res.status(400).json({ error: "Invalid quantity_mode" });
      }

      if (quantity_mode === "PER_HIVE" && qty_per_hive == null) {
         return res.status(400).json({ error: "qty_per_hive is required" });
      }

      if (quantity_mode === "TOTAL_APIARY" && qty_total_apiary == null) {
         return res.status(400).json({ error: "qty_total_apiary is required" });
      }

      // ------------------------------------------------------------------
      // Resolve hive list
      // ------------------------------------------------------------------
      let finalHiveIds = hive_ids;

      if (apply_to_all_hives) {
         const { data: hives, error: hivesError } = await supabase
            .from("hives")
            .select("hive_id")
            .eq("apiary_id", apiary_id)
            .eq("in_service", true);

         if (hivesError) throw hivesError;

         finalHiveIds = (hives || []).map((h) => h.hive_id);
      }

      const colonies_count =
         finalHiveIds.length > 0 ? finalHiveIds.length : null;

      // ------------------------------------------------------------------
      // Insert into interventions (main table)
      // ------------------------------------------------------------------
      const { data: intervention, error: interventionError } = await supabase
         .from("interventions")
         .insert({
            apiary_id,
            user_id: userId,
            intervention_type_id,
            date_time: date_time || new Date().toISOString(),
            product_id,
            product_used,
            quantity_mode,
            qty_per_hive,
            qty_total_apiary,
            unit,
            colonies_count,
            notes,
         })
         .select("*")
         .single();

      if (interventionError) throw interventionError;

      // ------------------------------------------------------------------
      // Insert into intervention_hives (link table)
      // ------------------------------------------------------------------
      let hiveLinks = [];

      if (finalHiveIds.length > 0) {
         const rows = finalHiveIds.map((hiveId) => ({
            intervention_id: intervention.id,
            hive_id: hiveId,
            qty_for_this_hive:
               quantity_mode === "PER_HIVE" ? qty_per_hive : null,
         }));

         const { data: insertedLinks, error: linkError } = await supabase
            .from("intervention_hives")
            .insert(rows)
            .select("*");

         if (linkError) throw linkError;

         hiveLinks = insertedLinks;
      }

      return res.status(201).json({
         message: "Intervention created successfully",
         intervention,
         hives_linked: hiveLinks,
      });
   } catch (err) {
      console.error("❌ Error creating intervention:", err);
      return res.status(500).json({ error: "Unexpected server error" });
   }
});

/* ------------------------------------------------------------------
   GET /apiaries/:apiaryId/interventions
   List interventions for one apiary (WITH hives)
------------------------------------------------------------------ */
router.get("/apiaries/:apiaryId/interventions", async (req, res) => {
   try {
      const { apiaryId } = req.params;

      const { data, error } = await supabase
         .from("interventions")
         .select(`
            *,
            intervention_types (*),
            products (*),
            intervention_hives (
               hive_id,
               qty_for_this_hive,
               hives (
                  hive_code
               )
            )
         `)
         .eq("apiary_id", apiaryId)
         .order("date_time", { ascending: false });

      if (error) throw error;

      return res.status(200).json({ interventions: data });
   } catch (err) {
      console.error("❌ Error fetching interventions for apiary:", err);
      return res.status(500).json({ error: "Failed to fetch interventions" });
   }
});

/* ------------------------------------------------------------------
   GET /hives/:hiveId/interventions
   List interventions for one hive
------------------------------------------------------------------ */
router.get("/hives/:hiveId/interventions", async (req, res) => {
   try {
      const { hiveId } = req.params;

      const { data, error } = await supabase
         .from("intervention_hives")
         .select(`
            *,
            interventions (
               *,
               intervention_types (*),
               products (*)
            )
         `)
         .eq("hive_id", hiveId)
         .order("created_at", { ascending: false });

      if (error) throw error;

      return res.status(200).json({ interventions: data });
   } catch (err) {
      console.error("❌ Error fetching interventions for hive:", err);
      return res.status(500).json({ error: "Failed to fetch hive interventions" });
   }
});


/* ------------------------------------------------------------------
   DELETE /:id
   Delete one intervention + its linked hives
------------------------------------------------------------------ */
router.delete("/:id", async (req, res) => {
   const { id } = req.params;
   const userId = req.user.id; // from authenticateUser

   try {
      // 1) Delete linked hives rows (if any)
      const { error: linkError } = await supabase
         .from("intervention_hives")
         .delete()
         .eq("intervention_id", id);

      if (linkError) throw linkError;

      // 2) Delete the intervention itself (and ensure it belongs to this user)
      const { data, error: delError } = await supabase
         .from("interventions")
         .delete()
         .eq("id", id)
         .eq("user_id", userId)
         .select("*")
         .single();

      if (delError) {
         // If no row found
         if (delError.code === "PGRST116") {
            return res.status(404).json({ error: "Intervention not found" });
         }
         throw delError;
      }

      return res.status(200).json({
         message: "Intervention deleted successfully",
         intervention: data,
      });
   } catch (err) {
      console.error("❌ Error deleting intervention:", err);
      return res.status(500).json({ error: "Failed to delete intervention" });
   }
});


module.exports = router;
