// ============================================================
// 商品兑换系统路由 (Supabase)
// ============================================================
import { Hono } from 'hono';
import { v4 as uuidv4 } from 'uuid';
import { SupabaseClient } from '@supabase/supabase-js';
import { Env } from '../types';
import { authMiddleware, adminMiddleware } from '../middleware/auth';
import { getRealtimeBalance, deductPointsFIFO, addPoints } from '../services/points';
import { getSettingNumber } from '../services/settings';
import { parseFormFile, uploadToR2 } from '../services/r2';
import { sendServerChanNotification } from '../services/notify';

type Ctx = { Bindings: Env; Variables: { supabase: SupabaseClient; userId: string; userRole: string } };
const shopRoutes = new Hono<Ctx>();

// ========== 管理员: 创建/编辑商品 ==========
shopRoutes.post('/admin/items', authMiddleware, adminMiddleware, async (c) => {
  const body = await c.req.json<{
    id?: string;
    name: string;
    description?: string;
    image_url?: string;
    points_required: number;
    stock?: number;
    is_active?: number;
  }>();
  const now = new Date().toISOString();
  const id = body.id || uuidv4();
  const supabase = c.get('supabase');

  if (body.id) {
    await supabase.from('shop_items').update({
      name: body.name,
      description: body.description || '',
      image_url: body.image_url || '',
      points_required: body.points_required,
      stock: body.stock ?? -1,
      is_active: body.is_active ?? 1,
      updated_at: now,
    }).eq('id', id);
    return c.json({ success: true, id });
  }

  await supabase.from('shop_items').insert({
    id,
    name: body.name,
    description: body.description || '',
    image_url: body.image_url || '',
    points_required: body.points_required,
    stock: body.stock ?? -1,
    is_active: body.is_active ?? 1,
    created_at: now,
    updated_at: now,
  });

  return c.json({ success: true, id }, 201);
});

// 管理员: 获取商品列表
shopRoutes.get('/admin/items', authMiddleware, adminMiddleware, async (c) => {
  const { data: items } = await c.get('supabase').from('shop_items').select('*').order('created_at', { ascending: false });
  return c.json({ items: items ?? [] });
});

// 管理员: 删除商品
shopRoutes.delete('/admin/items/:id', authMiddleware, adminMiddleware, async (c) => {
  await c.get('supabase').from('shop_items').delete().eq('id', c.req.param('id'));
  return c.json({ success: true });
});

// ========== 用户: 获取可兑换商品列表 ==========
shopRoutes.get('/items', authMiddleware, async (c) => {
  const { data: items } = await c.get('supabase')
    .from('shop_items')
    .select('*')
    .eq('is_active', 1)
    .neq('stock', 0)
    .order('created_at', { ascending: false });
  return c.json({ items: items ?? [] });
});

// ========== 用户: 兑换商品 ==========
shopRoutes.post('/redeem', authMiddleware, async (c) => {
  const userId = c.get('userId');
  const contentType = c.req.header('content-type') || '';
  const supabase = c.get('supabase');

  let itemId: string;
  let contentText = '';
  let imageUrl = '';

  if (contentType.includes('multipart/form-data')) {
    const { file, fields } = await parseFormFile(c.req.raw);
    itemId = fields.item_id || '';
    contentText = fields.content_text || '';
    if (file) {
      imageUrl = await uploadToR2(c.env.R2, file, file.name, file.type, 'redemptions');
    }
  } else {
    const body = await c.req.json<{ item_id: string; content_text?: string }>();
    itemId = body.item_id;
    contentText = body.content_text || '';
  }

  if (!itemId) return c.json({ error: '缺少商品ID' }, 400);

  const { data: item } = await supabase
    .from('shop_items')
    .select('id,name,points_required,stock')
    .eq('id', itemId)
    .eq('is_active', 1)
    .maybeSingle();
  if (!item) return c.json({ error: '商品不存在或已下架' }, 404);
  if (item.stock === 0) return c.json({ error: '商品已售罄' }, 400);

  const balance = await getRealtimeBalance(supabase, userId);
  if (balance < 0) return c.json({ error: '点数为负数，无法兑换。请完成任务或偿还贷款。', balance }, 403);
  if (balance < item.points_required) {
    return c.json({ error: `点数不足，需要 ${item.points_required} 点，当前 ${balance} 点`, balance }, 400);
  }

  const result = await deductPointsFIFO(supabase, userId, item.points_required, 'shop_purchase', itemId, `兑换: ${item.name}`);
  if (!result.success) {
    return c.json({ error: '点数扣减失败，余额不足', balance: result.balanceAfter }, 400);
  }

  if (item.stock > 0) {
    await supabase
      .from('shop_items')
      .update({ stock: item.stock - 1 })
      .eq('id', itemId)
      .gt('stock', 0);
  }

  const orderId = uuidv4();
  const now = new Date().toISOString();
  await supabase.from('redemption_orders').insert({
    id: orderId,
    user_id: userId,
    item_id: itemId,
    content_text: contentText,
    image_url: imageUrl,
    status: 'pending',
    points_spent: item.points_required,
    created_at: now,
  });

  c.executionCtx.waitUntil(sendServerChanNotification(c.env.SERVERCHAN_SENDKEY));

  return c.json({ success: true, order: { id: orderId, item_name: item.name, points_spent: item.points_required, balance_after: result.balanceAfter } }, 201);
});

// ========== 用户: 查看兑换记录 ==========
shopRoutes.get('/orders', authMiddleware, async (c) => {
  const userId = c.get('userId');
  const page = parseInt(c.req.query('page') || '1');
  const pageSize = 20;
  const offset = (page - 1) * pageSize;
  const supabase = c.get('supabase');

  const { count } = await supabase
    .from('redemption_orders')
    .select('*', { count: 'exact', head: true })
    .eq('user_id', userId);

  const { data: orders } = await supabase
    .from('redemption_orders')
    .select('*')
    .eq('user_id', userId)
    .order('created_at', { ascending: false })
    .range(offset, offset + pageSize - 1);

  const rows = orders ?? [];
  const itemIds = Array.from(new Set(rows.map((o: any) => o.item_id)));
  const { data: items } = itemIds.length ? await supabase.from('shop_items').select('id,name').in('id', itemIds) : { data: [] };
  const itemMap = new Map<string, string>();
  for (const i of items ?? []) itemMap.set(i.id, i.name);

  const mapped = rows.map((o: any) => ({
    ...o,
    item_name: itemMap.get(o.item_id) ?? '已删除商品',
  }));

  return c.json({ orders: mapped, total: count ?? 0, page });
});

// ========== 管理员: 审核兑换订单 ==========
shopRoutes.get('/admin/orders', authMiddleware, adminMiddleware, async (c) => {
  const page = parseInt(c.req.query('page') || '1');
  const status = c.req.query('status') || '';
  const userId = c.req.query('user_id') || '';
  const pageSize = 20;
  const offset = (page - 1) * pageSize;
  const supabase = c.get('supabase');

  let countQuery = supabase.from('redemption_orders').select('*', { count: 'exact', head: true });
  let dataQuery = supabase
    .from('redemption_orders')
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
  const itemIds = Array.from(new Set(rows.map((o: any) => o.item_id)));
  const userIds = Array.from(new Set(rows.map((o: any) => o.user_id)));
  const { data: items } = itemIds.length ? await supabase.from('shop_items').select('id,name').in('id', itemIds) : { data: [] };
  const { data: users } = userIds.length ? await supabase.from('users').select('id,username,display_name').in('id', userIds) : { data: [] };

  const itemMap = new Map<string, string>();
  for (const i of items ?? []) itemMap.set(i.id, i.name);
  const userMap = new Map<string, any>();
  for (const u of users ?? []) userMap.set(u.id, u);

  const mapped = rows.map((o: any) => ({
    ...o,
    item_name: itemMap.get(o.item_id) ?? '已删除商品',
    username: userMap.get(o.user_id)?.username,
    display_name: userMap.get(o.user_id)?.display_name,
  }));

  return c.json({ orders: mapped, total: count ?? 0, page });
});

shopRoutes.post('/admin/orders/:orderId/review', authMiddleware, adminMiddleware, async (c) => {
  const orderId = c.req.param('orderId');
  const adminId = c.get('userId');
  const body = await c.req.json<{ status: 'approved' | 'rejected'; remark?: string }>();
  const supabase = c.get('supabase');

  const { data: order } = await supabase
    .from('redemption_orders')
    .select('*')
    .eq('id', orderId)
    .maybeSingle();
  if (!order) return c.json({ error: '订单不存在' }, 404);
  if (order.status !== 'pending') return c.json({ error: '该订单已审核' }, 400);

  const now = new Date().toISOString();

  if (body.status === 'rejected') {
    const shopExpirySeconds = await getSettingNumber(supabase, 'shop_purchase_expiry_seconds', 0);
    const expiresAt = shopExpirySeconds > 0
      ? new Date(Date.now() + shopExpirySeconds * 1000).toISOString()
      : null;
    await addPoints(supabase, order.user_id as string, order.points_spent ?? 0, 'admin_adjust', orderId as string, `兑换拒绝退款: ${body.remark || ''}`, expiresAt);
  }

  await supabase
    .from('redemption_orders')
    .update({
      status: body.status,
      admin_remark: body.remark || '',
      reviewed_by: adminId,
      reviewed_at: now,
    })
    .eq('id', orderId);

  await supabase.from('admin_logs').insert({
    id: uuidv4(),
    admin_id: adminId,
    action: 'review_order',
    target_type: 'redemption_order',
    target_id: orderId,
    detail: `审核${body.status === 'approved' ? '通过' : '拒绝'}兑换订单`,
    created_at: now,
  });

  return c.json({ success: true });
});

export default shopRoutes;
