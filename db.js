const { Pool } = require("pg");
require("dotenv").config();

console.log("🔍 Connecting to database...");

const pool = new Pool({
   connectionString: process.env.DATABASE_URL,
   ssl: { rejectUnauthorized: false },
});

pool
   .connect()
   .then(() => console.log("✅ Database connected successfully"))
   .catch((err) => console.error("❌ Database connection failed:", err));

module.exports = pool;
