// ============================================================
// 类型定义 & 常量
// ============================================================
import { SupabaseClient } from '@supabase/supabase-js';

// 环境变量绑定
export interface Env {
  SUPABASE_URL: string;
  SUPABASE_KEY: string;
  JWT_SECRET: string;
  ADMIN_DEFAULT_USERNAME: string;
  ADMIN_DEFAULT_PASSWORD: string;
  TURNSTILE_SITE_KEY: string;
  TURNSTILE_SECRET_KEY: string;
  SERVERCHAN_SENDKEY: string;
  R2: R2Bucket;
  KV: KVNamespace;
  ASSETS: { fetch: (request: Request) => Promise<Response> };
}

export interface User {
  id: string;
  username: string;
  password_hash: string;
  role: 'admin' | 'user';
  display_name: string;
  balance_snapshot: number;
  last_login_at: string;
  last_login_ip: string;
  created_at: string;
  updated_at: string;
}

export interface SafeUser {
  id: string;
  username: string;
  role: 'admin' | 'user';
  display_name: string;
  realtime_balance: number;
  created_at: string;
}

export interface Task {
  id: string;
  title: string;
  description: string;
  points_min: number;
  points_max: number;
  period_type: 'daily' | 'weekly' | 'monthly';
  period_value: number;
  submission_type: 'image' | 'text' | 'both';
  is_active: number;
  expiry_seconds: number | null;
  created_at: string;
  updated_at: string;
}

export interface TaskSubmission {
  id: string;
  task_id: string;
  user_id: string;
  content_text: string;
  image_url: string;
  status: 'pending' | 'approved' | 'rejected';
  admin_remark: string;
  awarded_points: number | null;
  reviewed_by: string | null;
  reviewed_at: string | null;
  period_label: string;
  created_at: string;
}

export interface PointLedgerEntry {
  id: string;
  user_id: string;
  amount: number;
  balance_after: number;
  type: 'base' | 'task' | 'admin_adjust' | 'shop_purchase' | 'loan_repay' | 'loan_penalty' | 'expiry';
  ref_id: string;
  description: string;
  expires_at: string | null;
  created_at: string;
}

export interface ShopItem {
  id: string;
  name: string;
  description: string;
  image_url: string;
  points_required: number;
  stock: number;
  is_active: number;
  created_at: string;
  updated_at: string;
}

export interface RedemptionOrder {
  id: string;
  user_id: string;
  item_id: string;
  content_text: string;
  image_url: string;
  status: 'pending' | 'approved' | 'rejected';
  points_spent: number;
  admin_remark: string;
  reviewed_by: string | null;
  reviewed_at: string | null;
  created_at: string;
}

export interface Loan {
  id: string;
  user_id: string;
  principal: number;
  remaining: number;
  weekly_interest_rate: number;
  status: 'active' | 'repaid' | 'defaulted';
  borrowed_at: string;
  last_interest_at: string | null;
  repaid_at: string | null;
  created_at: string;
}

export interface LoanRepayment {
  id: string;
  loan_id: string;
  user_id: string;
  amount: number;
  created_at: string;
}

export interface AdminLog {
  id: string;
  admin_id: string;
  action: string;
  target_type: string;
  target_id: string;
  detail: string;
  created_at: string;
}

// ========== 抽奖 & 背包 ==========
export interface LotteryItem {
  id: string;
  name: string;
  description: string;
  image_url: string;
  icon: string;
  rarity: 'common' | 'rare' | 'epic' | 'legendary';
  probability: number;
  reward_type: 'item' | 'points';
  points_amount: number;
  is_active: number;
  sort_order: number;
  created_at: string;
  updated_at: string;
}

export interface LotteryDraw {
  id: string;
  user_id: string;
  item_id: string;
  points_spent: number;
  is_pity: number;
  draw_index: number;
  created_at: string;
}

export interface BackpackItem {
  id: string;
  user_id: string;
  item_id: string;
  item_name: string;
  item_icon: string;
  rarity: string;
  quantity: number;
  is_redeemed: number;
  source_draw_id: string | null;
  created_at: string;
}

export interface BackpackRedemption {
  id: string;
  user_id: string;
  backpack_id: string;
  content_text: string;
  image_url: string;
  status: 'pending' | 'approved' | 'rejected';
  admin_remark: string;
  reviewed_by: string | null;
  reviewed_at: string | null;
  created_at: string;
}

// ========== 随机任务组 ==========
export interface RandomTaskGroup {
  id: string;
  name: string;
  period_type: 'daily' | 'weekly' | 'monthly';
  is_active: number;
  created_at: string;
  updated_at: string;
}

export interface SurpriseTask {
  id: string;
  user_id: string;
  group_id: string;
  task_id: string;
  period_label: string;
  is_completed: number;
  submission_id: string | null;
  created_at: string;
  task_title?: string;
  task_description?: string;
  points_min?: number;
  points_max?: number;
  submission_type?: string;
}

// ========== 独立随机任务 ==========
export interface RandomTask {
  id: string;
  title: string;
  description: string;
  points_min: number;
  points_max: number;
  submission_type: 'image' | 'text' | 'both';
  expiry_seconds: number | null;
  is_active: number;
  created_at: string;
  updated_at: string;
}

// ========== 变量 ==========
export const JWT_EXPIRY = '24h';
export const PAGE_SIZE = 20;
