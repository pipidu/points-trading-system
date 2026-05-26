// ============================================================
// 动态设置服务 - 热重载配置 (Supabase)
// ============================================================
import { SupabaseClient } from '@supabase/supabase-js';

interface SettingsCache {
  data: Map<string, string>;
  fetchedAt: number;
}

let cache: SettingsCache = { data: new Map(), fetchedAt: 0 };
const CACHE_TTL = 60_000; // 1 分钟缓存

export function clearCache() {
  cache = { data: new Map(), fetchedAt: 0 };
}

async function fetchAllSettings(supabase: SupabaseClient): Promise<Map<string, string>> {
  const { data, error } = await supabase
    .from('settings')
    .select('key, value');
  if (error) return new Map();
  const map = new Map<string, string>();
  for (const row of (data ?? [])) {
    map.set(row.key, row.value);
  }
  return map;
}

export async function getSetting(supabase: SupabaseClient, key: string, defaultValue: string = ''): Promise<string> {
  const now = Date.now();
  if (now - cache.fetchedAt > CACHE_TTL) {
    cache.data = await fetchAllSettings(supabase);
    cache.fetchedAt = now;
  }
  return cache.data.get(key) ?? defaultValue;
}

export async function getSettingNumber(supabase: SupabaseClient, key: string, defaultValue: number = 0): Promise<number> {
  const val = await getSetting(supabase, key, String(defaultValue));
  return parseFloat(val) || defaultValue;
}

export async function setSetting(supabase: SupabaseClient, key: string, value: string): Promise<void> {
  const { error } = await supabase
    .from('settings')
    .upsert({ key, value, updated_at: new Date().toISOString() }, { onConflict: 'key' });
  if (error) console.error('[setSetting]', error);
  // 立即更新缓存
  cache.data.set(key, value);
}

export async function getAllSettings(supabase: SupabaseClient): Promise<Array<{ key: string; value: string; description: string }>> {
  const { data, error } = await supabase
    .from('settings')
    .select('key, value, description')
    .order('key');
  if (error) return [];
  return (data as any[]) ?? [];
}

export async function getSettingJSON<T>(supabase: SupabaseClient, key: string, defaultValue: T): Promise<T> {
  const val = await getSetting(supabase, key, '');
  if (!val) return defaultValue;
  try { return JSON.parse(val); } catch { return defaultValue; }
}

export async function setSettingJSON(supabase: SupabaseClient, key: string, value: unknown): Promise<void> {
  await setSetting(supabase, key, JSON.stringify(value));
}
