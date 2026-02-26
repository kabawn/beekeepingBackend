const express = require("express");
const cors = require("cors");
require("dotenv").config();

const app = express();

// ✅ Railway / proxies
app.set("trust proxy", 1);

app.use(cors());
app.use(express.json());
app.set("etag", false);

// ✅ health + root FIRST (fast, no auth, no db)
app.get("/health", (req, res) => res.status(200).send("ok"));
app.get("/", (req, res) => res.status(200).send("Hello from B-Stats backend!"));

// 🔎 Safe request logger
app.use((req, res, next) => {
   const start = Date.now();
   res.on("finish", () => {
      const ms = Date.now() - start;
      console.log(`➡️ ${req.method} ${req.originalUrl} -> ${res.statusCode} (${ms}ms)`);
   });
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
const authRoutes = require("./routes/auth");
const companiesRouter = require("./routes/companies");
const invitationsRoutes = require("./routes/invitations");
const hivesQrPdfRouter = require("./routes/hivesQrPdf");
const apiaryNotesRouter = require("./routes/apiaryNotes");
const queenPedigreeRouter = require("./routes/queenPedigree");
const queenCharacteristicsRouter = require("./routes/queenCharacteristics");
const hivesPublicRouter = require("./routes/hivesPublic");
const availablePublicKeysRoutes = require("./routes/availablePublicKeys");
const notationConfigRouter = require("./routes/notationConfig");
const colonyNotationsRouter = require("./routes/colonyNotations");
const infoQueenRouter = require("./routes/infoQueen");
const inventoryRouter = require("./routes/inventory");
const pairingSessions = require("./routes/pairingSessions");
const notationSessionsRouter = require("./routes/notationSessions");
const nucCycles = require("./routes/nucCycles");
const hiveTypesRoutes = require("./routes/hiveTypes");
const hivePurposesRoutes = require("./routes/hivePurposes");
const interventionsRoutes = require("./routes/interventions");
const swarmProductionRoutes = require("./routes/swarmProduction");
const hiveEvaluationsRouter = require("./routes/hiveEvaluations");
const hiveDescriptorsRouter = require("./routes/hiveDescriptors");
const hivePerformanceRouter = require("./routes/hivePerformance");
const analyticsEvaluationsLongRouter = require("./routes/analyticsEvaluationsLong");
const queenRoutes = require("./routes/queen");
const dashboardRouter = require("./routes/dashboard");
const adminRoutes = require("./routes/admin");
const adminSupportRouter = require("./routes/adminSupport");
const diagRouter = require("./routes/diag");
const apiaryChecklistRouter = require("./routes/apiaryChecklist");
const weatherRouter = require("./routes/weather");


// Mount routers
app.use("/api/apiaries", apiariesRouter);
app.use("/api/hives", hivesRouter);
app.use("/api/queens", queensRouter);
app.use("/api/supers", supersRouter);
app.use("/api/harvests", harvestsRouter);
app.use("/api/harvest-analysis", harvestAnalysisRouter);
app.use("/api/inspections", inspectionsRoutes);
app.use("/api/auth", authRoutes);
app.use("/api/companies", companiesRouter);
app.use("/api/invitations", invitationsRoutes);
app.use("/api/hives/pdf", hivesQrPdfRouter);
app.use("/api/apiary-notes", apiaryNotesRouter);
app.use("/api/queen-pedigree", queenPedigreeRouter);
app.use("/api/queen-characteristics", queenCharacteristicsRouter);
app.use("/api/hives/public", hivesPublicRouter);
app.use("/api/available-keys", availablePublicKeysRoutes);
app.use("/api/notation-config", notationConfigRouter);
app.use("/api/colony-notations", colonyNotationsRouter);
app.use("/api/info-queen", infoQueenRouter);
app.use("/api/inventory", inventoryRouter);
app.use("/api/pairing-sessions", pairingSessions);
app.use("/api/notation-sessions", notationSessionsRouter);
app.use("/api/nuc-cycles", nucCycles);
app.use("/api/super-types", require("./routes/superTypes"));
app.use("/api/hive-types", hiveTypesRoutes);
app.use("/api/hive-purposes", hivePurposesRoutes);
app.use("/api/nuc-sessions", require("./routes/nucSessions"));
app.use("/api/interventions", interventionsRoutes);
app.use("/api/swarm", swarmProductionRoutes);
app.use("/api/hive-evaluations", hiveEvaluationsRouter);
app.use("/api/hive-descriptors", hiveDescriptorsRouter);
app.use("/api/hive-performance", hivePerformanceRouter);
app.use("/api/analytics", analyticsEvaluationsLongRouter);
app.use("/api/queen", queenRoutes);
app.use("/api/dashboard", dashboardRouter);
app.use("/api/admin", adminRoutes);
app.use("/api", adminSupportRouter);
app.use("/api/diag", diagRouter);
app.use("/api/apiary-checklist", apiaryChecklistRouter);
app.use("/api/weather", require("./routes/weather"));
// ✅ Start server
const PORT = Number(process.env.PORT) || 8080;
const HOST = "0.0.0.0";

console.log("✅ BOOT: process.env.PORT =", process.env.PORT);
console.log("✅ BOOT: about to listen...", HOST, PORT);

const server = app.listen(PORT, HOST, () => {
   console.log(`🚀 Server running at http://${HOST}:${PORT}`);
});

// ✅ Graceful shutdown (fix 502 during restarts)
process.on("SIGTERM", () => {
   console.log("🛑 SIGTERM received. Closing server...");
   server.close(() => {
      console.log("✅ Server closed.");
      process.exit(0);
   });
});
