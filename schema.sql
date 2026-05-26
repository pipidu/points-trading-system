-- ============================================================
-- 点数交易系统 Supabase (PostgreSQL) Schema
-- 支持：秒级过期、动态配置、FIFO扣减、贷款罚息
-- ============================================================

create extension if not exists "pgcrypto";

-- 用户表 (管理员后台创建，不对外开放注册)
create table if not exists users (
  id uuid primary key default gen_random_uuid(),
  username text not null unique,
  password_hash text not null,
  role text not null default 'user',
  display_name text not null default '',
  balance_snapshot integer not null default 0,
  last_login_at timestamptz null,
  last_login_ip text not null default '',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists idx_users_username on users(username);
create index if not exists idx_users_role on users(role);

-- 系统配置表 (管理员热更新，无需重启 Worker)
create table if not exists settings (
  key text primary key,
  value text not null,
  description text not null default '',
  updated_at timestamptz not null default now()
);

insert into settings (key, value, description) values
('base_points_amount', '100', '每次发放的基础点数'),
('base_points_period_minutes', '10080', '基础点数发放周期(分钟), 默认10080=7天'),
('base_points_expiry_seconds', '2592000', '基础点数有效期(秒), 默认2592000=30天'),
('base_points_last_distribution', '', '上次发放基础点数的时间 ISO8601'),
('task_point_expiry_seconds', '604800', '任务点数的默认有效期(秒), 默认604800=7天'),
('loan_weekly_interest_rate', '0.05', '贷款周利率, 0.05=5%'),
('loan_penalty_multiplier', '2', '逾期罚款倍数, 默认2倍'),
('loan_penalty_days', '30', '逾期判定天数, 默认30天'),
('shop_purchase_expiry_seconds', '0', '兑换物品点数有效期(秒), 0=永久有效(无过期)'),
('allow_negative_balance', 'true', '是否允许负债(true/false)，负数时禁止购买'),
('lottery_cost', '50', '抽卡单次消耗点数'),
('lottery_pity_count', '80', '抽卡保底次数'),
('lottery_pity_item_id', '', '抽卡保底奖品ID'),
('lottery_points_expiry_seconds', '2592000', '抽卡获得点数有效期(秒)'),
('login_captcha_mode', 'none', '登录验证码模式: none / turnstile / captcha')
on conflict (key) do nothing;

-- 任务定义表 (管理员创建)
create table if not exists tasks (
  id uuid primary key default gen_random_uuid(),
  title text not null,
  description text not null default '',
  points_min integer not null default 0,
  points_max integer not null default 0,
  period_type text not null default 'daily',
  period_value integer not null default 1,
  submission_type text not null default 'both',
  is_active integer not null default 1,
  expiry_seconds integer null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists idx_tasks_active on tasks(is_active);

-- 任务提交记录表
create table if not exists task_submissions (
  id uuid primary key default gen_random_uuid(),
  task_id uuid not null,
  user_id uuid not null references users(id),
  content_text text not null default '',
  image_url text not null default '',
  status text not null default 'pending',
  admin_remark text not null default '',
  awarded_points integer null,
  reviewed_by uuid null references users(id),
  reviewed_at timestamptz null,
  period_label text not null default '',
  created_at timestamptz not null default now()
);
create index if not exists idx_submissions_user on task_submissions(user_id);
create index if not exists idx_submissions_task on task_submissions(task_id);
create index if not exists idx_submissions_status on task_submissions(status);
create index if not exists idx_submissions_period on task_submissions(user_id, task_id, period_label);

-- 点数流水表 (核心：每笔收入记录有效期，支持秒级FIFO)
create table if not exists point_ledger (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references users(id),
  amount integer not null,
  balance_after integer not null default 0,
  type text not null,
  ref_id text not null default '',
  description text not null default '',
  expires_at timestamptz null,
  created_at timestamptz not null default now()
);
create index if not exists idx_ledger_user on point_ledger(user_id);
create index if not exists idx_ledger_expires on point_ledger(expires_at);
create index if not exists idx_ledger_type on point_ledger(type);
create index if not exists idx_ledger_fifo on point_ledger(user_id, expires_at, amount);
create index if not exists idx_ledger_neg_ref on point_ledger(user_id, amount, ref_id);

-- 商品表 (管理员配置可兑换物品)
create table if not exists shop_items (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  description text not null default '',
  image_url text not null default '',
  points_required integer not null default 0,
  stock integer not null default -1,
  is_active integer not null default 1,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- 兑换订单表
create table if not exists redemption_orders (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references users(id),
  item_id uuid not null references shop_items(id),
  content_text text not null default '',
  image_url text not null default '',
  status text not null default 'pending',
  points_spent integer not null default 0,
  admin_remark text not null default '',
  reviewed_by uuid null references users(id),
  reviewed_at timestamptz null,
  created_at timestamptz not null default now()
);
create index if not exists idx_redemption_user on redemption_orders(user_id);
create index if not exists idx_redemption_status on redemption_orders(status);

-- 贷款表
create table if not exists loans (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references users(id),
  principal integer not null,
  remaining integer not null,
  weekly_interest_rate double precision not null default 0.05,
  status text not null default 'active',
  borrowed_at timestamptz not null default now(),
  last_interest_at timestamptz null,
  repaid_at timestamptz null,
  created_at timestamptz not null default now()
);
create index if not exists idx_loans_user on loans(user_id);
create index if not exists idx_loans_status on loans(status);
create index if not exists idx_loans_cron on loans(status, last_interest_at);
create index if not exists idx_loans_default on loans(status, borrowed_at);

-- 还款记录表
create table if not exists loan_repayments (
  id uuid primary key default gen_random_uuid(),
  loan_id uuid not null references loans(id),
  user_id uuid not null references users(id),
  amount integer not null,
  created_at timestamptz not null default now()
);
create index if not exists idx_repay_loan on loan_repayments(loan_id);

-- 管理员操作日志
create table if not exists admin_logs (
  id uuid primary key default gen_random_uuid(),
  admin_id uuid not null references users(id),
  action text not null,
  target_type text not null default '',
  target_id text not null default '',
  detail text not null default '',
  created_at timestamptz not null default now()
);
create index if not exists idx_admin_logs_admin on admin_logs(admin_id);
create index if not exists idx_admin_logs_created on admin_logs(created_at);

-- ============================================================
-- 抽奖奖品表
-- ============================================================
create table if not exists lottery_items (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  description text not null default '',
  image_url text not null default '',
  icon text not null default '🎁',
  rarity text not null default 'common',
  probability double precision not null default 0.05,
  reward_type text not null default 'item',
  points_amount integer not null default 0,
  is_active integer not null default 1,
  sort_order integer not null default 0,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists idx_lottery_items_active on lottery_items(is_active, sort_order);

-- 用户抽奖记录表
create table if not exists lottery_draws (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references users(id),
  item_id uuid not null references lottery_items(id),
  points_spent integer not null,
  is_pity integer not null default 0,
  draw_index integer not null default 0,
  created_at timestamptz not null default now()
);
create index if not exists idx_lottery_draws_user on lottery_draws(user_id);
create index if not exists idx_lottery_draws_time on lottery_draws(user_id, created_at);
create index if not exists idx_lottery_draws_pity on lottery_draws(user_id, is_pity, created_at);
create index if not exists idx_lottery_draws_item on lottery_draws(item_id);

-- 用户抽卡状态 (保底计数等)
create table if not exists lottery_state (
  user_id uuid primary key references users(id),
  pity_counter integer not null default 0,
  total_draws integer not null default 0,
  last_draw_at timestamptz null,
  updated_at timestamptz not null default now()
);

-- 用户背包表
create table if not exists user_backpack (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references users(id),
  item_id uuid not null references lottery_items(id),
  item_name text not null default '',
  item_icon text not null default '🎁',
  rarity text not null default 'common',
  quantity integer not null default 1,
  is_redeemed integer not null default 0,
  source_draw_id uuid null references lottery_draws(id),
  created_at timestamptz not null default now()
);
create index if not exists idx_backpack_user on user_backpack(user_id);
create index if not exists idx_backpack_redeemed on user_backpack(user_id, is_redeemed);
create index if not exists idx_backpack_dedup on user_backpack(user_id, item_id, is_redeemed);

-- 背包物品兑换申请表
create table if not exists backpack_redemptions (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references users(id),
  backpack_id uuid not null references user_backpack(id),
  content_text text not null default '',
  image_url text not null default '',
  status text not null default 'pending',
  admin_remark text not null default '',
  reviewed_by uuid null references users(id),
  reviewed_at timestamptz null,
  created_at timestamptz not null default now()
);
create index if not exists idx_bp_redemption_user on backpack_redemptions(user_id);
create index if not exists idx_bp_redemption_status on backpack_redemptions(status);

-- ============================================================
-- 随机任务组
-- ============================================================
create table if not exists random_tasks (
  id uuid primary key default gen_random_uuid(),
  title text not null,
  description text not null default '',
  points_min integer not null default 0,
  points_max integer not null default 0,
  submission_type text not null default 'both',
  expiry_seconds integer null,
  is_active integer not null default 1,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists idx_random_tasks_active on random_tasks(is_active);

create table if not exists random_task_groups (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  period_type text not null default 'daily',
  is_active integer not null default 1,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists idx_rtg_active on random_task_groups(is_active);

create table if not exists random_task_group_items (
  id uuid primary key default gen_random_uuid(),
  group_id uuid not null references random_task_groups(id) on delete cascade,
  task_id uuid not null references random_tasks(id),
  sort_order integer not null default 0
);
create index if not exists idx_rtgi_group on random_task_group_items(group_id);
create index if not exists idx_rtgi_task on random_task_group_items(task_id);

create table if not exists user_surprise_tasks (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references users(id),
  group_id uuid not null references random_task_groups(id),
  task_id uuid not null references random_tasks(id),
  period_label text not null default '',
  is_completed integer not null default 0,
  submission_id uuid null references task_submissions(id),
  created_at timestamptz not null default now()
);
create unique index if not exists idx_ust_unique on user_surprise_tasks(user_id, group_id, period_label);
create index if not exists idx_ust_submission on user_surprise_tasks(submission_id);

-- 实时余额表 (由服务维护)
create table if not exists user_balance (
  user_id uuid primary key references users(id),
  available integer not null default 0
);-- ============================================================
-- 点数交易系统 D1 数据库 Schema
-- 支持：秒级过期、动态配置、FIFO扣减、贷款罚息
-- ============================================================

-- 用户表 (管理员后台创建，不对外开放注册)
CREATE TABLE IF NOT EXISTS users (
    id          TEXT PRIMARY KEY,           -- UUID
    username    TEXT NOT NULL UNIQUE,
    password_hash TEXT NOT NULL,            -- bcrypt 哈希
    role        TEXT NOT NULL DEFAULT 'user', -- 'admin' | 'user'
    display_name TEXT NOT NULL DEFAULT '',
    balance_snapshot INTEGER NOT NULL DEFAULT 0, -- 冗余快照，仅供参考；实时余额通过流水计算
    created_at  TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at  TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_users_username ON users(username);
CREATE INDEX IF NOT EXISTS idx_users_role ON users(role);

-- 系统配置表 (管理员热更新，无需重启 Worker)
CREATE TABLE IF NOT EXISTS settings (
    key         TEXT PRIMARY KEY,
    value       TEXT NOT NULL,             -- JSON 值
    description TEXT NOT NULL DEFAULT '',
    updated_at  TEXT NOT NULL DEFAULT (datetime('now'))
);

-- 初始化默认配置
INSERT OR IGNORE INTO settings (key, value, description) VALUES
('base_points_amount', '100', '每次发放的基础点数'),
('base_points_period_minutes', '10080', '基础点数发放周期(分钟), 默认10080=7天'),
('base_points_expiry_seconds', '2592000', '基础点数有效期(秒), 默认2592000=30天'),
('base_points_last_distribution', '', '上次发放基础点数的时间 ISO8601'),
('task_point_expiry_seconds', '604800', '任务点数的默认有效期(秒), 默认604800=7天'),
('loan_weekly_interest_rate', '0.05', '贷款周利率, 0.05=5%'),
('loan_penalty_multiplier', '2', '逾期罚款倍数, 默认2倍'),
('loan_penalty_days', '30', '逾期判定天数, 默认30天'),
('shop_purchase_expiry_seconds', '0', '兑换物品点数有效期(秒), 0=永久有效(无过期)'),
('allow_negative_balance', 'true', '是否允许负债(true/false)，负数时禁止购买'),
('lottery_cost', '50', '抽卡单次消耗点数'),
('lottery_pity_count', '80', '抽卡保底次数'),
('lottery_pity_item_id', '', '抽卡保底奖品ID'),
('lottery_points_expiry_seconds', '2592000', '抽卡获得点数有效期(秒)'),
('login_captcha_mode', 'none', '登录验证码模式: none / turnstile / captcha');

-- 任务定义表 (管理员创建)
CREATE TABLE IF NOT EXISTS tasks (
    id              TEXT PRIMARY KEY,
    title           TEXT NOT NULL,
    description     TEXT NOT NULL DEFAULT '',
    points_min      INTEGER NOT NULL DEFAULT 0,   -- 点数范围下限
    points_max      INTEGER NOT NULL DEFAULT 0,   -- 点数范围上限 (若相等则为固定点数)
    period_type     TEXT NOT NULL DEFAULT 'daily', -- 'daily'|'weekly'|'monthly'
    period_value    INTEGER NOT NULL DEFAULT 1,   -- 周期数值 (例如每周2次)
    submission_type TEXT NOT NULL DEFAULT 'both',  -- 'image'|'text'|'both'
    is_active       INTEGER NOT NULL DEFAULT 1,   -- 0/1
    expiry_seconds  INTEGER NULL,                 -- NULL=使用全局默认; 非NULL=自定义有效期
    created_at      TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at      TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_tasks_active ON tasks(is_active);

-- 任务提交记录表
CREATE TABLE IF NOT EXISTS task_submissions (
    id              TEXT PRIMARY KEY,
    task_id         TEXT NOT NULL,
    user_id         TEXT NOT NULL REFERENCES users(id),
    content_text    TEXT NOT NULL DEFAULT '',
    image_url       TEXT NOT NULL DEFAULT '',     -- R2 图片URL
    status          TEXT NOT NULL DEFAULT 'pending', -- 'pending'|'approved'|'rejected'
    admin_remark    TEXT NOT NULL DEFAULT '',
    awarded_points  INTEGER NULL,                -- 管理员审核后给予的点数
    reviewed_by     TEXT NULL REFERENCES users(id),
    reviewed_at     TEXT NULL,
    period_label    TEXT NOT NULL DEFAULT '',     -- 周期标识如 '2026-W21'
    created_at      TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_submissions_user ON task_submissions(user_id);
CREATE INDEX IF NOT EXISTS idx_submissions_task ON task_submissions(task_id);
CREATE INDEX IF NOT EXISTS idx_submissions_status ON task_submissions(status);
CREATE INDEX IF NOT EXISTS idx_submissions_period ON task_submissions(user_id, task_id, period_label);

-- 点数流水表 (核心：每笔收入记录有效期，支持秒级FIFO)
CREATE TABLE IF NOT EXISTS point_ledger (
    id              TEXT PRIMARY KEY,
    user_id         TEXT NOT NULL REFERENCES users(id),
    amount          INTEGER NOT NULL,             -- 正数=获得, 负数=消耗
    balance_after   INTEGER NOT NULL,             -- 变动后快照余额
    type            TEXT NOT NULL,                -- 'base'|'task'|'admin_adjust'|'shop_purchase'|'loan_repay'|'loan_penalty'|'expiry'
    ref_id          TEXT NOT NULL DEFAULT '',     -- 关联ID (submission_id / purchase_id / loan_id)
    description     TEXT NOT NULL DEFAULT '',
    expires_at      TEXT NULL,                   -- 精确到秒的过期时间 (NULL=不过期)
    created_at      TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_ledger_user ON point_ledger(user_id);
CREATE INDEX IF NOT EXISTS idx_ledger_expires ON point_ledger(expires_at);
CREATE INDEX IF NOT EXISTS idx_ledger_type ON point_ledger(type);
-- 复合索引加速 FIFO 查询 (查用户未过期的正数流水)
CREATE INDEX IF NOT EXISTS idx_ledger_fifo ON point_ledger(user_id, expires_at, amount);
-- LEFT JOIN 扣减聚合 (d.user_id + d.amount<0 + d.ref_id)
CREATE INDEX IF NOT EXISTS idx_ledger_neg_ref ON point_ledger(user_id, amount, ref_id);

-- 商品表 (管理员配置可兑换物品)
CREATE TABLE IF NOT EXISTS shop_items (
    id              TEXT PRIMARY KEY,
    name            TEXT NOT NULL,
    description     TEXT NOT NULL DEFAULT '',
    image_url       TEXT NOT NULL DEFAULT '',
    points_required INTEGER NOT NULL DEFAULT 0,
    stock           INTEGER NOT NULL DEFAULT -1,  -- -1=无限库存
    is_active       INTEGER NOT NULL DEFAULT 1,
    created_at      TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at      TEXT NOT NULL DEFAULT (datetime('now'))
);

-- 兑换订单表
CREATE TABLE IF NOT EXISTS redemption_orders (
    id              TEXT PRIMARY KEY,
    user_id         TEXT NOT NULL REFERENCES users(id),
    item_id         TEXT NOT NULL REFERENCES shop_items(id),
    content_text    TEXT NOT NULL DEFAULT '',
    image_url       TEXT NOT NULL DEFAULT '',     -- 兑换时用户上传的图片
    status          TEXT NOT NULL DEFAULT 'pending', -- 'pending'|'approved'|'rejected'
    points_spent    INTEGER NOT NULL DEFAULT 0,
    admin_remark    TEXT NOT NULL DEFAULT '',
    reviewed_by     TEXT NULL REFERENCES users(id),
    reviewed_at     TEXT NULL,
    created_at      TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_redemption_user ON redemption_orders(user_id);
CREATE INDEX IF NOT EXISTS idx_redemption_status ON redemption_orders(status);

-- 贷款表
CREATE TABLE IF NOT EXISTS loans (
    id                  TEXT PRIMARY KEY,
    user_id             TEXT NOT NULL REFERENCES users(id),
    principal           INTEGER NOT NULL,         -- 借款本金 (点数)
    remaining           INTEGER NOT NULL,         -- 剩余未还 (含累计利息)
    weekly_interest_rate REAL NOT NULL DEFAULT 0.05,
    status              TEXT NOT NULL DEFAULT 'active', -- 'active'|'repaid'|'defaulted'
    borrowed_at         TEXT NOT NULL DEFAULT (datetime('now')),
    last_interest_at    TEXT NULL,                -- 上次计息时间
    repaid_at           TEXT NULL,
    created_at          TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_loans_user ON loans(user_id);
CREATE INDEX IF NOT EXISTS idx_loans_status ON loans(status);
-- cron 贷款计息 & 逾期
CREATE INDEX IF NOT EXISTS idx_loans_cron ON loans(status, last_interest_at);
CREATE INDEX IF NOT EXISTS idx_loans_default ON loans(status, borrowed_at);

-- 还款记录表
CREATE TABLE IF NOT EXISTS loan_repayments (
    id          TEXT PRIMARY KEY,
    loan_id     TEXT NOT NULL REFERENCES loans(id),
    user_id     TEXT NOT NULL REFERENCES users(id),
    amount      INTEGER NOT NULL,
    created_at  TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_repay_loan ON loan_repayments(loan_id);

-- 管理员操作日志
CREATE TABLE IF NOT EXISTS admin_logs (
    id          TEXT PRIMARY KEY,
    admin_id    TEXT NOT NULL REFERENCES users(id),
    action      TEXT NOT NULL,
    target_type TEXT NOT NULL DEFAULT '',
    target_id   TEXT NOT NULL DEFAULT '',
    detail      TEXT NOT NULL DEFAULT '',
    created_at  TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_admin_logs_admin ON admin_logs(admin_id);
CREATE INDEX IF NOT EXISTS idx_admin_logs_created ON admin_logs(created_at);

-- ============================================================
-- 抽奖奖品表
-- ============================================================
CREATE TABLE IF NOT EXISTS lottery_items (
    id              TEXT PRIMARY KEY,
    name            TEXT NOT NULL,
    description     TEXT NOT NULL DEFAULT '',
    image_url       TEXT NOT NULL DEFAULT '',
    icon            TEXT NOT NULL DEFAULT '🎁',    -- emoji 图标
    rarity          TEXT NOT NULL DEFAULT 'common', -- 'common'|'rare'|'epic'|'legendary'
    probability     REAL NOT NULL DEFAULT 0.05,    -- 概率 0.0 ~ 1.0
    reward_type     TEXT NOT NULL DEFAULT 'item',  -- 'item'|'points'
    points_amount   INTEGER NOT NULL DEFAULT 0,
    is_active       INTEGER NOT NULL DEFAULT 1,
    sort_order      INTEGER NOT NULL DEFAULT 0,
    created_at      TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at      TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_lottery_items_active ON lottery_items(is_active, sort_order);

-- 抽奖系统全局配置 (通过 settings 表即可, 这里记录抽奖相关设置)
-- 需要手动或通过API写入:
-- lottery_cost: 单次抽卡消耗点数, 默认 50
-- lottery_pity_count: N抽保底次数, 默认 80
-- lottery_pity_item_id: 保底奖品ID

-- 用户抽奖记录表
CREATE TABLE IF NOT EXISTS lottery_draws (
    id              TEXT PRIMARY KEY,
    user_id         TEXT NOT NULL REFERENCES users(id),
    item_id         TEXT NOT NULL,
    points_spent    INTEGER NOT NULL,
    is_pity         INTEGER NOT NULL DEFAULT 0,   -- 是否为保底触发
    draw_index      INTEGER NOT NULL DEFAULT 0,   -- 当前保底计数中的第几次
    created_at      TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_lottery_draws_user ON lottery_draws(user_id);
CREATE INDEX IF NOT EXISTS idx_lottery_draws_time ON lottery_draws(user_id, created_at);
-- 保底进度查询 (user_id + is_pity + created_at)
CREATE INDEX IF NOT EXISTS idx_lottery_draws_pity ON lottery_draws(user_id, is_pity, created_at);
-- 物品统计 GROUP BY item_id
CREATE INDEX IF NOT EXISTS idx_lottery_draws_item ON lottery_draws(item_id);

-- 用户抽卡状态 (保底计数等)
CREATE TABLE IF NOT EXISTS lottery_state (
    user_id         TEXT PRIMARY KEY REFERENCES users(id),
    pity_counter    INTEGER NOT NULL DEFAULT 0,
    total_draws     INTEGER NOT NULL DEFAULT 0,
    last_draw_at    TEXT NULL,
    updated_at      TEXT NOT NULL DEFAULT (datetime('now'))
);

-- 用户背包表
CREATE TABLE IF NOT EXISTS user_backpack (
    id              TEXT PRIMARY KEY,
    user_id         TEXT NOT NULL REFERENCES users(id),
    item_id         TEXT NOT NULL REFERENCES lottery_items(id),
    item_name       TEXT NOT NULL DEFAULT '',
    item_icon       TEXT NOT NULL DEFAULT '🎁',
    rarity          TEXT NOT NULL DEFAULT 'common',
    quantity        INTEGER NOT NULL DEFAULT 1,
    is_redeemed     INTEGER NOT NULL DEFAULT 0,   -- 是否已兑换
    source_draw_id  TEXT NULL REFERENCES lottery_draws(id),
    created_at      TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_backpack_user ON user_backpack(user_id);
CREATE INDEX IF NOT EXISTS idx_backpack_redeemed ON user_backpack(user_id, is_redeemed);
-- 抽卡奖励去重 (user_id + item_id + is_redeemed)
CREATE INDEX IF NOT EXISTS idx_backpack_dedup ON user_backpack(user_id, item_id, is_redeemed);

-- 背包物品兑换申请表 (从背包中兑换需要上传图片/文字)
CREATE TABLE IF NOT EXISTS backpack_redemptions (
    id              TEXT PRIMARY KEY,
    user_id         TEXT NOT NULL REFERENCES users(id),
    backpack_id     TEXT NOT NULL REFERENCES user_backpack(id),
    content_text    TEXT NOT NULL DEFAULT '',
    image_url       TEXT NOT NULL DEFAULT '',
    status          TEXT NOT NULL DEFAULT 'pending',
    admin_remark    TEXT NOT NULL DEFAULT '',
    reviewed_by     TEXT NULL REFERENCES users(id),
    reviewed_at     TEXT NULL,
    created_at      TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_bp_redemption_user ON backpack_redemptions(user_id);
CREATE INDEX IF NOT EXISTS idx_bp_redemption_status ON backpack_redemptions(status);

-- ============================================================
-- 随机任务组
-- ============================================================
CREATE TABLE IF NOT EXISTS random_task_groups (
    id              TEXT PRIMARY KEY,
    name            TEXT NOT NULL,
    period_type     TEXT NOT NULL DEFAULT 'daily', -- 'daily'|'weekly'|'monthly'
    is_active       INTEGER NOT NULL DEFAULT 1,
    created_at      TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at      TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_rtg_active ON random_task_groups(is_active);

-- 随机任务组内的任务
CREATE TABLE IF NOT EXISTS random_task_group_items (
    id              TEXT PRIMARY KEY,
    group_id        TEXT NOT NULL REFERENCES random_task_groups(id) ON DELETE CASCADE,
    task_id         TEXT NOT NULL REFERENCES tasks(id),
    sort_order      INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_rtgi_group ON random_task_group_items(group_id);
CREATE INDEX IF NOT EXISTS idx_rtgi_task ON random_task_group_items(task_id);

-- 用户领取的惊喜任务
CREATE TABLE IF NOT EXISTS user_surprise_tasks (
    id              TEXT PRIMARY KEY,
    user_id         TEXT NOT NULL REFERENCES users(id),
    group_id        TEXT NOT NULL REFERENCES random_task_groups(id),
    task_id         TEXT NOT NULL REFERENCES tasks(id),
    period_label    TEXT NOT NULL DEFAULT '',
    is_completed    INTEGER NOT NULL DEFAULT 0,
    submission_id   TEXT NULL REFERENCES task_submissions(id),
    created_at      TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_ust_unique ON user_surprise_tasks(user_id, group_id, period_label);
-- 审核回退 (submission_id)
CREATE INDEX IF NOT EXISTS idx_ust_submission ON user_surprise_tasks(submission_id);
