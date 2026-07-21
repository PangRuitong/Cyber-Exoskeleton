-- Control/14 A-3: the event trigger runs as its postgres owner; no Data API
-- role needs direct EXECUTE permission on this SECURITY DEFINER function.
revoke execute on function public.rls_auto_enable()
from public, anon, authenticated;

-- Control/14 A-2: thoughts is internal-only. All application access goes
-- through service_role Edge Functions or explicitly scoped internal RPCs.
revoke select, insert, update, delete on table public.thoughts
from authenticated, anon;

drop policy if exists owner_only on public.thoughts;
