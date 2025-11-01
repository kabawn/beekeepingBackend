const jwt = require("jsonwebtoken");

const SECRET = process.env.JWT_SECRET;
if (!SECRET) {
  console.error("Set JWT_SECRET in your shell before running.");
  process.exit(1);
}

// Identity of THIS Pi station:
const payload = {
  sub: "device:tarn_scale_01",
  role: "station",
  station: "tarn_scale_01",
};

// 1-year validity (rotate annually if you want)
const token = jwt.sign(payload, SECRET, { expiresIn: "365d" });
console.log(token);
