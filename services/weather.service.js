// services/weather.service.js
const axios = require("axios");

async function fetchWeather(lat, lng) {
   const url =
      `https://api.open-meteo.com/v1/forecast` +
      `?latitude=${encodeURIComponent(lat)}` +
      `&longitude=${encodeURIComponent(lng)}` +
      `&timezone=auto` +
      `&forecast_days=7` +
      `&current=temperature_2m,wind_speed_10m,relative_humidity_2m,is_day,weather_code` +
      `&hourly=temperature_2m,wind_speed_10m,precipitation_probability,precipitation,relative_humidity_2m,weather_code` +
      `&daily=weather_code,temperature_2m_max,temperature_2m_min,precipitation_probability_max,precipitation_sum,wind_speed_10m_max`;

   const { data } = await axios.get(url, { timeout: 10000 });
   return data;
}

module.exports = { fetchWeather };
