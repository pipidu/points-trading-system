// ============================================================
// 点数核心服务 - user_balance 精确余额 (Supabase)
// 每次增减立刻同步更新 user_balance.available，无需扫描流水
// ============================================================
import { v4 as uuidv4 } from 'uuid';
import { SupabaseClient } from '@supabase/supabase-js';

const BAL_TTL = 60;
const memBalance = new Map<string, { bal: number; ts: number }>();

async function loadBalance(supabase: SupabaseClient, userId: string): Promise<number> {
  const { data, error } = await supabase
    .from('user_balance')
    .select('available')
    .eq('user_id', userId)
    .single();
  if (error || !data) return 0;
  return data.available ?? 0;
}

async function saveBalance(supabase: SupabaseClient, userId: string, bal: number): Promise<void> {
  const { error } = await supabase
    .from('user_balance')
    .upsert({ user_id: userId, available: bal }, { onConflict: 'user_id' });
  if (error) console.error('[saveBalance]', error);
}

async function updateCache(userId: string, bal: number, kv?: KVNamespace) {
  memBalance.set(userId, { bal, ts: Date.now() });
  if (kv) kv.put(`bal:${userId}`, JSON.stringify({ bal, ts: Date.now() }), { expirationTtl: BAL_TTL }).catch(() => {});
}

export async function getRealtimeBalance(supabase: SupabaseClient, userId: string, kv?: KVNamespace): Promise<number> {
  const mem = memBalance.get(userId);
  if (mem && Date.now() - mem.ts < BAL_TTL * 1000) return mem.bal;
  if (kv) {
    try {
      const v = await kv.get(`bal:${userId}`, 'json') as { bal: number; ts: number } | null;
      if (v && Date.now() - v.ts < BAL_TTL * 1000) { memBalance.set(userId, v); return v.bal; }
    } catch {}
  }
  const bal = await loadBalance(supabase, userId);
  updateCache(userId, bal, kv).catch(() => {});
  return bal;
}

export async function deductPointsFIFO(
  supabase: SupabaseClient,
  userId: string,
  amount: number,
  type: string,
  refId: string,
  description: string,
  kv?: KVNamespace
): Promise<{ success: boolean; deductions: Array<{ entryId: string; deducted: number }>; balanceAfter: number }> {
  if (amount <= 0) return { success: false, deductions: [], balanceAfter: await getRealtimeBalance(supabase, userId, kv) };

  const currentBal = await getRealtimeBalance(supabase, userId, kv);
  if (currentBal < amount) return { success: false, deductions: [], balanceAfter: currentBal };

  const now = new Date().toISOString();
  const { error } = await supabase.from('point_ledger').insert({
    id: uuidv4(),
    user_id: userId,
    amount: -amount,
    balance_after: 0,
    type,
    ref_id: refId,
    description,
    expires_at: null,
    created_at: now,
  });
  if (error) {
    console.error('[deductPointsFIFO]', error);
    return { success: false, deductions: [], balanceAfter: currentBal };
  }

  const newBal = currentBal - amount;
  await saveBalance(supabase, userId, newBal);
  updateCache(userId, newBal, kv).catch(() => {});
  return { success: true, deductions: [], balanceAfter: newBal };
}

export async function addPoints(
  supabase: SupabaseClient,
  userId: string,
  amount: number,
  type: string,
  refId: string,
  description: string,
  expiresAt: string | null,
  kv?: KVNamespace
): Promise<{ id: string; balanceAfter: number }> {
  if (amount <= 0) throw new Error('点数必须为正数');

  const oldBal = await getRealtimeBalance(supabase, userId, kv);
  const id = uuidv4();
  const now = new Date().toISOString();
  const { error } = await supabase.from('point_ledger').insert({
    id,
    user_id: userId,
    amount,
    balance_after: 0,
    type,
    ref_id: refId,
    description,
    expires_at: expiresAt,
    created_at: now,
  });
  if (error) {
    console.error('[addPoints]', error);
    return { id, balanceAfter: oldBal };
  }

  const newBal = oldBal + amount;
  await saveBalance(supabase, userId, newBal);
  updateCache(userId, newBal, kv).catch(() => {});
  return { id, balanceAfter: newBal };
}

export async function applyDirectDelta(
  supabase: SupabaseClient,
  userId: string,
  delta: number,
  type: string,
  refId: string,
  description: string,
  kv?: KVNamespace
): Promise<{ balanceAfter: number }> {
  if (delta === 0) return { balanceAfter: await getRealtimeBalance(supabase, userId, kv) };

  const oldBal = await getRealtimeBalance(supabase, userId, kv);
  const now = new Date().toISOString();
  const { error } = await supabase.from('point_ledger').insert({
    id: uuidv4(),
    user_id: userId,
    amount: delta,
    balance_after: 0,
    type,
    ref_id: refId,
    description,
    expires_at: null,
    created_at: now,
  });
  if (error) {
    console.error('[applyDirectDelta]', error);
    return { balanceAfter: oldBal };
  }

  const newBal = oldBal + delta;
  await saveBalance(supabase, userId, newBal);
  updateCache(userId, newBal, kv).catch(() => {});
  return { balanceAfter: newBal };
}

export async function getLedgerEntries(supabase: SupabaseClient, userId: string, page: number, pageSize: number) {
  const offset = (page - 1) * pageSize;
  const { count } = await supabase
    .from('point_ledger')
    .select('*', { count: 'exact', head: true })
    .eq('user_id', userId);

  const { data: entries } = await supabase
    .from('point_ledger')
    .select('*')
    .eq('user_id', userId)
    .order('created_at', { ascending: false })
    .range(offset, offset + pageSize - 1);

  return { entries: entries ?? [], total: count ?? 0 };
}

export async function adminAdjustPoints(
  supabase: SupabaseClient,
  userId: string,
  amount: number,
  adminId: string,
  description: string,
  expiresAt: string | null,
  kv?: KVNamespace
): Promise<{ balanceAfter: number }> {
  if (amount > 0) {
    const r = await addPoints(supabase, userId, amount, 'admin_adjust', '', description, expiresAt, kv);
    return { balanceAfter: r.balanceAfter };
  } else if (amount < 0) {
    // 管理员扣点使用 applyDirectDelta，允许扣成负数，不检查余额
    const r = await applyDirectDelta(supabase, userId, amount, 'admin_adjust', '', description, kv);
    return { balanceAfter: r.balanceAfter };
  }
  return { balanceAfter: await getRealtimeBalance(supabase, userId, kv) };
}

export async function reconcileUserBalance(supabase: SupabaseClient, userId: string): Promise<number> {
  memBalance.delete(userId);
  const now = new Date().toISOString();
  const { data: positives } = await supabase
    .from('point_ledger')
    .select('id,amount,expires_at')
    .eq('user_id', userId)
    .gt('amount', 0)
    .or(`expires_at.is.null,expires_at.gt.${now}`);
  const posSum = (positives ?? []).reduce((s: number, r: any) => s + r.amount, 0);
  const { data: negatives } = await supabase
    .from('point_ledger')
    .select('amount')
    .eq('user_id', userId)
    .lt('amount', 0);
  const negSum = (negatives ?? []).reduce((s: number, r: any) => s + r.amount, 0);
  const bal = posSum + negSum;
  await saveBalance(supabase, userId, bal);
  return bal;
}
