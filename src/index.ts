// ============================================================
// Cloudflare Worker 入口 - 点数交易系统 (Supabase)
// ============================================================
import { Hono } from 'hono';
import { cors } from 'hono/cors';
import { Env } from './types';
import { getSupabase } from './db';
import authRoutes from './routes/auth';
import taskRoutes from './routes/tasks';
import shopRoutes from './routes/shop';
import loanRoutes from './routes/loans';
import lotteryRoutes from './routes/lottery';
import randomTaskRoutes from './routes/random-tasks';
import adminRoutes from './routes/admin';
import { runScheduledTasks } from './services/cron';
import { serveR2File } from './services/r2';

const app = new Hono<{ Bindings: Env; Variables: { supabase: ReturnType<typeof getSupabase>; userId: string; userRole: string } }>();

// Supabase 客户端初始化中间件
app.use('*', async (c, next) => {
  const supabase = getSupabase(c.env.SUPABASE_URL, c.env.SUPABASE_KEY);
  c.set('supabase', supabase);
  await next();
});

// CORS 配置
app.use('*', cors({
  origin: '*',
  allowMethods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
  allowHeaders: ['Content-Type', 'Authorization'],
  maxAge: 86400,
}));

// API 路由挂载
app.route('/api/auth', authRoutes);
app.route('/api/tasks', taskRoutes);
app.route('/api/shop', shopRoutes);
app.route('/api/loans', loanRoutes);
app.route('/api/lottery', lotteryRoutes);
app.route('/api/random-tasks', randomTaskRoutes);
app.route('/api/admin', adminRoutes);

// R2 图片代理访问
app.get('/r2/*', async (c) => {
  const key = c.req.path.replace('/r2/', '');
  const response = await serveR2File(c.env.R2, key);
  if (!response) return c.notFound();
  return response;
});

// 健康检查
app.get('/api/health', (c) => c.json({ status: 'ok', time: new Date().toISOString() }));

// 404 fallback for API
app.all('/api/*', (c) => c.json({ error: 'API 路由不存在' }, 404));

// ========== 定时任务触发器 ==========
export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    // 尝试先匹配静态资源 (Worker Assets / Cloudflare Pages)
    const url = new URL(request.url);
    if (!url.pathname.startsWith('/api/') && !url.pathname.startsWith('/r2/')) {
      try {
        return await env.ASSETS.fetch(request);
      } catch {
        // 回退到 app 处理
      }
    }
    return app.fetch(request, env, ctx);
  },

  async scheduled(event: ScheduledEvent, env: Env, _ctx: ExecutionContext): Promise<void> {
    console.log(`[Cron] ${event.cron} triggered at ${new Date().toISOString()}`);
    const supabase = getSupabase(env.SUPABASE_URL, env.SUPABASE_KEY);
    const logs = await runScheduledTasks(supabase, env);
    console.log('[Cron] Results:', logs.join('; '));
  },
};
