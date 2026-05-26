// ============================================================
// Loan Routes (Supabase)
// ============================================================
import { Hono } from 'hono';
import { v4 as uuidv4 } from 'uuid';
import { SupabaseClient } from '@supabase/supabase-js';
import { Env } from '../types';
import { authMiddleware, adminMiddleware } from '../middleware/auth';
import { getRealtimeBalance, addPoints, deductPointsFIFO } from '../services/points';
import { getSettingNumber } from '../services/settings';

type Ctx = { Bindings: Env; Variables: { supabase: SupabaseClient; userId: string; userRole: string } };
const loanRoutes = new Hono<Ctx>();

// Borrow
loanRoutes.post('/borrow', authMiddleware, async (c) => {
  const userId = c.get('userId') as string;
  const b = await c.req.json<{ amount: number }>();
  const amt = Math.floor(b.amount);
  if (!amt || amt <= 0) return c.json({ error: 'Amount must be positive' }, 400);
  const supabase = c.get('supabase');
  const rate = await getSettingNumber(supabase, 'loan_weekly_interest_rate', 0.05);
  const now = new Date().toISOString();
  const lid = uuidv4();
  await supabase.from('loans').insert({ id: lid, user_id: userId, principal: amt, remaining: amt, weekly_interest_rate: rate, status: 'active', borrowed_at: now, last_interest_at: now, created_at: now });
  await addPoints(supabase, userId, amt, 'loan_repay', lid, `Loan: ${amt}pts`, null);
  return c.json({ success: true, loan: { id: lid, principal: amt, remaining: amt, rate }, balance: await getRealtimeBalance(supabase, userId) }, 201);
});

// Repay
loanRoutes.post('/repay', authMiddleware, async (c) => {
  const userId = c.get('userId') as string;
  const b = await c.req.json<{ loan_id: string; amount: number }>();
  const amt = Math.floor(b.amount);
  if (!b.loan_id || !amt || amt <= 0) return c.json({ error: 'Invalid amount' }, 400);
  const supabase = c.get('supabase');
  const { data: loan } = await supabase.from('loans').select('*').eq('id',b.loan_id).eq('user_id',userId).eq('status','active').single();
  if (!loan) return c.json({ error: 'Loan not found' }, 404);
  const act = Math.min(amt, loan.remaining);
  const dr = await deductPointsFIFO(supabase, userId, act, 'loan_repay', b.loan_id, 'Repay loan');
  if (!dr.success) return c.json({ error: 'Insufficient points', balance: dr.balanceAfter }, 400);
  const nr = loan.remaining - act;
  const st = nr <= 0 ? 'repaid' : 'active';
  const now = new Date().toISOString();
  await supabase.from('loans').update({ remaining: nr, status: st, ...(st==='repaid'?{repaid_at:now}:{}) }).eq('id',b.loan_id);
  await supabase.from('loan_repayments').insert({ id: uuidv4(), loan_id: b.loan_id, user_id: userId, amount: act, created_at: now });
  return c.json({ success: true, repaid: act, remaining: nr, status: st, balance: await getRealtimeBalance(supabase, userId) });
});

// My loans
loanRoutes.get('/my', authMiddleware, async (c) => {
  const userId = c.get('userId') as string;
  const supabase = c.get('supabase');
  const { data: loans } = await supabase.from('loans').select('*').eq('user_id',userId).order('created_at',{ascending:false});
  const en = [];
  for (const l of (loans??[])) {
    const { data: reps } = await supabase.from('loan_repayments').select('amount').eq('loan_id',l.id);
    en.push({...l, total_repaid: (reps??[]).reduce((s:any,r:any)=>s+r.amount,0)});
  }
  return c.json({ loans: en });
});

// Admin: all loans
loanRoutes.get('/admin/all', authMiddleware, adminMiddleware, async (c) => {
  const sf = c.req.query('status') || '';
  const supabase = c.get('supabase');
  let q = supabase.from('loans').select('*');
  if (sf) q = q.eq('status',sf);
  const { data: loans } = await q.order('created_at',{ascending:false});
  const userIds = Array.from(new Set((loans??[]).map((l:any)=>l.user_id)));
  const { data: users } = userIds.length ? await supabase.from('users').select('id,username,display_name').in('id',userIds) : {data:[]};
  const userMap = new Map<string,any>();
  for (const u of (users??[])) userMap.set(u.id, u);
  const en = [];
  for (const l of (loans??[])) {
    const { data: reps } = await supabase.from('loan_repayments').select('amount').eq('loan_id',l.id);
    en.push({...l, username: userMap.get(l.user_id)?.username, display_name: userMap.get(l.user_id)?.display_name, total_repaid: (reps??[]).reduce((s:any,r:any)=>s+r.amount,0)});
  }
  return c.json({ loans: en });
});

// Admin: adjust loan
loanRoutes.post('/admin/adjust', authMiddleware, adminMiddleware, async (c) => {
  const aid = c.get('userId') as string;
  const b = await c.req.json<{ loan_id: string; action: 'mark_repaid'|'mark_defaulted' }>();
  const supabase = c.get('supabase');
  const { data: loan } = await supabase.from('loans').select('id').eq('id',b.loan_id).single();
  if (!loan) return c.json({ error: 'Loan not found' }, 404);
  await supabase.from('loans').update({ status: b.action==='mark_repaid'?'repaid':'defaulted' }).eq('id',b.loan_id);
  const now = new Date().toISOString();
  await supabase.from('admin_logs').insert({ id: uuidv4(), admin_id: aid, action: 'adjust_loan', target_type: 'loan', target_id: b.loan_id, detail: `Mark as: ${b.action}`, created_at: now });
  return c.json({ success: true });
});

export default loanRoutes;
