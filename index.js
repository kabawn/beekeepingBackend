const express = require("express");
const cors = require("cors");
require("dotenv").config();
const app = express();

app.use(cors());
app.use(express.json());

// 🌍 Add logging middleware
app.use((req, res, next) => {
   console.log(`📡 ${req.method} Request to ${req.url}`);
   console.log("🔹 Headers:", req.headers);
   console.log("🔹 Body:", req.body);
   console.log("🔹 Params:", req.params);
   console.log("🔹 Query:", req.query);
   next();
});

// Import routers
const apiariesRouter = require("./routes/apiaries");
const hivesRouter = require("./routes/hives");
const queensRouter = require("./routes/queens");
const supersRouter = require("./routes/supers");
const harvestsRouter = require("./routes/harvests");
const harvestAnalysisRouter = require("./routes/harvestAnalysis");
const inspectionsRoutes = require("./routes/inspections");

// Mount routers
app.use("/api/apiaries", apiariesRouter);
app.use("/api/hives", hivesRouter);
app.use("/api/queens", queensRouter);
app.use("/api/supers", supersRouter);
app.use("/api/harvests", harvestsRouter);
app.use("/api/harvest-analysis", harvestAnalysisRouter);
app.use("/api/inspections", inspectionsRoutes);

app.get("/", (req, res) => {
   res.send("Hello from B-Stats backend!");
});

// Allow server to listen on all network interfaces
const PORT = process.env.PORT || 3000;
const HOST = "0.0.0.0";

app.listen(PORT, HOST, () => {
   console.log(`🚀 Server running at http://${HOST}:${PORT}`);
});
