// ============================================================
// Random Task Routes (Supabase)
// ============================================================
import { Hono } from 'hono';
import { v4 as uuidv4 } from 'uuid';
import { SupabaseClient } from '@supabase/supabase-js';
import { Env } from '../types';
import { authMiddleware, adminMiddleware } from '../middleware/auth';

type Ctx = { Bindings: Env; Variables: { supabase: SupabaseClient; userId: string; userRole: string } };
const randomTaskRoutes = new Hono<Ctx>();

// User: submit surprise task
randomTaskRoutes.post('/submit-surprise/:ustId', authMiddleware, async (c) => {
  const userId = c.get('userId') as string;
  const ustId = c.req.param('ustId');
  const supabase = c.get('supabase');
  const { data: ust } = await supabase.from('user_surprise_tasks').select('*').eq('id',ustId).eq('user_id',userId).single();
  if (!ust) return c.json({ error: 'Not found' }, 404);
  if (ust.is_completed) return c.json({ error: 'Already completed' }, 400);
  const { data: task } = await supabase.from('random_tasks').select('submission_type').eq('id',ust.task_id).single();
  if (!task) return c.json({ error: 'Task disabled' }, 404);

  const ct = c.req.header('content-type')||'';
  let ctt = '', iu = '';
  if (ct.includes('multipart/form-data')) {
    const { file, fields } = await (await import('../services/r2')).parseFormFile(c.req.raw);
    ctt = fields.content_text||''; if (file) iu = await (await import('../services/r2')).uploadToR2(c.env.R2, file, file.name, file.type, 'tasks');
  } else { const b = await c.req.json<{content_text?:string}>(); ctt = b.content_text||''; }

  const sid = uuidv4();
  const now = new Date();
  await supabase.from('task_submissions').insert({ id: sid, task_id: ust.task_id, user_id: userId, content_text: ctt, image_url: iu, status: 'pending', period_label: `surprise-${ustId}`, created_at: now.toISOString() });
  await supabase.from('user_surprise_tasks').update({ is_completed: 1, submission_id: sid }).eq('id',ustId);
  c.executionCtx.waitUntil((await import('../services/notify')).sendServerChanNotification(c.env.SERVERCHAN_SENDKEY));
  return c.json({ success: true, submission: { id: sid, status: 'pending' } }, 201);
});

// Admin: CRUD random tasks
randomTaskRoutes.get('/admin/tasks', authMiddleware, adminMiddleware, async (c) => {
  const { data: tasks } = await c.get('supabase').from('random_tasks').select('*').order('created_at',{ascending:false});
  return c.json({ tasks: tasks??[] });
});

randomTaskRoutes.post('/admin/tasks', authMiddleware, adminMiddleware, async (c) => {
  const b = await c.req.json<{ id?: string; title: string; description?: string; points_min: number; points_max: number; submission_type?: string; expiry_seconds?: number|null; is_active?: number }>();
  const supabase = c.get('supabase');
  const now = new Date().toISOString();
  const id = b.id||uuidv4();
  const d = { title: b.title, description: b.description||'', points_min: b.points_min, points_max: b.points_max, submission_type: b.submission_type||'both', expiry_seconds: b.expiry_seconds??null, is_active: b.is_active??1, updated_at: now };
  if (b.id) { await supabase.from('random_tasks').update(d).eq('id',id); return c.json({success:true,id}); }
  await supabase.from('random_tasks').insert({ id, ...d, created_at: now });
  return c.json({ success: true, id }, 201);
});

randomTaskRoutes.delete('/admin/tasks/:id', authMiddleware, adminMiddleware, async (c) => {
  await c.get('supabase').from('random_tasks').delete().eq('id',c.req.param('id'));
  return c.json({ success: true });
});

// Admin: groups
randomTaskRoutes.get('/admin/groups', authMiddleware, adminMiddleware, async (c) => {
  const supabase = c.get('supabase');
  const { data: groups } = await supabase.from('random_task_groups').select('*').order('created_at',{ascending:false});
  const r = [];
  for (const g of (groups??[])) {
    const { data: items } = await supabase.from('random_task_group_items').select('*, random_tasks(title,points_min,points_max,submission_type)').eq('group_id',g.id).order('sort_order',{ascending:true});
    r.push({...(g as any), items: (items??[]).map((i:any)=>({...i, title: i.random_tasks?.title, points_min: i.random_tasks?.points_min, points_max: i.random_tasks?.points_max, submission_type: i.random_tasks?.submission_type, random_tasks: undefined}))});
  }
  return c.json({ groups: r });
});

randomTaskRoutes.post('/admin/groups', authMiddleware, adminMiddleware, async (c) => {
  const b = await c.req.json<{ id?: string; name: string; period_type: string; is_active?: number; task_ids?: string[] }>();
  const supabase = c.get('supabase');
  const now = new Date().toISOString();
  const gid = b.id||uuidv4();
  if (b.id) { await supabase.from('random_task_groups').update({ name: b.name, period_type: b.period_type, is_active: b.is_active??1, updated_at: now }).eq('id',gid); await supabase.from('random_task_group_items').delete().eq('group_id',gid); }
  else { await supabase.from('random_task_groups').insert({ id: gid, name: b.name, period_type: b.period_type, is_active: b.is_active??1, created_at: now, updated_at: now }); }
  if (b.task_ids?.length) await supabase.from('random_task_group_items').insert(b.task_ids.map((tid,i)=>({ id: uuidv4(), group_id: gid, task_id: tid, sort_order: i })));
  return c.json({ success: true, id: gid }, b.id?200:201);
});

randomTaskRoutes.delete('/admin/groups/:id', authMiddleware, adminMiddleware, async (c) => {
  const gid = c.req.param('id');
  const supabase = c.get('supabase');
  await supabase.from('random_task_group_items').delete().eq('group_id',gid);
  await supabase.from('random_task_groups').delete().eq('id',gid);
  return c.json({ success: true });
});

// User: available groups
randomTaskRoutes.get('/', authMiddleware, async (c) => {
  const userId = c.get('userId') as string;
  const now = new Date();
  const supabase = c.get('supabase');
  const dk = `${now.getFullYear()}-${String(now.getMonth()+1).padStart(2,'0')}-${String(now.getDate()).padStart(2,'0')}`;
  const soy = new Date(now.getFullYear(),0,1);
  const wk = `${now.getFullYear()}-W${Math.ceil(((now.getTime()-soy.getTime())/86400000+soy.getDay()+1)/7)}`;
  const mk = `${now.getFullYear()}-${String(now.getMonth()+1).padStart(2,'0')}`;
  const { data: groups } = await supabase.from('random_task_groups').select('*').eq('is_active',1);
  const r: any[] = [];
  for (const g of (groups??[])) {
    const pl = g.period_type==='daily'?dk:g.period_type==='weekly'?wk:mk;
    const { data: ex } = await supabase.from('user_surprise_tasks').select('*').eq('user_id',userId).eq('group_id',g.id).eq('period_label',pl).single();
    let st: any = null;
    if (ex) { const { data: t } = await supabase.from('random_tasks').select('*').eq('id',ex.task_id).single(); st = {...t, ust_id: ex.id, is_completed: ex.is_completed, submission_id: ex.submission_id}; }
    const { data: items } = await supabase.from('random_task_group_items').select('*, random_tasks(title,points_min,points_max,submission_type)').eq('group_id',g.id);
    r.push({ group: g, period_label: pl, can_draw: !ex, surprise_task: st, items: (items??[]).map((i:any)=>({...i, title: i.random_tasks?.title, points_min: i.random_tasks?.points_min, points_max: i.random_tasks?.points_max, submission_type: i.random_tasks?.submission_type, random_tasks: undefined})) });
  }
  return c.json({ groups: r });
});

// Draw surprise task
randomTaskRoutes.post('/draw/:groupId', authMiddleware, async (c) => {
  const userId = c.get('userId') as string;
  const gid = c.req.param('groupId');
  const now = new Date();
  const supabase = c.get('supabase');
  const { data: group } = await supabase.from('random_task_groups').select('*').eq('id',gid).eq('is_active',1).single();
  if (!group) return c.json({ error: 'Group not found' }, 404);
  const dk = `${now.getFullYear()}-${String(now.getMonth()+1).padStart(2,'0')}-${String(now.getDate()).padStart(2,'0')}`;
  const soy = new Date(now.getFullYear(),0,1);
  const wk = `${now.getFullYear()}-W${Math.ceil(((now.getTime()-soy.getTime())/86400000+soy.getDay()+1)/7)}`;
  const mk = `${now.getFullYear()}-${String(now.getMonth()+1).padStart(2,'0')}`;
  const pl = group.period_type==='daily'?dk:group.period_type==='weekly'?wk:mk;
  const { data: ex } = await supabase.from('user_surprise_tasks').select('id').eq('user_id',userId).eq('group_id',gid).eq('period_label',pl).single();
  if (ex) return c.json({ error: 'Already drawn this period' }, 409);
  const { data: items } = await supabase.from('random_task_group_items').select('task_id').eq('group_id',gid).order('sort_order',{ascending:true});
  if (!items?.length) return c.json({ error: 'No tasks in group' }, 400);
  const tid = items[Math.floor(Math.random()*items.length)].task_id;
  const uid = uuidv4();
  await supabase.from('user_surprise_tasks').insert({ id: uid, user_id: userId, group_id: gid, task_id: tid, period_label: pl, is_completed: 0, created_at: now.toISOString() });
  const { data: task } = await supabase.from('random_tasks').select('*').eq('id',tid).single();
  return c.json({ success: true, surprise_task: { ...task, ust_id: uid, is_completed: 0, period_label: pl } });
});

export default randomTaskRoutes;
