// ============================================================
// Auth Routes - Login / Create User / Change Password (Supabase)
// ============================================================
import { Hono } from 'hono';
import bcrypt from 'bcryptjs';
import { v4 as uuidv4 } from 'uuid';
import { SupabaseClient } from '@supabase/supabase-js';
import { Env } from '../types';
import { signToken, getUserByUsername } from '../services/auth';
import { authMiddleware, adminMiddleware } from '../middleware/auth';
import { getSetting } from '../services/settings';

type Ctx = { Bindings: Env; Variables: { supabase: SupabaseClient; userId: string; userRole: string } };
const authRoutes = new Hono<Ctx>();

// Login
authRoutes.post('/login', async (c) => {
  const { username, password, turnstile_token, captcha_id, captcha_answer } = await c.req.json<{
    username: string; password: string;
    turnstile_token?: string; captcha_id?: string; captcha_answer?: string;
  }>();
  if (!username || !password) return c.json({ error: 'Username and password required' }, 400);

  const supabase = c.get('supabase');
  const captchaMode = await getSetting(supabase, 'login_captcha_mode', 'none');

  if (captchaMode === 'turnstile' && c.env.TURNSTILE_SECRET_KEY) {
    if (!turnstile_token) return c.json({ error: 'Captcha required' }, 400);
    try {
      const res = await fetch('https://challenges.cloudflare.com/turnstile/v0/siteverify', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ secret: c.env.TURNSTILE_SECRET_KEY, response: turnstile_token }),
      });
      const r = await res.json() as { success: boolean };
      if (!r.success) return c.json({ error: 'Captcha failed' }, 400);
    } catch { return c.json({ error: 'Captcha service error' }, 500); }
  } else if (captchaMode === 'captcha') {
    if (!captcha_id || !captcha_answer) return c.json({ error: 'Captcha required' }, 400);
    const stored = await c.env.KV.get(`captcha:${captcha_id}`);
    if (!stored || stored.toLowerCase() !== captcha_answer.toLowerCase())
      return c.json({ error: 'Captcha incorrect' }, 400);
    await c.env.KV.delete(`captcha:${captcha_id}`);
  }

  const user = await getUserByUsername(supabase, username);
  if (!user) return c.json({ error: 'Invalid credentials' }, 401);
  if (!await bcrypt.compare(password, user.password_hash))
    return c.json({ error: 'Invalid credentials' }, 401);

  const token = await signToken(user, c.env);
  const ip = c.req.header('CF-Connecting-IP') || c.req.header('X-Forwarded-For') || '';
  const now = new Date().toISOString();
  await supabase.from('users').update({ last_login_at: now, last_login_ip: ip, updated_at: now }).eq('id', user.id);

  return c.json({ token, user: { id: user.id, username: user.username, role: user.role, display_name: user.display_name } });
});

// Admin: create user
authRoutes.post('/create-user', authMiddleware, adminMiddleware, async (c) => {
  const { username, password, display_name } = await c.req.json<{ username: string; password: string; display_name?: string }>();
  if (!username || !password) return c.json({ error: 'Username and password required' }, 400);

  const supabase = c.get('supabase');
  if (await getUserByUsername(supabase, username)) return c.json({ error: 'Username exists' }, 409);

  const hash = await bcrypt.hash(password, 10);
  const id = uuidv4();
  const now = new Date().toISOString();
  await supabase.from('users').insert({ id, username, password_hash: hash, role: 'user', display_name: display_name || username, created_at: now, updated_at: now });
  return c.json({ success: true, user: { id, username, display_name: display_name || username } }, 201);
});

// Change password
authRoutes.post('/change-password', authMiddleware, async (c) => {
  const { old_password, new_password } = await c.req.json<{ old_password: string; new_password: string }>();
  if (!old_password || !new_password) return c.json({ error: 'Both passwords required' }, 400);

  const userId = c.get('userId') as string;
  const supabase = c.get('supabase');
  const { data: user, error } = await supabase.from('users').select('*').eq('id', userId).single();
  if (error || !user) return c.json({ error: 'User not found' }, 404);
  if (!await bcrypt.compare(old_password, user.password_hash)) return c.json({ error: 'Old password incorrect' }, 403);

  await supabase.from('users').update({ password_hash: await bcrypt.hash(new_password, 10), updated_at: new Date().toISOString() }).eq('id', userId);
  return c.json({ success: true });
});

// Admin: list users
authRoutes.get('/users', authMiddleware, adminMiddleware, async (c) => {
  const page = parseInt(c.req.query('page') || '1');
  const search = c.req.query('search') || '';
  const pageSize = 20;
  const supabase = c.get('supabase');

  let q = supabase.from('users').select('id, username, role, display_name, balance_snapshot, created_at', { count: 'exact' });
  if (search) q = q.or(`username.ilike.%${search}%,display_name.ilike.%${search}%`);
  const { data: users, count } = await q.order('created_at', { ascending: false }).range((page - 1) * pageSize, page * pageSize - 1);
  return c.json({ users: users ?? [], total: count ?? 0, page, pageSize });
});

// Get current user
authRoutes.get('/me', authMiddleware, async (c) => {
  const userId = c.get('userId') as string;
  const supabase = c.get('supabase');
  const { data: user } = await supabase.from('users').select('id, username, role, display_name, last_login_at, last_login_ip, created_at').eq('id', userId).single();
  if (!user) return c.json({ error: 'User not found' }, 404);

  const { getRealtimeBalance } = await import('../services/points');
  const balance = await getRealtimeBalance(supabase, userId);

  const now = new Date().toISOString();
  const sdl = new Date(Date.now() + 7 * 86400000).toISOString();
  const { data: er } = await supabase.from('point_ledger').select('amount').eq('user_id', userId).gt('amount', 0).not('expires_at', 'is', null).gt('expires_at', now).lte('expires_at', sdl);
  const expiringPoints = (er ?? []).reduce((s: number, r: any) => s + r.amount, 0);

  const { getSettingNumber, getSetting } = await import('../services/settings');
  const pm = await getSettingNumber(supabase, 'base_points_period_minutes', 10080);
  const ld = await getSetting(supabase, 'base_points_last_distribution', '');
  const nd = ld ? new Date(new Date(ld).getTime() + pm * 60000).toISOString() : '';

  return c.json({ ...user, realtime_balance: balance, expiring_points: expiringPoints, next_base_distribution: nd });
});

// Admin: edit user
authRoutes.put('/users/:userId', authMiddleware, adminMiddleware, async (c) => {
  const tid = c.req.param('userId');
  const body = await c.req.json<{ username?: string; password?: string; display_name?: string; role?: string }>();
  const supabase = c.get('supabase');
  const { data: u } = await supabase.from('users').select('id').eq('id', tid).single();
  if (!u) return c.json({ error: 'User not found' }, 404);

  const now = new Date().toISOString();
  const aid = c.get('userId') as string;
  const up: Record<string, any> = { updated_at: now };
  if (body.username) {
    const ex = await getUserByUsername(supabase, body.username);
    if (ex && ex.id !== tid) return c.json({ error: 'Username taken' }, 409);
    up.username = body.username;
  }
  if (body.display_name !== undefined) up.display_name = body.display_name;
  if (body.role) up.role = body.role;
  if (body.password) up.password_hash = await bcrypt.hash(body.password, 10);
  await supabase.from('users').update(up).eq('id', tid);
  await supabase.from('admin_logs').insert({ id: uuidv4(), admin_id: aid, action: 'edit_user', target_type: 'user', target_id: tid, detail: 'Edit user', created_at: now });
  return c.json({ success: true });
});

// Admin: delete user
authRoutes.delete('/users/:userId', authMiddleware, adminMiddleware, async (c) => {
  const tid = c.req.param('userId');
  const supabase = c.get('supabase');
  const { data: u } = await supabase.from('users').select('id, role').eq('id', tid).single();
  if (!u) return c.json({ error: 'User not found' }, 404);
  if (u.role === 'admin') return c.json({ error: 'Cannot delete admin' }, 403);

  const aid = c.get('userId') as string;
  const now = new Date().toISOString();
  for (const t of ['task_submissions', 'redemption_orders', 'backpack_redemptions', 'user_backpack', 'lottery_draws', 'loan_repayments', 'loans', 'point_ledger'])
    await supabase.from(t).delete().eq('user_id', tid);
  await supabase.from('users').delete().eq('id', tid);
  await supabase.from('admin_logs').insert({ id: uuidv4(), admin_id: aid, action: 'delete_user', target_type: 'user', target_id: tid, detail: 'Delete user', created_at: now });
  return c.json({ success: true });
});

export default authRoutes;
