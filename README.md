# 点数交易系统

基于 Cloudflare 生态 (Workers + Supabase + R2 + Pages) 构建的完整点数交易系统。

## 功能特性

- ✅ **基础点数发放** - 周期可配（分钟级），点数有效期秒级精准
- ✅ **任务系统** - 管理员创建任务，用户提交文字/图片，审核后获得点数
- ✅ **商品兑换** - 点数兑换商品，管理员审核订单
- ✅ **贷款系统** - 用户借贷，周利率可调，逾期双倍罚息
- ✅ **FIFO 点数扣减** - 优先消耗即将过期的点数
- ✅ **秒级过期** - 实时查询余额，过期点数即时失效
- ✅ **负数余额** - 余额为负禁止兑换，只能做任务或还贷
- ✅ **管理员后台** - 完整后台管理界面
- ✅ **动态配置** - 所有参数后台热更新，无需重启
- ✅ **动静分离** - 前端静态资源部署至 Cloudflare Pages / Worker Assets，全 CDN 缓存

## 快速开始

### 1. 安装依赖

```bash
npm install
```

### 2. 创建 Supabase 项目并初始化数据库

- 在 Supabase 创建项目
- 打开 SQL Editor，执行 `schema.sql`
- 获取 `SUPABASE_URL` 与 `SUPABASE_KEY`，写入 `wrangler.toml` 的 `[vars]`

### 3. 创建 R2 存储桶

```bash
npx wrangler r2 bucket create points-images
```

### 4. 本地开发

```bash
npm run dev
```

### 5. 部署

```bash
npm run deploy
```

## 项目结构
