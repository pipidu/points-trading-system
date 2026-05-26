// ============================================================
// 任务系统路由 (Supabase)
// ============================================================
import { Hono } from 'hono';
import { v4 as uuidv4 } from 'uuid';
import { SupabaseClient } from '@supabase/supabase-js';
import { Env } from '../types';
import { authMiddleware, adminMiddleware } from '../middleware/auth';
import { addPoints } from '../services/points';
import { getSettingNumber } from '../services/settings';
import { parseFormFile, uploadToR2 } from '../services/r2';
import { sendServerChanNotification } from '../services/notify';

type Ctx = { Bindings: Env; Variables: { supabase: SupabaseClient; userId: string; userRole: string } };
const taskRoutes = new Hono<Ctx>();

// ========== 管理员: 创建/编辑任务 ==========
taskRoutes.post('/admin', authMiddleware, adminMiddleware, async (c) => {
  const body = await c.req.json<{
    id?: string;
    title: string;
    description?: string;
    points_min: number;
    points_max: number;
    period_type: 'daily' | 'weekly' | 'monthly';
    period_value?: number;
    submission_type?: 'image' | 'text' | 'both';
    is_active?: number;
    expiry_seconds?: number | null;
  }>();

  const now = new Date().toISOString();
  const id = body.id || uuidv4();
  const supabase = c.get('supabase');

  if (body.id) {
    await supabase.from('tasks').update({
      title: body.title,
      description: body.description || '',
      points_min: body.points_min,
      points_max: body.points_max,
      period_type: body.period_type,
      period_value: body.period_value || 1,
      submission_type: body.submission_type || 'both',
      is_active: body.is_active ?? 1,
      expiry_seconds: body.expiry_seconds ?? null,
      updated_at: now,
    }).eq('id', id);
    return c.json({ success: true, id });
  }

  await supabase.from('tasks').insert({
    id,
    title: body.title,
    description: body.description || '',
    points_min: body.points_min,
    points_max: body.points_max,
    period_type: body.period_type,
    period_value: body.period_value || 1,
    submission_type: body.submission_type || 'both',
    is_active: body.is_active ?? 1,
    expiry_seconds: body.expiry_seconds ?? null,
    created_at: now,
    updated_at: now,
  });

  return c.json({ success: true, id }, 201);
});

// 管理员: 获取所有任务
taskRoutes.get('/admin', authMiddleware, adminMiddleware, async (c) => {
  const { data: tasks } = await c.get('supabase').from('tasks').select('*').order('created_at', { ascending: false });
  return c.json({ tasks: tasks ?? [] });
});

// 管理员: 删除任务
taskRoutes.delete('/admin/:id', authMiddleware, adminMiddleware, async (c) => {
  const id = c.req.param('id');
  await c.get('supabase').from('tasks').delete().eq('id', id);
  return c.json({ success: true });
});

// ========== 用户: 获取可用任务列表 ==========
taskRoutes.get('/', authMiddleware, async (c) => {
  const { data: tasks } = await c.get('supabase').from('tasks').select('*').eq('is_active', 1).order('created_at', { ascending: false });
  return c.json({ tasks: tasks ?? [] });
});

// ========== 用户: 提交任务 (支持图片上传) ==========
taskRoutes.post('/submit', authMiddleware, async (c) => {
  const userId = c.get('userId');
  const contentType = c.req.header('content-type') || '';
  const supabase = c.get('supabase');

  let taskId: string;
  let contentText = '';
  let imageUrl = '';

  if (contentType.includes('multipart/form-data')) {
    const { file, fields } = await parseFormFile(c.req.raw);
    taskId = fields.task_id || '';
    contentText = fields.content_text || '';
    if (file) {
      imageUrl = await uploadToR2(c.env.R2, file, file.name, file.type, 'tasks');
    }
  } else {
    const body = await c.req.json<{ task_id: string; content_text?: string }>();
    taskId = body.task_id;
    contentText = body.content_text || '';
  }

  if (!taskId) return c.json({ error: '缺少任务ID' }, 400);

  const { data: task } = await supabase
    .from('tasks')
    .select('id,submission_type,period_type,period_value')
    .eq('id', taskId)
    .eq('is_active', 1)
    .maybeSingle();
  if (!task) return c.json({ error: '任务不存在或已禁用' }, 404);

  const now = new Date();
  let periodLabel = '';
  switch (task.period_type) {
    case 'daily':
      periodLabel = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
      break;
    case 'weekly': {
      const startOfYear = new Date(now.getFullYear(), 0, 1);
      const weekNum = Math.ceil(((now.getTime() - startOfYear.getTime()) / 86400000 + startOfYear.getDay() + 1) / 7);
      periodLabel = `${now.getFullYear()}-W${weekNum}`;
      break;
    }
    case 'monthly':
      periodLabel = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;
      break;
  }

  const { count } = await supabase
    .from('task_submissions')
    .select('*', { count: 'exact', head: true })
    .eq('user_id', userId)
    .eq('task_id', taskId)
    .eq('period_label', periodLabel);

  if ((count ?? 0) >= task.period_value) {
    return c.json({ error: `该任务在本周期内已达到提交上限 (${task.period_value}次)` }, 429);
  }

  const id = uuidv4();
  await supabase.from('task_submissions').insert({
    id,
    task_id: taskId,
    user_id: userId,
    content_text: contentText,
    image_url: imageUrl,
    status: 'pending',
    period_label: periodLabel,
    created_at: now.toISOString(),
  });

  c.executionCtx.waitUntil(sendServerChanNotification(c.env.SERVERCHAN_SENDKEY));

  return c.json({ success: true, submission: { id, task_id: taskId, status: 'pending' } }, 201);
});

// ========== 用户: 查看自己的提交记录 ==========
taskRoutes.get('/submissions', authMiddleware, async (c) => {
  const userId = c.get('userId');
  const page = parseInt(c.req.query('page') || '1');
  const pageSize = 20;
  const offset = (page - 1) * pageSize;
  const supabase = c.get('supabase');

  const { count } = await supabase
    .from('task_submissions')
    .select('*', { count: 'exact', head: true })
    .eq('user_id', userId);

  const { data: submissions } = await supabase
    .from('task_submissions')
    .select('*')
    .eq('user_id', userId)
    .order('created_at', { ascending: false })
    .range(offset, offset + pageSize - 1);

  const rows = submissions ?? [];
  if (!rows.length) return c.json({ submissions: [], total: count ?? 0, page });

  const taskIds = Array.from(new Set(rows.map((s) => s.task_id)));
  const { data: tasks } = await supabase.from('tasks').select('id,title').in('id', taskIds);
  const { data: randomTasks } = await supabase.from('random_tasks').select('id,title').in('id', taskIds);

  const titleMap = new Map<string, string>();
  for (const t of tasks ?? []) titleMap.set(t.id, t.title);
  for (const t of randomTasks ?? []) titleMap.set(t.id, t.title);

  const mapped = rows.map((s) => ({
    ...s,
    task_title: titleMap.get(s.task_id) ?? '未知任务',
  }));

  return c.json({ submissions: mapped, total: count ?? 0, page });
});

// ========== 管理员: 审核任务提交 ==========
taskRoutes.get('/admin/submissions', authMiddleware, adminMiddleware, async (c) => {
  const page = parseInt(c.req.query('page') || '1');
  const status = c.req.query('status') || '';
  const userId = c.req.query('user_id') || '';
  const pageSize = 20;
  const offset = (page - 1) * pageSize;
  const supabase = c.get('supabase');

  let countQuery = supabase
    .from('task_submissions')
    .select('*', { count: 'exact', head: true });
  let dataQuery = supabase
    .from('task_submissions')
    .select('*')
    .order('created_at', { ascending: false })
    .range(offset, offset + pageSize - 1);

  if (status) {
    countQuery = countQuery.eq('status', status);
    dataQuery = dataQuery.eq('status', status);
  }
  if (userId) {
    countQuery = countQuery.eq('user_id', userId);
    dataQuery = dataQuery.eq('user_id', userId);
  }

  const { count } = await countQuery;
  const { data: submissions } = await dataQuery;

  const rows = submissions ?? [];
  const taskIds = Array.from(new Set(rows.map((s: any) => s.task_id)));
  const userIds = Array.from(new Set(rows.map((s: any) => s.user_id)));
  const { data: tasks } = taskIds.length ? await supabase.from('tasks').select('id,title').in('id', taskIds) : { data: [] };
  const { data: randomTasks } = taskIds.length ? await supabase.from('random_tasks').select('id,title').in('id', taskIds) : { data: [] };
  const { data: users } = userIds.length ? await supabase.from('users').select('id,username,display_name').in('id', userIds) : { data: [] };

  const titleMap = new Map<string, string>();
  for (const t of tasks ?? []) titleMap.set(t.id, t.title);
  for (const t of randomTasks ?? []) titleMap.set(t.id, t.title);

  const userMap = new Map<string, any>();
  for (const u of users ?? []) userMap.set(u.id, u);

  const mapped = rows.map((s: any) => ({
    ...s,
    task_title: titleMap.get(s.task_id) ?? '未知任务',
    username: userMap.get(s.user_id)?.username,
    display_name: userMap.get(s.user_id)?.display_name,
  }));

  return c.json({ submissions: mapped, total: count ?? 0, page });
});

// 管理员: 审核通过/拒绝
taskRoutes.post('/admin/review/:submissionId', authMiddleware, adminMiddleware, async (c) => {
  const submissionId = c.req.param('submissionId');
  const adminId = c.get('userId');
  const body = await c.req.json<{ status: 'approved' | 'rejected'; awarded_points?: number; remark?: string }>();
  const supabase = c.get('supabase');

  const { data: submission } = await supabase
    .from('task_submissions')
    .select('*')
    .eq('id', submissionId)
    .maybeSingle();
  if (!submission) return c.json({ error: '提交记录不存在' }, 404);
  if (submission.status !== 'pending') return c.json({ error: '该记录已审核' }, 400);

  const now = new Date().toISOString();
  const points = body.awarded_points ?? 0;

  if (body.status === 'approved') {
    let task = await supabase
      .from('tasks')
      .select('expiry_seconds')
      .eq('id', submission.task_id)
      .maybeSingle();
    if (!task) {
      task = await supabase
        .from('random_tasks')
        .select('expiry_seconds')
        .eq('id', submission.task_id)
        .maybeSingle();
    }
    const defaultExpiry = await getSettingNumber(supabase, 'task_point_expiry_seconds', 604800);
    const expirySeconds = (task as any)?.expiry_seconds ?? defaultExpiry;
    const expiresAt = expirySeconds > 0
      ? new Date(Date.now() + expirySeconds * 1000).toISOString()
      : null;

    await addPoints(supabase, submission.user_id as string, points, 'task', submissionId as string, `任务奖励: ${body.remark || ''}`, expiresAt);
  }

  await supabase
    .from('task_submissions')
    .update({
      status: body.status,
      awarded_points: points,
      admin_remark: body.remark || '',
      reviewed_by: adminId,
      reviewed_at: now,
    })
    .eq('id', submissionId);

  if (body.status === 'rejected') {
    await supabase
      .from('user_surprise_tasks')
      .update({ is_completed: 0, submission_id: null })
      .eq('submission_id', submissionId);
  }

  await supabase.from('admin_logs').insert({
    id: uuidv4(),
    admin_id: adminId,
    action: 'review_task',
    target_type: 'task_submission',
    target_id: submissionId,
    detail: `审核${body.status === 'approved' ? '通过' : '拒绝'}: +${points}点`,
    created_at: now,
  });

  return c.json({ success: true });
});

export default taskRoutes;
