// ============================================================
// 抽奖核心服务 - 概率抽卡 + 保底系统 (Supabase)
// 单抽 +1 计数, 十连 +10 计数, 每 N 抽触发保底后归零
// ============================================================
import { v4 as uuidv4 } from 'uuid';
import { SupabaseClient } from '@supabase/supabase-js';
import { LotteryItem } from '../types';
import { deductPointsFIFO, addPoints, getRealtimeBalance } from './points';
import { getSetting, getSettingNumber } from './settings';

// 奖品缓存
let cachedItems: LotteryItem[] | null = null;
let cachedItemsAt = 0;

type LotteryStateRow = {
  pity_counter: number;
  total_draws: number;
  last_draw_at: string | null;
};

export async function ensureLotterySchema(_supabase: SupabaseClient): Promise<void> {
  // Schema is managed by schema.sql in Supabase
}

async function getActiveItems(supabase: SupabaseClient): Promise<LotteryItem[]> {
  const now = Date.now();
  if (cachedItems && now - cachedItemsAt < 30_000) return cachedItems;
  const { data, error } = await supabase
    .from('lottery_items')
    .select('*')
    .eq('is_active', 1)
    .order('sort_order', { ascending: true });
  if (error) return [];
  cachedItems = data ?? [];
  cachedItemsAt = now;
  return cachedItems;
}

export function clearLotteryCache() {
  cachedItems = null;
  cachedItemsAt = 0;
}

function rollItem(items: LotteryItem[], total: number): LotteryItem {
  let r = Math.random() * total;
  for (const item of items) {
    r -= item.probability;
    if (r <= 0) return item;
  }
  return items[items.length - 1];
}

async function countSinceLastPity(supabase: SupabaseClient, userId: string): Promise<number> {
  const { data: last } = await supabase
    .from('lottery_draws')
    .select('id,created_at')
    .eq('user_id', userId)
    .eq('is_pity', 1)
    .order('created_at', { ascending: false })
    .limit(1);

  const lastRow = last?.[0];
  if (!lastRow?.id) {
    const { count } = await supabase
      .from('lottery_draws')
      .select('*', { count: 'exact', head: true })
      .eq('user_id', userId);
    return count ?? 0;
  }

  const { count } = await supabase
    .from('lottery_draws')
    .select('*', { count: 'exact', head: true })
    .eq('user_id', userId)
    .gt('created_at', lastRow.created_at);
  return count ?? 0;
}

async function getLastDrawCounter(supabase: SupabaseClient, userId: string, pityCount: number): Promise<number | null> {
  const { data } = await supabase
    .from('lottery_draws')
    .select('is_pity,draw_index')
    .eq('user_id', userId)
    .order('created_at', { ascending: false })
    .limit(1);

  const row = data?.[0];
  if (!row) return null;
  if (row.is_pity) return 0;
  if (row.draw_index > 0 && row.draw_index <= pityCount) return row.draw_index;
  return null;
}

async function getOrInitLotteryState(
  supabase: SupabaseClient,
  userId: string,
  pityCount: number
): Promise<LotteryStateRow> {
  const { data: existing } = await supabase
    .from('lottery_state')
    .select('pity_counter,total_draws,last_draw_at')
    .eq('user_id', userId)
    .maybeSingle();
  if (existing) return existing as LotteryStateRow;

  const [fallbackCounter, totalDraws] = await Promise.all([
    (async () => {
      const lastCounter = await getLastDrawCounter(supabase, userId, pityCount);
      if (lastCounter !== null) return lastCounter;
      return countSinceLastPity(supabase, userId);
    })(),
    (async () => {
      const { count } = await supabase
        .from('lottery_draws')
        .select('*', { count: 'exact', head: true })
        .eq('user_id', userId);
      return count ?? 0;
    })(),
  ]);

  const now = new Date().toISOString();
  await supabase.from('lottery_state').insert({
    user_id: userId,
    pity_counter: fallbackCounter,
    total_draws: totalDraws,
    last_draw_at: null,
    updated_at: now,
  });

  return { pity_counter: fallbackCounter, total_draws: totalDraws, last_draw_at: null };
}

async function saveLotteryState(
  supabase: SupabaseClient,
  userId: string,
  pityCounter: number,
  totalDraws: number,
  lastDrawAt: string
) {
  await supabase
    .from('lottery_state')
    .upsert({
      user_id: userId,
      pity_counter: pityCounter,
      total_draws: totalDraws,
      last_draw_at: lastDrawAt,
      updated_at: lastDrawAt,
    }, { onConflict: 'user_id' });
}

// 辅助: 插入抽卡记录
async function insertDraw(
  supabase: SupabaseClient,
  userId: string,
  item: LotteryItem,
  cost: number,
  drawIndex: number,
  isPity: number
) {
  const id = uuidv4();
  await supabase.from('lottery_draws').insert({
    id,
    user_id: userId,
    item_id: item.id,
    points_spent: cost,
    is_pity: isPity,
    draw_index: drawIndex,
    created_at: new Date().toISOString(),
  });
  return id;
}

// 发放奖励
async function grantReward(
  supabase: SupabaseClient,
  userId: string,
  item: LotteryItem,
  drawId: string
): Promise<number> {
  if (item.reward_type === 'points') {
    const amount = Math.max(0, item.points_amount || 0);
    if (amount <= 0) return 0;
    const sec = await getSettingNumber(supabase, 'lottery_points_expiry_seconds', 2592000);
    const exp = sec > 0 ? new Date(Date.now() + sec * 1000).toISOString() : null;
    await addPoints(supabase, userId, amount, 'admin_adjust', drawId, `抽卡获得: ${item.name}`, exp);
    return amount;
  }

  const { data: existing } = await supabase
    .from('user_backpack')
    .select('id,quantity')
    .eq('user_id', userId)
    .eq('item_id', item.id)
    .eq('is_redeemed', 0)
    .maybeSingle();

  if (existing?.id) {
    await supabase
      .from('user_backpack')
      .update({ quantity: (existing.quantity ?? 1) + 1 })
      .eq('id', existing.id);
  } else {
    await supabase.from('user_backpack').insert({
      id: uuidv4(),
      user_id: userId,
      item_id: item.id,
      item_name: item.name,
      item_icon: item.icon,
      rarity: item.rarity,
      quantity: 1,
      is_redeemed: 0,
      source_draw_id: drawId,
      created_at: new Date().toISOString(),
    });
  }
  return 0;
}

// ──────────── 单抽 ────────────
export async function drawSingle(supabase: SupabaseClient, userId: string) {
  const cost = await getSettingNumber(supabase, 'lottery_cost', 50);
  const pityCount = Math.max(1, await getSettingNumber(supabase, 'lottery_pity_count', 80));
  const items = await getActiveItems(supabase);
  if (!items.length) return { error: '暂无可用奖品' };
  const totalProb = items.reduce((s, i) => s + i.probability, 0);
  if (totalProb <= 0) return { error: '奖品概率配置异常' };

  const deduct = await deductPointsFIFO(supabase, userId, cost, 'shop_purchase', '', '单抽消耗');
  if (!deduct.success) return { error: '点数不足', balance: deduct.balanceAfter };

  const pityItemId = await getSetting(supabase, 'lottery_pity_item_id', '');
  const state = await getOrInitLotteryState(supabase, userId, pityCount);
  let counter = state.pity_counter + 1; // 本次抽完后计数
  let isPity = false;
  let selected = rollItem(items, totalProb);

  if (counter >= pityCount) {
    isPity = true;
    selected = items.find((i) => i.id === pityItemId) || rollItem(items, totalProb);
    counter = 0; // 触发保底后归零
  }

  const drawId = await insertDraw(supabase, userId, selected, cost, isPity ? pityCount : counter, isPity ? 1 : 0);
  await grantReward(supabase, userId, selected, drawId);

  const now = new Date().toISOString();
  await saveLotteryState(supabase, userId, counter, state.total_draws + 1, now);

  const actualBalance = await getRealtimeBalance(supabase, userId);
  const displayCurrent = Math.min(counter, pityCount);
  return { item: selected, is_pity: isPity, balance_after: actualBalance, pity_progress: { current: displayCurrent, max: pityCount } };
}

// ──────────── 十连 ────────────
export async function drawMulti(supabase: SupabaseClient, userId: string) {
  const cost = await getSettingNumber(supabase, 'lottery_cost', 50);
  const totalCost = cost * 10;
  const pityCount = Math.max(1, await getSettingNumber(supabase, 'lottery_pity_count', 80));

  const state = await getOrInitLotteryState(supabase, userId, pityCount);
  if (state.pity_counter >= pityCount - 10) {
    return { error: '保底即将触发，请使用单抽完成最后几抽', balance: state.pity_counter };
  }

  const items = await getActiveItems(supabase);
  if (!items.length) return { error: '暂无可用奖品' };
  const totalProb = items.reduce((s, i) => s + i.probability, 0);
  if (totalProb <= 0) return { error: '奖品概率配置异常' };

  const deduct = await deductPointsFIFO(supabase, userId, totalCost, 'shop_purchase', '', '十连消耗');
  if (!deduct.success) return { error: '点数不足', balance: deduct.balanceAfter };

  const pityItemId = await getSetting(supabase, 'lottery_pity_item_id', '');
  let counter = state.pity_counter;
  let totalDraws = state.total_draws;
  const results: Array<{ item: LotteryItem; is_pity: boolean; draw_index: number }> = [];
  let pointsGained = 0;
  let lastDrawAt = new Date().toISOString();

  for (let i = 0; i < 10; i++) {
    counter++;
    let isPity = false;
    let picked = rollItem(items, totalProb);

    if (counter >= pityCount) {
      isPity = true;
      picked = items.find((x) => x.id === pityItemId) || rollItem(items, totalProb);
      counter = 0;
    }

    const drawId = uuidv4();
    lastDrawAt = new Date().toISOString();
    await supabase.from('lottery_draws').insert({
      id: drawId,
      user_id: userId,
      item_id: picked.id,
      points_spent: cost,
      is_pity: isPity ? 1 : 0,
      draw_index: isPity ? pityCount : counter,
      created_at: lastDrawAt,
    });

    const granted = await grantReward(supabase, userId, picked, drawId);
    pointsGained += granted;
    totalDraws += 1;

    results.push({ item: picked, is_pity: isPity, draw_index: isPity ? pityCount : counter });
  }

  const finalBalance = await getRealtimeBalance(supabase, userId);
  const numPity = results.filter((r) => r.is_pity).length;

  await saveLotteryState(supabase, userId, counter, totalDraws, lastDrawAt);
  const displayCurrent = Math.min(counter, pityCount);

  return {
    items: results.map((r) => ({
      name: r.item.name,
      icon: r.item.icon,
      rarity: r.item.rarity,
      reward_type: r.item.reward_type,
      points_amount: r.item.points_amount,
      is_pity: r.is_pity,
    })),
    pity_count: numPity,
    points_gained: pointsGained,
    balance_after: finalBalance,
    pity_progress: { current: displayCurrent, max: pityCount },
    total_cost: totalCost,
  };
}

export async function getPityProgress(
  supabase: SupabaseClient,
  userId: string
): Promise<{ current: number; max: number; targetItemName: string }> {
  const pityCount = Math.max(1, await getSettingNumber(supabase, 'lottery_pity_count', 80));
  const pityItemId = await getSetting(supabase, 'lottery_pity_item_id', '');
  const state = await getOrInitLotteryState(supabase, userId, pityCount);
  const since = Math.min(state.pity_counter, pityCount);
  let targetName = '';
  if (pityItemId) {
    const items = await getActiveItems(supabase);
    targetName = items.find((i) => i.id === pityItemId)?.name ?? '';
  }
  return { current: since, max: pityCount, targetItemName: targetName };
}

export async function getLotteryItems(supabase: SupabaseClient): Promise<LotteryItem[]> {
  return getActiveItems(supabase);
}

export async function getBackpack(supabase: SupabaseClient, userId: string): Promise<Array<any>> {
  const { data } = await supabase
    .from('user_backpack')
    .select('*')
    .eq('user_id', userId)
    .order('is_redeemed', { ascending: true })
    .order('created_at', { ascending: false });
  return (data ?? []) as any[];
}

export async function getDrawHistory(supabase: SupabaseClient, userId: string, page: number, pageSize: number) {
  const off = (page - 1) * pageSize;
  const { count } = await supabase
    .from('lottery_draws')
    .select('*', { count: 'exact', head: true })
    .eq('user_id', userId);

  const { data: draws } = await supabase
    .from('lottery_draws')
    .select('*')
    .eq('user_id', userId)
    .order('created_at', { ascending: false })
    .range(off, off + pageSize - 1);

  const rows = draws ?? [];
  const itemIds = Array.from(new Set(rows.map((d: any) => d.item_id)));
  const { data: items } = itemIds.length ? await supabase.from('lottery_items').select('id,name,icon,rarity').in('id', itemIds) : { data: [] };
  const itemMap = new Map<string, any>();
  for (const i of items ?? []) itemMap.set(i.id, i);

  const mapped = rows.map((d: any) => ({
    ...d,
    item_name: itemMap.get(d.item_id)?.name,
    item_icon: itemMap.get(d.item_id)?.icon,
    rarity: itemMap.get(d.item_id)?.rarity,
  }));

  return { draws: mapped, total: count ?? 0 };
}
