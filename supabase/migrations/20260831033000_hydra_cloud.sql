create table if not exists public.hydra_save_artifacts (
  id uuid primary key,
  user_id text not null,
  shop text not null,
  object_id text not null,
  path text not null unique,
  artifact_length_in_bytes bigint not null,
  label text,
  created_at timestamptz not null default now()
);
create table if not exists public.hydra_achievement_sync (
  user_id text not null,
  shop text not null,
  object_id text not null,
  achievements jsonb not null,
  updated_at timestamptz not null default now(),
  primary key (user_id, shop, object_id)
);
create table if not exists public.hydra_cloud_snapshots (
  id uuid primary key,
  logical_id uuid not null,
  user_id text not null,
  shop text not null,
  object_id text not null,
  version integer not null check (version > 0),
  status text not null check (status in ('pending', 'active')),
  aggregate_hash text not null check (aggregate_hash ~ '^[a-f0-9]{64}$'),
  file_count integer not null check (file_count >= 0),
  total_size_bytes bigint not null check (total_size_bytes >= 0),
  custom_path_raw_paths jsonb not null default '[]'::jsonb,
  variants jsonb not null default '[]'::jsonb,
  files jsonb not null default '[]'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create table if not exists public.hydra_user_links (
  hydra_user_id text primary key,
  supabase_user_id uuid not null unique references auth.users(id) on delete cascade,
  supabase_email text not null unique,
  hydra_email text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create unique index if not exists hydra_cloud_one_active_snapshot
  on public.hydra_cloud_snapshots (user_id, shop, object_id)
  where status = 'active';
create index if not exists hydra_cloud_pending_snapshot_owner
  on public.hydra_cloud_snapshots (id, user_id)
  where status = 'pending';
alter table public.hydra_save_artifacts enable row level security;
alter table public.hydra_achievement_sync enable row level security;
alter table public.hydra_cloud_snapshots enable row level security;
alter table public.hydra_user_links enable row level security;
drop policy if exists "hydra saves by user" on public.hydra_save_artifacts;
drop policy if exists "hydra achievements by user" on public.hydra_achievement_sync;
drop policy if exists "hydra cloud snapshots by user" on public.hydra_cloud_snapshots;
drop policy if exists "hydra storage read" on storage.objects;
drop policy if exists "hydra storage write" on storage.objects;
drop policy if exists "hydra storage delete" on storage.objects;
drop policy if exists "hydra v2 storage read" on storage.objects;
drop policy if exists "hydra v2 storage write" on storage.objects;
drop policy if exists "hydra v2 storage update" on storage.objects;
drop policy if exists "hydra v2 storage delete" on storage.objects;
create policy "hydra saves by user" on public.hydra_save_artifacts for all using (user_id = auth.uid()::text) with check (user_id = auth.uid()::text);
create policy "hydra achievements by user" on public.hydra_achievement_sync for all using (user_id = auth.uid()::text) with check (user_id = auth.uid()::text);
create policy "hydra cloud snapshots by user" on public.hydra_cloud_snapshots for all using (user_id = auth.uid()::text) with check (user_id = auth.uid()::text);
insert into storage.buckets (id, name, public) values ('hydra-saves', 'hydra-saves', false) on conflict (id) do nothing;
insert into storage.buckets (id, name, public) values ('hydra-cloud-v2', 'hydra-cloud-v2', false) on conflict (id) do nothing;
create policy "hydra storage read" on storage.objects for select using (bucket_id = 'hydra-saves' and (storage.foldername(name))[1] = auth.uid()::text);
create policy "hydra storage write" on storage.objects for insert with check (bucket_id = 'hydra-saves' and (storage.foldername(name))[1] = auth.uid()::text);
create policy "hydra storage delete" on storage.objects for delete using (bucket_id = 'hydra-saves' and (storage.foldername(name))[1] = auth.uid()::text);
create policy "hydra v2 storage read" on storage.objects for select using (bucket_id = 'hydra-cloud-v2' and (storage.foldername(name))[1] = auth.uid()::text);
create policy "hydra v2 storage write" on storage.objects for insert with check (bucket_id = 'hydra-cloud-v2' and (storage.foldername(name))[1] = auth.uid()::text);
create policy "hydra v2 storage update" on storage.objects for update using (bucket_id = 'hydra-cloud-v2' and (storage.foldername(name))[1] = auth.uid()::text) with check (bucket_id = 'hydra-cloud-v2' and (storage.foldername(name))[1] = auth.uid()::text);
create policy "hydra v2 storage delete" on storage.objects for delete using (bucket_id = 'hydra-cloud-v2' and (storage.foldername(name))[1] = auth.uid()::text);

drop function if exists public.hydra_commit_cloud_snapshot(uuid, text);
create or replace function public.hydra_commit_cloud_snapshot(pending_id uuid)
returns table (
  snapshot_id uuid,
  snapshot_version integer,
  snapshot_file_count integer,
  snapshot_total_size_bytes bigint,
  snapshot_aggregate_hash text
)
language plpgsql
as $$
declare
  pending public.hydra_cloud_snapshots%rowtype;
  active_version integer;
  owner_id text := auth.uid()::text;
begin
  if owner_id is null then
    raise exception 'Supabase authentication required';
  end if;
  select * into pending
  from public.hydra_cloud_snapshots
  where id = pending_id and user_id = owner_id
  for update;

  if not found then
    raise exception 'Pending Cloud Save snapshot not found';
  end if;

  if pending.status = 'active' then
    return query select
      pending.logical_id,
      pending.version,
      pending.file_count,
      pending.total_size_bytes,
      pending.aggregate_hash;
    return;
  end if;

  -- Serialize even the first commit, where no active row exists to lock.
  perform pg_advisory_xact_lock(hashtextextended(
    owner_id || ':' || pending.shop || ':' || pending.object_id, 0
  ));

  if exists (
    select 1 from jsonb_array_elements(pending.files) as file
    where not exists (
      select 1 from storage.objects as object
      where object.bucket_id = 'hydra-cloud-v2'
        and object.name = owner_id || '/v2/' || (file->>'hash')
        and (object.metadata->>'size')::bigint = (file->>'sizeBytes')::bigint
    )
  ) then
    raise exception 'game/cloud-save-pending-snapshot-incomplete';
  end if;

  select version into active_version
  from public.hydra_cloud_snapshots
  where user_id = owner_id
    and shop = pending.shop
    and object_id = pending.object_id
    and status = 'active'
  for update;

  if coalesce(active_version, 0) <> pending.version - 1 then
    raise exception 'cloud_save_snapshot_version_conflict';
  end if;

  delete from public.hydra_cloud_snapshots
  where user_id = owner_id
    and shop = pending.shop
    and object_id = pending.object_id
    and status = 'active';

  update public.hydra_cloud_snapshots
  set status = 'active', updated_at = now()
  where id = pending_id;

  return query select
    pending.logical_id,
    pending.version,
    pending.file_count,
    pending.total_size_bytes,
    pending.aggregate_hash;
end;
$$;
revoke all on function public.hydra_commit_cloud_snapshot(uuid) from public;
revoke all on function public.hydra_commit_cloud_snapshot(uuid) from anon;
grant execute on function public.hydra_commit_cloud_snapshot(uuid) to authenticated;
