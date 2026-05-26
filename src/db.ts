// ============================================================
// Supabase 客户端 - 替代 D1
// ============================================================
import { createClient, SupabaseClient } from '@supabase/supabase-js';

let supabaseInstance: SupabaseClient | null = null;

export function getSupabase(supabaseUrl: string, supabaseKey: string): SupabaseClient {
  if (!supabaseInstance) {
    supabaseInstance = createClient(supabaseUrl, supabaseKey, {
      auth: { persistSession: false },
      db: { schema: 'public' },
    });
  }
  return supabaseInstance;
}

export function resetSupabaseClient(): void {
  supabaseInstance = null;
}

// ========== 辅助查询函数 ==========

/** 获取单行 */
export async function queryOne<T>(
  supabase: SupabaseClient,
  table: string,
  column: string,
  value: string,
  select: string = '*'
): Promise<T | null> {
  const { data, error } = await supabase
    .from(table)
    .select(select)
    .eq(column, value)
    .single();
  if (error) return null;
  return data as T;
}

/** 获取多行 */
export async function queryAll<T>(
  supabase: SupabaseClient,
  table: string,
  column: string,
  value: string,
  select: string = '*'
): Promise<T[]> {
  const { data, error } = await supabase
    .from(table)
    .select(select)
    .eq(column, value);
  if (error) return [];
  return (data as T[]) ?? [];
}

/** 原始 SQL 查询 (通过 REST API) */
export async function queryRaw<T>(
  supabase: SupabaseClient,
  query: string,
  params?: any[]
): Promise<{ data: T[] | null; error: any }> {
  // 使用 rpc 或直接查询
  // Supabase JS 客户端不直接支持原始 SQL，通过 REST API 发送
  const url = `${supabase['supabaseUrl']}/rest/v1/rpc/exec_sql`;
  // 实际上 Supabase 支持通过 .rpc() 调用存储过程
  // 对于复杂查询，我们将使用 supabase 的查询构建器
  // 或者创建 PostgreSQL 函数
  return { data: null, error: 'Use supabase query builder instead' };
}

/** 计数查询 */
export async function queryCount(
  supabase: SupabaseClient,
  table: string,
  column?: string,
  value?: string
): Promise<number> {
  let query = supabase.from(table).select('*', { count: 'exact', head: true });
  if (column && value !== undefined) {
    query = query.eq(column, value);
  }
  const { count, error } = await query;
  if (error) return 0;
  return count ?? 0;
}

/** 批量插入 */
export async function batchInsert(
  supabase: SupabaseClient,
  table: string,
  rows: Record<string, any>[]
): Promise<void> {
  const { error } = await supabase.from(table).insert(rows);
  if (error) console.error(`[batchInsert] ${table}:`, error);
}
