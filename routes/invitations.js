const express = require('express');
const router = express.Router();
const supabase = require('../utils/supabaseClient');

// ✅ جلب تفاصيل الدعوة من خلال التوكن
router.get('/:token', async (req, res) => {
  const { token } = req.params;

  const { data, error } = await supabase
    .from('invitations')
    .select(`
      invitation_id,
      email,
      accepted,
      created_at,
      companies ( company_name ),
      roles ( name )
    `)
    .eq('token', token)
    .maybeSingle();

  if (error || !data) {
    return res.status(404).json({ error: 'Invitation not found or invalid token' });
  }

  res.status(200).json({
    message: '✅ Invitation fetched successfully',
    invitation: {
      email: data.email,
      company_name: data.companies?.company_name,
      role_name: data.roles?.name,
      accepted: data.accepted,
      created_at: data.created_at
    }
  });
});

// 📥 قبول الدعوة وإنشاء الحساب
router.post('/accept/:token', async (req, res) => {
    const { token } = req.params;
    const { password, full_name } = req.body;
  
    // جلب الدعوة
    const { data: invitation, error } = await supabase
      .from('invitations')
      .select('*')
      .eq('token', token)
      .eq('accepted', false)
      .maybeSingle();
  
    if (error || !invitation) {
      return res.status(404).json({ error: 'Invalid or expired invitation' });
    }
  
    const email = invitation.email;
  
    // 1. إنشاء المستخدم في Supabase Auth
    const { data: userData, error: createError } = await supabase.auth.admin.createUser({
      email,
      password,
      email_confirm: true
    });
  
    if (createError) {
      return res.status(400).json({ error: createError.message });
    }
  
    const userId = userData.user.id;
  
    // 2. إضافة إلى user_profiles
    await supabase
      .from('user_profiles')
      .insert([{ user_id: userId, full_name }]);
  
    // 3. ربطه بالشركة في staff_members
    await supabase
      .from('staff_members')
      .insert([{
        user_id: userId,
        company_id: invitation.company_id,
        role_id: invitation.role_id,
        active: true
      }]);
  
    // 4. تحديث حالة الدعوة إلى "مقبولة"
    await supabase
      .from('invitations')
      .update({ accepted: true })
      .eq('invitation_id', invitation.invitation_id);
  
    res.status(201).json({ message: '✅ Account created and invitation accepted successfully' });
  });
  

module.exports = router;
