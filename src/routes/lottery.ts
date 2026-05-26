// ============================================================
// 抽奖 & 背包系统路由 (Supabase)
// ============================================================
import { Hono } from 'hono';
import { v4 as uuidv4 } from 'uuid';
import { SupabaseClient } from '@supabase/supabase-js';
import { Env } from '../types';
import { authMiddleware, adminMiddleware } from '../middleware/auth';
import { drawSingle, drawMulti, getLotteryItems, getBackpack, getDrawHistory, getPityProgress, clearLotteryCache } from '../services/lottery';
import { getSettingNumber, getSetting, setSetting } from '../services/settings';
import { parseFormFile, uploadToR2 } from '../services/r2';
import { sendServerChanNotification } from '../services/notify';

type Ctx = { Bindings: Env; Variables: { supabase: SupabaseClient; userId: string; userRole: string } };
const lotteryRoutes = new Hono<Ctx>();

// ========== 管理员: 管理奖品 CRUD ==========
lotteryRoutes.get('/admin/items', authMiddleware, adminMiddleware, async (c) => {
  const supabase = c.get('supabase');
  const { data: items } = await supabase
    .from('lottery_items')
    .select('*')
    .eq('is_active', 1)
    .order('sort_order', { ascending: true });
  return c.json({ items: items ?? [] });
});

lotteryRoutes.post('/admin/items', authMiddleware, adminMiddleware, async (c) => {
  const body = await c.req.json<{
    id?: string; name: string; description?: string; image_url?: string;
    icon?: string; rarity: string; probability: number;
    reward_type?: string; points_amount?: number;
    is_active?: number; sort_order?: number;
  }>();
  const now = new Date().toISOString();
  const supabase = c.get('supabase');
  const id = body.id || uuidv4();
  const rewardType = body.reward_type === 'points' ? 'points' : 'item';
  const pointsAmount = rewardType === 'points' ? Math.max(0, body.points_amount || 0) : 0;
  if (rewardType === 'points' && pointsAmount <= 0) {
    return c.json({ error: '点数奖励必须大于0' }, 400);
  }
  if (typeof body.probability !== 'number' || body.probability < 0) {
    return c.json({ error: '概率必须为非负数' }, 400);
  }

  if (body.id) {
    await supabase.from('lottery_items').update({
      name: body.name,
      description: body.description || '',
      image_url: body.image_url || '',
      icon: body.icon || '🎁',
      rarity: body.rarity,
      probability: body.probability,
      reward_type: rewardType,
      points_amount: pointsAmount,
      is_active: body.is_active ?? 1,
      sort_order: body.sort_order ?? 0,
      updated_at: now,
    }).eq('id', id);
    clearLotteryCache();
    return c.json({ success: true, id });
  }

  await supabase.from('lottery_items').insert({
    id,
    name: body.name,
    description: body.description || '',
    image_url: body.image_url || '',
    icon: body.icon || '🎁',
    rarity: body.rarity,
    probability: body.probability,
    reward_type: rewardType,
    points_amount: pointsAmount,
    is_active: body.is_active ?? 1,
    sort_order: body.sort_order ?? 0,
    created_at: now,
    updated_at: now,
  });

  clearLotteryCache();
  return c.json({ success: true, id }, 201);
});

lotteryRoutes.delete('/admin/items/:id', authMiddleware, adminMiddleware, async (c) => {
  const supabase = c.get('supabase');
  const itemId = c.req.param('id');
  await supabase.from('lottery_items').update({
    probability: 0,
    is_active: 0,
    name: `已删除-${itemId}`,
    updated_at: new Date().toISOString(),
  }).eq('id', itemId);
  clearLotteryCache();
  return c.json({ success: true });
});

// 获取抽奖系统设置
lotteryRoutes.get('/admin/settings', authMiddleware, adminMiddleware, async (c) => {
  const supabase = c.get('supabase');
  const cost = await getSettingNumber(supabase, 'lottery_cost', 50);
  const pityCount = await getSettingNumber(supabase, 'lottery_pity_count', 80);
  const pityItemId = await getSetting(supabase, 'lottery_pity_item_id', '');
  return c.json({ cost, pity_count: pityCount, pity_item_id: pityItemId });
});

// 更新抽奖系统设置
lotteryRoutes.put('/admin/settings', authMiddleware, adminMiddleware, async (c) => {
  const adminId = c.get('userId');
  const body = await c.req.json<{ cost?: number; pity_count?: number; pity_item_id?: string }>();
  const supabase = c.get('supabase');
  const now = new Date().toISOString();

  if (body.cost !== undefined) {
    await setSetting(supabase, 'lottery_cost', String(body.cost));
  }
  if (body.pity_count !== undefined) {
    await setSetting(supabase, 'lottery_pity_count', String(body.pity_count));
  }
  if (body.pity_item_id !== undefined) {
    await setSetting(supabase, 'lottery_pity_item_id', body.pity_item_id);
  }

  await supabase.from('admin_logs').insert({
    id: uuidv4(),
    admin_id: adminId,
    action: 'update_lottery_settings',
    target_type: 'settings',
    target_id: '',
    detail: '更新抽奖系统配置',
    created_at: now,
  });

  return c.json({ success: true });
});

// ========== 用户: 获取奖品池 (含概率) ==========
lotteryRoutes.get('/items', authMiddleware, async (c) => {
  const supabase = c.get('supabase');
  const items = await getLotteryItems(supabase);
  const cost = await getSettingNumber(supabase, 'lottery_cost', 50);
  return c.json({ items, cost });
});

// ========== 用户: 抽卡! ==========
lotteryRoutes.post('/draw', authMiddleware, async (c) => {
  const userId = c.get('userId');
  const supabase = c.get('supabase');
  const result = await drawSingle(supabase, userId);
  if ((result as any).error) return c.json({ error: (result as any).error, balance: (result as any).balance ?? 0 }, 400);
  return c.json({ success: true, ...result });
});

// ========== 用户: 十连抽卡! ==========
lotteryRoutes.post('/draw-multi', authMiddleware, async (c) => {
  const userId = c.get('userId');
  const supabase = c.get('supabase');
  const result = await drawMulti(supabase, userId);
  if ((result as any).error) return c.json({ error: (result as any).error, balance: (result as any).balance ?? 0 }, 400);
  return c.json({ success: true, ...result });
});

// ========== 用户: 保底进度 ==========
lotteryRoutes.get('/pity', authMiddleware, async (c) => {
  const userId = c.get('userId');
  const supabase = c.get('supabase');
  const pity = await getPityProgress(supabase, userId);
  const cost = await getSettingNumber(supabase, 'lottery_cost', 50);
  return c.json({ ...pity, cost });
});

// ========== 用户: 抽卡历史 ==========
lotteryRoutes.get('/history', authMiddleware, async (c) => {
  const userId = c.get('userId');
  const page = parseInt(c.req.query('page') || '1');
  const supabase = c.get('supabase');
  const result = await getDrawHistory(supabase, userId, page, 20);
  return c.json(result);
});

// ========== 用户: 我的背包 ==========
lotteryRoutes.get('/backpack', authMiddleware, async (c) => {
  const userId = c.get('userId');
  const supabase = c.get('supabase');
  const bp = await getBackpack(supabase, userId);
  return c.json({ backpack: bp });
});

// ========== 用户: 从背包兑换物品 (需上传图片/文字) ==========
lotteryRoutes.post('/backpack/redeem', authMiddleware, async (c) => {
  const userId = c.get('userId');
  const contentType = c.req.header('content-type') || '';
  const supabase = c.get('supabase');

  let backpackId: string;
  let contentText = '';
  let imageUrl = '';

  if (contentType.includes('multipart/form-data')) {
    const { file, fields } = await parseFormFile(c.req.raw);
    backpackId = fields.backpack_id || '';
    contentText = fields.content_text || '';
    if (file) {
      imageUrl = await uploadToR2(c.env.R2, file, file.name, file.type, 'backpack');
    }
  } else {
    const body = await c.req.json<{ backpack_id: string; content_text?: string }>();
    backpackId = body.backpack_id;
    contentText = body.content_text || '';
  }

  if (!backpackId) return c.json({ error: '缺少背包物品ID' }, 400);

  const { data: bp } = await supabase
    .from('user_backpack')
    .select('id,quantity,is_redeemed,item_name')
    .eq('id', backpackId)
    .eq('user_id', userId)
    .maybeSingle();
  if (!bp) return c.json({ error: '背包物品不存在' }, 404);
  if (bp.is_redeemed) return c.json({ error: '该物品已兑换' }, 400);

  const id = uuidv4();
  const now = new Date().toISOString();

  await supabase.from('backpack_redemptions').insert({
    id,
    user_id: userId,
    backpack_id: backpackId,
    content_text: contentText,
    image_url: imageUrl,
    status: 'pending',
    created_at: now,
  });

  c.executionCtx.waitUntil(sendServerChanNotification(c.env.SERVERCHAN_SENDKEY));

  return c.json({ success: true, redemption: { id, item_name: bp.item_name, status: 'pending' } }, 201);
});

// ========== 管理员: 审核背包兑换 ==========
lotteryRoutes.get('/admin/backpack-redemptions', authMiddleware, adminMiddleware, async (c) => {
  const page = parseInt(c.req.query('page') || '1');
  const status = c.req.query('status') || '';
  const userId = c.req.query('user_id') || '';
  const pageSize = 20;
  const offset = (page - 1) * pageSize;
  const supabase = c.get('supabase');

  let countQuery = supabase.from('backpack_redemptions').select('*', { count: 'exact', head: true });
  let dataQuery = supabase
    .from('backpack_redemptions')
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
  const { data: orders } = await dataQuery;
  const rows = orders ?? [];
  const backpackIds = Array.from(new Set(rows.map((o: any) => o.backpack_id)));
  const userIds = Array.from(new Set(rows.map((o: any) => o.user_id)));
  const { data: backpacks } = backpackIds.length ? await supabase.from('user_backpack').select('id,item_name,item_icon,rarity').in('id', backpackIds) : { data: [] };
  const { data: users } = userIds.length ? await supabase.from('users').select('id,username,display_name').in('id', userIds) : { data: [] };

  const bpMap = new Map<string, any>();
  for (const b of backpacks ?? []) bpMap.set(b.id, b);
  const userMap = new Map<string, any>();
  for (const u of users ?? []) userMap.set(u.id, u);

  const mapped = rows.map((o: any) => ({
    ...o,
    item_name: bpMap.get(o.backpack_id)?.item_name,
    item_icon: bpMap.get(o.backpack_id)?.item_icon,
    rarity: bpMap.get(o.backpack_id)?.rarity,
    username: userMap.get(o.user_id)?.username,
    display_name: userMap.get(o.user_id)?.display_name,
  }));

  return c.json({ redemptions: mapped, total: count ?? 0, page });
});

lotteryRoutes.post('/admin/backpack-redemptions/:id/review', authMiddleware, adminMiddleware, async (c) => {
  const id = c.req.param('id');
  const adminId = c.get('userId');
  const body = await c.req.json<{ status: 'approved' | 'rejected'; remark?: string }>();
  const supabase = c.get('supabase');

  const { data: bpRedemp } = await supabase
    .from('backpack_redemptions')
    .select('id,backpack_id,status')
    .eq('id', id)
    .maybeSingle();
  if (!bpRedemp) return c.json({ error: '申请不存在' }, 404);
  if (bpRedemp.status !== 'pending') return c.json({ error: '已审核' }, 400);

  const now = new Date().toISOString();
  await supabase
    .from('backpack_redemptions')
    .update({ status: body.status, admin_remark: body.remark || '', reviewed_by: adminId, reviewed_at: now })
    .eq('id', id);

  if (body.status === 'approved') {
    await supabase.from('user_backpack').update({ is_redeemed: 1 }).eq('id', bpRedemp.backpack_id);
  } else {
    await supabase.from('user_backpack').update({ is_redeemed: 0 }).eq('id', bpRedemp.backpack_id);
  }

  await supabase.from('admin_logs').insert({
    id: uuidv4(),
    admin_id: adminId,
    action: 'review_bp_redemption',
    target_type: 'backpack_redemption',
    target_id: id,
    detail: `审核背包兑换: ${body.status}`,
    created_at: now,
  });

  return c.json({ success: true });
});

// ========== 用户: 查看自己的背包兑换记录 ==========
lotteryRoutes.get('/backpack-redemptions', authMiddleware, async (c) => {
  const userId = c.get('userId');
  const supabase = c.get('supabase');
  const { data: list } = await supabase
    .from('backpack_redemptions')
    .select('*')
    .eq('user_id', userId)
    .order('created_at', { ascending: false });

  const rows = list ?? [];
  const bpIds = Array.from(new Set(rows.map((r: any) => r.backpack_id)));
  const { data: backpacks } = bpIds.length ? await supabase.from('user_backpack').select('id,item_name,item_icon,rarity').in('id', bpIds) : { data: [] };
  const bpMap = new Map<string, any>();
  for (const b of backpacks ?? []) bpMap.set(b.id, b);

  const mapped = rows.map((r: any) => ({
    ...r,
    item_name: bpMap.get(r.backpack_id)?.item_name,
    item_icon: bpMap.get(r.backpack_id)?.item_icon,
    rarity: bpMap.get(r.backpack_id)?.rarity,
  }));

  return c.json({ redemptions: mapped });
});

// ========== 管理员: 查看用户抽卡记录 ==========
lotteryRoutes.get('/admin/draws/:userId', authMiddleware, adminMiddleware, async (c) => {
  const userId = c.req.param('userId');
  const page = parseInt(c.req.query('page') || '1');
  const supabase = c.get('supabase');
  const result = await getDrawHistory(supabase, userId as string, page, 30);
  return c.json(result);
});

// ========== 管理员: 查看用户背包 ==========
lotteryRoutes.get('/admin/backpack/:userId', authMiddleware, adminMiddleware, async (c) => {
  const userId = c.req.param('userId');
  const supabase = c.get('supabase');
  const bp = await getBackpack(supabase, userId as string);
  return c.json({ backpack: bp });
});

// 管理员: 删除用户背包物品
lotteryRoutes.delete('/admin/backpack/item/:itemId', authMiddleware, adminMiddleware, async (c) => {
  await c.get('supabase').from('user_backpack').delete().eq('id', c.req.param('itemId'));
  return c.json({ success: true });
});

// ========== 管理员: 抽卡统计 ==========
lotteryRoutes.get('/admin/stats', authMiddleware, adminMiddleware, async (c) => {
  const supabase = c.get('supabase');
  const { count: totalDraws } = await supabase.from('lottery_draws').select('*', { count: 'exact', head: true });
  const { count: pityTriggered } = await supabase.from('lottery_draws').select('*', { count: 'exact', head: true }).eq('is_pity', 1);
  const { count: pendingRedeems } = await supabase.from('backpack_redemptions').select('*', { count: 'exact', head: true }).eq('status', 'pending');
  const { count: totalItems } = await supabase.from('user_backpack').select('*', { count: 'exact', head: true }).eq('is_redeemed', 0);

  const { data: drawRows } = await supabase.from('lottery_draws').select('item_id,points_spent');
  const totalPointsSpent = (drawRows ?? []).reduce((s: number, r: any) => s + (r.points_spent || 0), 0);

  const { data: items } = await supabase.from('lottery_items').select('id,name,rarity');
  const countMap = new Map<string, number>();
  for (const d of drawRows ?? []) {
    if (!d.item_id) continue;
    countMap.set(d.item_id, (countMap.get(d.item_id) ?? 0) + 1);
  }
  const itemStats = (items ?? [])
    .map((i: any) => ({ name: i.name, rarity: i.rarity, draw_count: countMap.get(i.id) ?? 0 }))
    .sort((a, b) => b.draw_count - a.draw_count);

  return c.json({
    total_draws: totalDraws ?? 0,
    total_points_spent: totalPointsSpent,
    pity_triggered: pityTriggered ?? 0,
    pending_redemptions: pendingRedeems ?? 0,
    backpack_items: totalItems ?? 0,
    item_stats: itemStats,
  });
});

export default lotteryRoutes;
