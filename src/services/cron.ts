// ============================================================
// 定时任务调度器 (每分钟轮询, 按配置判断是否执行)
// ============================================================
import { SupabaseClient } from '@supabase/supabase-js';
import { addPoints, applyDirectDelta } from './points';
import { getSetting, getSettingNumber, setSetting } from './settings';
import { Env } from '../types';

/**
 * 主调度入口 - 每分钟由 Worker Cron 触发
 */
export async function runScheduledTasks(supabase: SupabaseClient, env: Env): Promise<string[]> {
  const logs: string[] = [];
  const now = new Date();
  const nowISO = now.toISOString();

  // 1. 基础点数发放检查
  const log1 = await distributeBasePoints(supabase, env, now);
  if (log1) logs.push(log1);

  // 2. 贷款计息检查 (每周)
  const log2 = await chargeLoanInterest(supabase, env, nowISO);
  if (log2) logs.push(log2);

  // 3. 逾期贷款罚息检查 (每月)
  const log3 = await checkLoanDefaults(supabase, env, now);
  if (log3) logs.push(log3);

  return logs;
}

/**
 * 发放基础点数 (根据动态配置的周期和上次发放时间判断)
 */
async function distributeBasePoints(supabase: SupabaseClient, env: Env, now: Date): Promise<string | null> {
  const periodMinutes = await getSettingNumber(supabase, 'base_points_period_minutes', 10080);
  const pointsAmount = await getSettingNumber(supabase, 'base_points_amount', 100);
  const expirySeconds = await getSettingNumber(supabase, 'base_points_expiry_seconds', 2592000);
  const lastDistStr = await getSetting(supabase, 'base_points_last_distribution', '');

  if (lastDistStr) {
    const lastDist = new Date(lastDistStr);
    const elapsedMs = now.getTime() - lastDist.getTime();
    const elapsedMinutes = elapsedMs / 60_000;
    if (elapsedMinutes < periodMinutes) return null; // 还没到时间
  }

  const { data: users } = await supabase.from('users').select('id').eq('role', 'user');
  if (!users || users.length === 0) return 'No users to distribute';

  const expiryDate = expirySeconds > 0
    ? new Date(now.getTime() + expirySeconds * 1000).toISOString()
    : null;

  for (const user of users) {
    await addPoints(supabase, user.id, pointsAmount, 'base', '', '基础点数发放', expiryDate, env.KV);
  }

  await setSetting(supabase, 'base_points_last_distribution', now.toISOString());
  return `Distributed ${pointsAmount} base points to ${users.length} users`;
}

/**
 * 每周贷款计息
 */
async function chargeLoanInterest(supabase: SupabaseClient, env: Env, nowISO: string): Promise<string | null> {
  const rate = await getSettingNumber(supabase, 'loan_weekly_interest_rate', 0.05);
  const weekAgo = new Date(Date.now() - 7 * 86400000).toISOString();

  const { data: loans } = await supabase
    .from('loans')
    .select('id,user_id,remaining,weekly_interest_rate')
    .eq('status', 'active')
    .or(`last_interest_at.is.null,last_interest_at.lte.${weekAgo}`);

  if (!loans || loans.length === 0) return null;

  let interestCharged = 0;
  for (const loan of loans) {
    const actualRate = loan.weekly_interest_rate || rate;
    const interest = Math.ceil(loan.remaining * actualRate);
    if (interest <= 0) continue;

    const newRemaining = loan.remaining + interest;
    await supabase
      .from('loans')
      .update({ remaining: newRemaining, last_interest_at: nowISO })
      .eq('id', loan.id);

    await applyDirectDelta(supabase, loan.user_id, -interest, 'loan_repay', loan.id, '贷款利息', env.KV);
    interestCharged += interest;
  }

  return `Charged ${interestCharged} points interest on ${loans.length} loans`;
}

/**
 * 逾期贷款罚款 (借款超过N天未还 → 双倍扣款)
 */
async function checkLoanDefaults(supabase: SupabaseClient, env: Env, now: Date): Promise<string | null> {
  const penaltyDays = await getSettingNumber(supabase, 'loan_penalty_days', 30);
  const penaltyMultiplier = await getSettingNumber(supabase, 'loan_penalty_multiplier', 2);
  const overdueBefore = new Date(now.getTime() - penaltyDays * 86400000).toISOString();

  const { data: loans } = await supabase
    .from('loans')
    .select('id,user_id,remaining')
    .eq('status', 'active')
    .lte('borrowed_at', overdueBefore);

  if (!loans || loans.length === 0) return null;

  let totalPenalty = 0;
  for (const loan of loans) {
    const penalty = Math.ceil(loan.remaining * penaltyMultiplier);

    await supabase.from('loans').update({ status: 'defaulted' }).eq('id', loan.id);
    await applyDirectDelta(
      supabase,
      loan.user_id,
      -penalty,
      'loan_penalty',
      loan.id,
      `贷款逾期违约罚息(${penaltyMultiplier}倍)`,
      env.KV
    );

    totalPenalty += penalty;
  }

  return `Defaulted ${loans.length} loans, total penalty: ${totalPenalty} points`;
}
