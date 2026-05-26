// ============================================================
// 认证中间件
// ============================================================
import { Context, Next } from 'hono';
import { SupabaseClient } from '@supabase/supabase-js';
import { verifyToken } from '../services/auth';
import { Env } from '../types';

// JWT 鉴权中间件
export async function authMiddleware(c: Context<{ Bindings: Env; Variables: { supabase: SupabaseClient; userId: string; userRole: string } }>, next: Next) {
  const authHeader = c.req.header('Authorization');
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return c.json({ error: '未提供认证令牌' }, 401);
  }

  const token = authHeader.slice(7);
  const payload = await verifyToken(token, c.env);
  if (!payload) {
    return c.json({ error: '令牌无效或已过期' }, 401);
  }

  const supabase = c.get('supabase');
  const { data: user, error } = await supabase
    .from('users')
    .select('*')
    .eq('id', payload.sub)
    .single();

  if (error || !user) {
    return c.json({ error: '用户不存在' }, 401);
  }

  c.set('userId', user.id);
  c.set('userRole', user.role);
  await next();
}

// 管理员鉴权中间件
export async function adminMiddleware(c: Context<{ Bindings: Env; Variables: { supabase: SupabaseClient; userId: string; userRole: string } }>, next: Next) {
  const role = c.get('userRole');
  if (role !== 'admin') {
    return c.json({ error: '需要管理员权限' }, 403);
  }
  await next();
}
