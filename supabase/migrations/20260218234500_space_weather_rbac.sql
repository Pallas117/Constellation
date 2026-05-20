-- Harden space weather schema with RLS + explicit grants

-- Enable RLS
alter table if exists public.sw_raw_samples enable row level security;
alter table if exists public.sw_clean_samples enable row level security;
alter table if exists public.sw_nowcast_5s enable row level security;
alter table if exists public.mms_raw_fgm enable row level security;
alter table if exists public.mms_raw_mec enable row level security;
alter table if exists public.mms_recon_vectors_5s enable row level security;
alter table if exists public.aurora_healpix_maps enable row level security;
alter table if exists public.source_health enable row level security;

-- Remove permissive grants first
revoke all on table public.sw_raw_samples from anon, authenticated;
revoke all on table public.sw_clean_samples from anon, authenticated;
revoke all on table public.sw_nowcast_5s from anon, authenticated;
revoke all on table public.mms_raw_fgm from anon, authenticated;
revoke all on table public.mms_raw_mec from anon, authenticated;
revoke all on table public.mms_recon_vectors_5s from anon, authenticated;
revoke all on table public.aurora_healpix_maps from anon, authenticated;
revoke all on table public.source_health from anon, authenticated;

-- Service role full access for ingestion and maintenance
grant select, insert, update, delete on table public.sw_raw_samples to service_role;
grant select, insert, update, delete on table public.sw_clean_samples to service_role;
grant select, insert, update, delete on table public.sw_nowcast_5s to service_role;
grant select, insert, update, delete on table public.mms_raw_fgm to service_role;
grant select, insert, update, delete on table public.mms_raw_mec to service_role;
grant select, insert, update, delete on table public.mms_recon_vectors_5s to service_role;
grant select, insert, update, delete on table public.aurora_healpix_maps to service_role;
grant select, insert, update, delete on table public.source_health to service_role;

-- Authenticated users may only read published outputs
grant select on table public.sw_nowcast_5s to authenticated;
grant select on table public.mms_recon_vectors_5s to authenticated;
grant select on table public.aurora_healpix_maps to authenticated;
grant select on table public.source_health to authenticated;

-- Drop existing policies (idempotent)
drop policy if exists "authenticated_read_sw_nowcast_5s" on public.sw_nowcast_5s;
drop policy if exists "authenticated_read_mms_recon_vectors_5s" on public.mms_recon_vectors_5s;
drop policy if exists "authenticated_read_aurora_healpix_maps" on public.aurora_healpix_maps;
drop policy if exists "authenticated_read_source_health" on public.source_health;

-- Read-only policies for authenticated consumers
create policy "authenticated_read_sw_nowcast_5s"
  on public.sw_nowcast_5s
  for select
  to authenticated
  using (true);

create policy "authenticated_read_mms_recon_vectors_5s"
  on public.mms_recon_vectors_5s
  for select
  to authenticated
  using (true);

create policy "authenticated_read_aurora_healpix_maps"
  on public.aurora_healpix_maps
  for select
  to authenticated
  using (true);

create policy "authenticated_read_source_health"
  on public.source_health
  for select
  to authenticated
  using (true);

-- Keep raw/clean tables locked to service role by providing no authenticated policies.

-- Tighten function execution rights
revoke all on function public.ingest_raw_sample(text, text, timestamptz, jsonb) from public, anon, authenticated;
revoke all on function public.clean_raw_window(timestamptz, timestamptz) from public, anon, authenticated;
revoke all on function public.generate_nowcast_5s(timestamptz, timestamptz) from public, anon, authenticated;
revoke all on function public.compute_mms_recon_vectors_5s(timestamptz, timestamptz) from public, anon, authenticated;
revoke all on function public.build_aurora_healpix_map(timestamptz, integer) from public, anon, authenticated;
revoke all on function public.get_feed_5s(interval, integer) from public, anon;
revoke all on function public.get_mms_recon_feed(interval, integer) from public, anon;

grant execute on function public.ingest_raw_sample(text, text, timestamptz, jsonb) to service_role;
grant execute on function public.clean_raw_window(timestamptz, timestamptz) to service_role;
grant execute on function public.generate_nowcast_5s(timestamptz, timestamptz) to service_role;
grant execute on function public.compute_mms_recon_vectors_5s(timestamptz, timestamptz) to service_role;
grant execute on function public.build_aurora_healpix_map(timestamptz, integer) to service_role;
grant execute on function public.get_feed_5s(interval, integer) to authenticated, service_role;
grant execute on function public.get_mms_recon_feed(interval, integer) to authenticated, service_role;
