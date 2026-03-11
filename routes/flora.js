const express = require("express");
const router = express.Router();
const supabase = require("../utils/supabaseClient");
const authenticateUser = require("../middlewares/authMiddleware");

// GET all flora records for current user
router.get("/", authenticateUser, async (req, res) => {
   try {
      const userId = req.user.id;

      const { data, error } = await supabase
         .from("flora_sources")
         .select("*")
         .eq("user_id", userId)
         .order("bloom_start", { ascending: true });

      if (error) {
         return res.status(500).json({
            success: false,
            message: "Failed to fetch flora sources",
            error: error.message,
         });
      }

      return res.json({
         success: true,
         data,
      });
   } catch (err) {
      return res.status(500).json({
         success: false,
         message: "Server error while fetching flora sources",
         error: err.message,
      });
   }
});

// POST create flora record
router.post("/", authenticateUser, async (req, res) => {
   try {
      const userId = req.user.id;

      const {
         apiary_id,
         scope = "regional",
         name,
         category = "nectar_pollen",
         location_name,
         latitude,
         longitude,
         bloom_start,
         bloom_end,
         nectar_potential,
         pollen_potential,
         notes,
      } = req.body;

      if (!name || !bloom_start || !bloom_end) {
         return res.status(400).json({
            success: false,
            message: "name, bloom_start and bloom_end are required",
         });
      }

      const { data, error } = await supabase
         .from("flora_sources")
         .insert([
            {
               user_id: userId,
               apiary_id,
               scope,
               name,
               category,
               location_name,
               latitude,
               longitude,
               bloom_start,
               bloom_end,
               nectar_potential,
               pollen_potential,
               notes,
            },
         ])
         .select()
         .single();

      if (error) {
         return res.status(500).json({
            success: false,
            message: "Failed to create flora source",
            error: error.message,
         });
      }

      return res.status(201).json({
         success: true,
         message: "Flora source created successfully",
         data,
      });
   } catch (err) {
      return res.status(500).json({
         success: false,
         message: "Server error while creating flora source",
         error: err.message,
      });
   }
});

// PUT update flora record
router.put("/:id", authenticateUser, async (req, res) => {
   try {
      const userId = req.user.id;
      const { id } = req.params;

      const {
         apiary_id,
         scope,
         name,
         category,
         location_name,
         latitude,
         longitude,
         bloom_start,
         bloom_end,
         nectar_potential,
         pollen_potential,
         notes,
      } = req.body;

      const { data, error } = await supabase
         .from("flora_sources")
         .update({
            apiary_id,
            scope,
            name,
            category,
            location_name,
            latitude,
            longitude,
            bloom_start,
            bloom_end,
            nectar_potential,
            pollen_potential,
            notes,
         })
         .eq("id", id)
         .eq("user_id", userId)
         .select()
         .single();

      if (error) {
         return res.status(500).json({
            success: false,
            message: "Failed to update flora source",
            error: error.message,
         });
      }

      return res.json({
         success: true,
         message: "Flora source updated successfully",
         data,
      });
   } catch (err) {
      return res.status(500).json({
         success: false,
         message: "Server error while updating flora source",
         error: err.message,
      });
   }
});

// DELETE flora record
router.delete("/:id", authenticateUser, async (req, res) => {
   try {
      const userId = req.user.id;
      const { id } = req.params;

      const { error } = await supabase
         .from("flora_sources")
         .delete()
         .eq("id", id)
         .eq("user_id", userId);

      if (error) {
         return res.status(500).json({
            success: false,
            message: "Failed to delete flora source",
            error: error.message,
         });
      }

      return res.json({
         success: true,
         message: "Flora source deleted successfully",
      });
   } catch (err) {
      return res.status(500).json({
         success: false,
         message: "Server error while deleting flora source",
         error: err.message,
      });
   }
});

module.exports = router;
