const express = require('express');
const router = express.Router();
const supabase = require('../utils/supabaseClient');
const authenticateUser = require('../middlewares/authMiddleware');
const { v4: uuidv4 } = require('uuid');

// 🏢 إنشاء شركة جديدة
router.post('/', authenticateUser, async (req, res) => {
    const { company_number, siren, company_name, commune, department } = req.body;
  
    if (!company_number || !company_name) {
      return res.status(400).json({ error: 'company_number and company_name are required' });
    }
  
    // ✅ التحقق من صلاحية المستخدم
    const { data: profileData, error: profileError } = await supabase
      .from('user_profiles')
      .select('user_type')
      .eq('user_id', req.user.id)
      .single();
  
    if (profileError || !profileData || !['company_admin', 'super_admin'].includes(profileData.user_type)) {
      return res.status(403).json({ error: '❌ You are not authorized to create a company' });
    }
  
    // ✅ إذا مسموح له
    try {
      const { data, error } = await supabase
        .from('companies')
        .insert([{
          company_number,
          siren,
          company_name,
          commune,
          department,
          owner_user_id: req.user.id
        }])
        .select();
  
      if (error) {
        return res.status(400).json({ error: error.message });
      }
  
      res.status(201).json({ message: '✅ Company created successfully', company: data[0] });
    } catch (err) {
      res.status(500).json({ error: 'Unexpected server error' });
    }
  });
  


// ✉️ دعوة مستخدم إلى الشركة
router.post('/:companyId/invite', authenticateUser, async (req, res) => {
  const { email, role_id } = req.body;
  const companyId = req.params.companyId;

  if (!email || !role_id) {
    return res.status(400).json({ error: 'Email and role_id are required.' });
  }

  const token = uuidv4();

  const { data, error } = await supabase
    .from('invitations')
    .insert([{
      email,
      company_id: companyId,
      role_id,
      token
    }])
    .select();

  if (error) {
    return res.status(400).json({ error: error.message });
  }

  const invitationLink = `https://yourapp.com/invite/${token}`;

  res.status(201).json({
    message: '✅ Invitation created successfully',
    invitationLink,
    invitation: data[0]
  });
});

module.exports = router;
