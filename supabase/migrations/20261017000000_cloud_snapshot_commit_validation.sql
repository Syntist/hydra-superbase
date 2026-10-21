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
