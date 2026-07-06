-- SPEC-00 §5 改写版（2026-07-04）：fail-closed 建表
-- 原版差异：删除 anon allow_all 策略；GRANT 收口到 authenticated（无 DELETE）+ service_role
create table if not exists thoughts (
  id uuid default gen_random_uuid() primary key,
  content text not null,
  created_at timestamptz default now()
);
-- 冗余保险：项目已开 automatic RLS，此句幂等无害，留着防将来开关变动
alter table thoughts enable row level security;
-- 权限层：能力上限（INV-2：authenticated 无 DELETE，捕获系统不给破坏性操作）
grant select,
  insert,
  update on thoughts to authenticated;
grant all on thoughts to service_role;
-- edge functions 走此角色
-- 策略层：放行条件（注册已关，authenticated ≡ 本人）
create policy "owner_only" on thoughts for all to authenticated using (true) with check (true);