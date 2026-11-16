-- 仅用于从无角色版本升级，停止所有旧版实例后执行一次。
-- 在同一连接中先设置 search_path 到目标 schema，再显式选定一个启用账号：
-- SET toy.admin_superadmin_id = '已确认的管理员 ID';
-- 新建数据库直接使用导出的 schema，不执行此迁移。
BEGIN;
LOCK TABLE toy_admin_auth_state, toy_admin_accounts, toy_admin_sessions IN ACCESS EXCLUSIVE MODE;

ALTER TABLE toy_admin_accounts ADD COLUMN role TEXT NOT NULL DEFAULT 'viewer';

DO $$
DECLARE
  selected_id TEXT := current_setting('toy.admin_superadmin_id', true);
BEGIN
  IF EXISTS (SELECT 1 FROM toy_admin_accounts) THEN
    IF selected_id IS NULL OR selected_id = '' THEN
      RAISE EXCEPTION '必须先通过 toy.admin_superadmin_id 显式指定一个启用的超级管理员账号';
    END IF;
    UPDATE toy_admin_accounts SET role = 'superadmin'
      WHERE admin_id = selected_id AND enabled = TRUE;
    IF NOT FOUND THEN
      RAISE EXCEPTION '所选超级管理员账号不存在或未启用';
    END IF;
  END IF;
END $$;

ALTER TABLE toy_admin_accounts ALTER COLUMN role DROP DEFAULT;
UPDATE toy_admin_accounts SET security_version = security_version + 1, updated_at = CURRENT_TIMESTAMP;
UPDATE toy_admin_sessions SET revoked_at = CURRENT_TIMESTAMP WHERE revoked_at IS NULL;
COMMIT;
