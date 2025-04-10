const express = require('express');
const router = express.Router();
const supabase = require('../utils/supabaseClient');

// ✅ تسجيل مستخدم جديد
router.post('/signup', async (req, res) => {
  const { email, password, full_name } = req.body;

  // 🔍 تحقق من وجود الحقول المطلوبة
  if (!email || !password || !full_name) {
    return res.status(400).json({ error: 'email, password, and full_name are required' });
  }

  try {
    // 1️⃣ إنشاء المستخدم في Supabase Auth
    const { data: userData, error: signUpError } = await supabase.auth.admin.createUser({
      email,
      password,
      email_confirm: true
    });

    if (signUpError) {
      return res.status(400).json({ error: `Auth error: ${signUpError.message}` });
    }

    const userId = userData.user.id;

    // 2️⃣ إضافة بيانات المستخدم في جدول user_profiles
    const { error: profileError } = await supabase
      .from('user_profiles')
      .insert([{ user_id: userId, full_name }]);

    if (profileError) {
      return res.status(400).json({ error: `Profile error: ${profileError.message}` });
    }

    // ✅ النجاح
    res.status(201).json({ message: '✅ User created successfully', userId });
  } catch (err) {
    console.error('Unexpected error during signup:', err.message);
    res.status(500).json({ error: 'Unexpected server error. Please try again.' });
  }
});

// تسجيل الدخول
router.post('/login', async (req, res) => {
    const { email, password } = req.body;
  
    // تحقق من الحقول
    if (!email || !password) {
      return res.status(400).json({ error: 'Email and password are required' });
    }
  
    try {
      // تسجيل الدخول عبر Supabase
      const { data, error } = await supabase.auth.signInWithPassword({
        email,
        password
      });
  
      if (error) {
        return res.status(401).json({ error: error.message });
      }
  
      // session + user info
      res.status(200).json({
        message: '✅ Login successful',
        user: data.user,
        access_token: data.session.access_token,
        refresh_token: data.session.refresh_token
      });
    } catch (err) {
      console.error('Login error:', err.message);
      res.status(500).json({ error: 'Unexpected server error. Try again.' });
    }
  });
  

module.exports = router;
