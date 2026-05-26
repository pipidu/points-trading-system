// ============================================================
// Admin Routes - Settings & Points & Logs (Supabase)
// ============================================================
import { Hono } from 'hono';
import { v4 as uuidv4 } from 'uuid';
import { SupabaseClient } from '@supabase/supabase-js';
import { Env } from '../types';
import { authMiddleware, adminMiddleware } from '../middleware/auth';
import { getRealtimeBalance, adminAdjustPoints, getLedgerEntries, reconcileUserBalance } from '../services/points';
import { getAllSettings, setSetting, clearCache } from '../services/settings';

type Ctx = { Bindings: Env; Variables: { supabase: SupabaseClient; userId: string; userRole: string } };
const adminRoutes = new Hono<Ctx>();

// Get all settings
adminRoutes.get('/settings', authMiddleware, adminMiddleware, async (c) => {
  return c.json({ settings: await getAllSettings(c.get('supabase')) });
});

// Batch update settings
adminRoutes.put('/settings/batch', authMiddleware, adminMiddleware, async (c) => {
  const aid = c.get('userId') as string;
  const supabase = c.get('supabase');
  const b = await c.req.json<{ settings: Array<{ key: string; value: string }> }>();
  if (!b.settings?.length) return c.json({ error: 'settings array required' }, 400);
  const now = new Date().toISOString();
  for (const s of b.settings) await supabase.from('settings').upsert({ key: s.key, value: s.value, updated_at: now }, { onConflict: 'key' });
  await supabase.from('admin_logs').insert({ id: uuidv4(), admin_id: aid, action: 'update_settings', target_type: 'settings', target_id: '', detail: 'Batch update settings', created_at: now });
  clearCache();
  return c.json({ success: true });
});

// Update single setting
adminRoutes.put('/settings', authMiddleware, adminMiddleware, async (c) => {
  const aid = c.get('userId') as string;
  const supabase = c.get('supabase');
  const b = await c.req.json<{ key: string; value: string }>();
  await setSetting(supabase, b.key, b.value);
  const now = new Date().toISOString();
  await supabase.from('admin_logs').insert({ id: uuidv4(), admin_id: aid, action: 'update_setting', target_type: 'settings', target_id: b.key, detail: `Set: ${b.value}`, created_at: now });
  return c.json({ success: true });
});

// Adjust user points
adminRoutes.post('/points/adjust', authMiddleware, adminMiddleware, async (c) => {
  const aid = c.get('userId') as string;
  const supabase = c.get('supabase');
  const b = await c.req.json<{ user_id: string; amount: number; description?: string; expiry_seconds?: number|null }>();
  if (!b.user_id) return c.json({ error: 'user_id required' }, 400);
  const { data: u } = await supabase.from('users').select('id').eq('id',b.user_id).single();
  if (!u) return c.json({ error: 'User not found' }, 404);
  const exp = b.expiry_seconds && b.expiry_seconds > 0 ? new Date(Date.now()+b.expiry_seconds*1000).toISOString() : null;
  const r = await adminAdjustPoints(supabase, b.user_id, b.amount, aid, b.description||'Admin adjust', exp);
  const now = new Date().toISOString();
  await supabase.from('admin_logs').insert({ id: uuidv4(), admin_id: aid, action: 'adjust_points', target_type: 'user', target_id: b.user_id, detail: `Adjust: ${b.amount>=0?'+':''}${b.amount}`, created_at: now });
  return c.json({ success: true, balance_after: r.balanceAfter });
});

// My ledger
adminRoutes.get('/points/my-ledger', authMiddleware, async (c) => {
  const userId = c.get('userId') as string;
  const supabase = c.get('supabase');
  const r = await getLedgerEntries(supabase, userId, parseInt(c.req.query('page')||'1'), 50);
  return c.json({ ...r, realtime_balance: await getRealtimeBalance(supabase, userId) });
});

// User ledger (admin)
adminRoutes.get('/points/ledger/:userId', authMiddleware, adminMiddleware, async (c) => {
  const userId = c.req.param('userId') as string;
  const supabase = c.get('supabase');
  const r = await getLedgerEntries(supabase, userId, parseInt(c.req.query('page')||'1'), 20);
  return c.json({ ...r, realtime_balance: await getRealtimeBalance(supabase, userId) });
});

// User balance (admin)
adminRoutes.get('/points/balance/:userId', authMiddleware, adminMiddleware, async (c) => {
  const userId = c.req.param('userId') as string;
  const supabase = c.get('supabase');
  const { data: u } = await supabase.from('users').select('id,username,display_name').eq('id',userId).single();
  if (!u) return c.json({ error: 'User not found' }, 404);
  return c.json({ ...u, realtime_balance: await getRealtimeBalance(supabase, userId) });
});

// Reconcile balance
adminRoutes.post('/points/reconcile/:userId', authMiddleware, adminMiddleware, async (c) => {
  const userId = c.req.param('userId') as string;
  const supabase = c.get('supabase');
  const { data: u } = await supabase.from('users').select('id').eq('id',userId).single();
  if (!u) return c.json({ error: 'User not found' }, 404);
  return c.json({ success: true, user_id: userId, reconciled_balance: await reconcileUserBalance(supabase, userId) });
});

// Dashboard
adminRoutes.get('/dashboard', authMiddleware, adminMiddleware, async (c) => {
  const supabase = c.get('supabase');
  const { count: tu } = await supabase.from('users').select('*',{count:'exact',head:true}).eq('role','user');
  const { count: ps } = await supabase.from('task_submissions').select('*',{count:'exact',head:true}).eq('status','pending');
  const { count: po } = await supabase.from('redemption_orders').select('*',{count:'exact',head:true}).eq('status','pending');
  const { count: al } = await supabase.from('loans').select('*',{count:'exact',head:true}).eq('status','active');
  const { data: dd } = await supabase.from('loans').select('remaining').eq('status','defaulted');
  const { count: tt } = await supabase.from('tasks').select('*',{count:'exact',head:true}).eq('is_active',1);
  const { count: ti } = await supabase.from('shop_items').select('*',{count:'exact',head:true}).eq('is_active',1);
  return c.json({ total_users: tu??0, pending_submissions: ps??0, pending_orders: po??0, active_loans: al??0, defaulted_loan_amount: (dd??[]).reduce((s:any,r:any)=>s+r.remaining,0), total_tasks: tt??0, total_items: ti??0 });
});

// Admin logs
adminRoutes.get('/logs', authMiddleware, adminMiddleware, async (c) => {
  const page = parseInt(c.req.query('page')||'1');
  const ps = 30;
  const supabase = c.get('supabase');
  const { count } = await supabase.from('admin_logs').select('*',{count:'exact',head:true});
  const { data: logs } = await supabase.from('admin_logs').select('*').order('created_at',{ascending:false}).range((page-1)*ps, page*ps-1);
  const adminIds = Array.from(new Set((logs??[]).map((l:any)=>l.admin_id)));
  const { data: users } = adminIds.length ? await supabase.from('users').select('id,username').in('id',adminIds) : {data:[]};
  const userMap = new Map<string,string>();
  for (const u of (users??[])) userMap.set(u.id, u.username);
  return c.json({ logs: (logs??[]).map((l:any)=>({...l, admin_username: userMap.get(l.admin_id)})), total: count??0, page });
});

// Reset base points distribution
adminRoutes.post('/points/reset-base-distribution', authMiddleware, adminMiddleware, async (c) => {
  const aid = c.get('userId') as string;
  const supabase = c.get('supabase');
  await setSetting(supabase, 'base_points_last_distribution', '');
  const { runScheduledTasks } = await import('../services/cron');
  const logs = await runScheduledTasks(supabase, c.env);
  const now = new Date().toISOString();
  await supabase.from('admin_logs').insert({ id: uuidv4(), admin_id: aid, action: 'reset_base_points', target_type: 'settings', target_id: '', detail: 'Reset base points distribution', created_at: now });
  return c.json({ success: true, logs });
});

// Expiring points summary
adminRoutes.get('/points/expiring-summary', authMiddleware, adminMiddleware, async (c) => {
  const supabase = c.get('supabase');
  const now = new Date().toISOString();
  const sdl = new Date(Date.now()+7*86400000).toISOString();
  const { data: rows } = await supabase.from('point_ledger').select('user_id,amount,expires_at').gt('amount',0).not('expires_at','is',null).gt('expires_at',now).lte('expires_at',sdl).order('expires_at',{ascending:true});
  const m = new Map<string,{expiring_amount:number;earliest_expiry:string}>();
  for (const r of (rows??[])) {
    const e = m.get(r.user_id);
    if (e) { e.expiring_amount+=r.amount; if (r.expires_at<e.earliest_expiry) e.earliest_expiry=r.expires_at; }
    else m.set(r.user_id,{expiring_amount:r.amount,earliest_expiry:r.expires_at});
  }
  return c.json({ users: Array.from(m.entries()).map(([uid,v])=>({user_id:uid,...v})) });
});

// Clear all point ledger entries
adminRoutes.post('/points/clear-ledger', authMiddleware, adminMiddleware, async (c) => {
  const aid = c.get('userId') as string;
  const supabase = c.get('supabase');
  await supabase.from('point_ledger').delete().neq('user_id', '00000000-0000-0000-0000-000000000000');
  const now = new Date().toISOString();
  await supabase.from('admin_logs').insert({ id: uuidv4(), admin_id: aid, action: 'clear_ledger', target_type: 'point_ledger', target_id: '', detail: '清空全部点数流水', created_at: now });
  return c.json({ success: true });
});

export default adminRoutes;
