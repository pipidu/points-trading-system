-- 种子数据: 创建默认管理员 & 示例任务 & 示例商品 (PostgreSQL)
-- 密码需在应用层通过 bcrypt 生成后替换 placeholder
INSERT INTO users (id, username, password_hash, role, display_name)
VALUES (gen_random_uuid(), 'admin', '$2a$10$placeholder_hash_change_me', 'admin', '系统管理员')
ON CONFLICT (username) DO NOTHING;
