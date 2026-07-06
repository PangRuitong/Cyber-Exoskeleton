-- SPEC-00 §5 v1.1 修复：清 default privileges 遗留权限
alter default privileges for role postgres in schema public revoke all on tables
from anon,
    authenticated;
revoke all on thoughts
from anon;
revoke references,
trigger,
truncate on thoughts
from authenticated;
-- 验证（anon 应零行，authenticated 应恰好 3 行）
select grantee,
    privilege_type
from information_schema.role_table_grants
where table_schema = 'public'
    and table_name = 'thoughts'
    and grantee in ('anon', 'authenticated')
order by grantee,
    privilege_type;