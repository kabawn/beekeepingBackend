const express = require('express');
const cors = require('cors'); // Import CORS to allow cross-origin requests
require('dotenv').config();
const app = express();

app.use(cors()); // Allow cross-origin requests
app.use(express.json());

// Import routers
const apiariesRouter = require('./routes/apiaries'); // Existing router for apiaries
const hivesRouter = require('./routes/hives');       // Router for hives
const queensRouter = require('./routes/queens');     // Router for queens
const supersRouter = require('./routes/supers');     // New router for supers
const harvestsRouter = require('./routes/harvests');
const harvestAnalysisRouter = require('./routes/harvestAnalysis');
const inspectionsRoutes = require("./routes/inspections");

// Mount routers
app.use('/api/apiaries', apiariesRouter);
app.use('/api/hives', hivesRouter);
app.use('/api/queens', queensRouter);
app.use('/api/supers', supersRouter);
app.use('/api/harvests', harvestsRouter);
app.use('/api/harvest-analysis', harvestAnalysisRouter);
app.use("/api/inspections", inspectionsRoutes);

app.get('/', (req, res) => {
  res.send("Hello from B-Stats backend!");
});

// Allow server to listen on all network interfaces
const PORT = process.env.PORT || 3000;
const HOST = "0.0.0.0"; // Allow external devices to connect

app.listen(PORT, HOST, () => {
  console.log(`🚀 Server running at http://${HOST}:${PORT}`);
});
