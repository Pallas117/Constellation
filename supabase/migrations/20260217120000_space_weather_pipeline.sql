-- Space weather full-physics pipeline schema

create table if not exists public.sw_raw_samples (
  id uuid primary key default gen_random_uuid(),
  source text not null,
  stream text not null,
  observed_at timestamptz not null,
  payload jsonb not null,
  inserted_at timestamptz not null default now(),
  unique (source, stream, observed_at)
);

create index if not exists idx_sw_raw_samples_stream_time
  on public.sw_raw_samples (stream, observed_at desc);

create table if not exists public.sw_clean_samples (
  id uuid primary key default gen_random_uuid(),
  source text not null,
  stream text not null,
  observed_at timestamptz not null,
  point jsonb not null,
  quality_flags jsonb not null default '{}'::jsonb,
  uncertainty jsonb not null default '{}'::jsonb,
  inserted_at timestamptz not null default now(),
  unique (source, stream, observed_at)
);

create index if not exists idx_sw_clean_samples_stream_time
  on public.sw_clean_samples (stream, observed_at desc);

create table if not exists public.sw_nowcast_5s (
  timestamp timestamptz primary key,
  point jsonb not null,
  quality_flags jsonb not null default '{}'::jsonb,
  uncertainty jsonb not null default '{}'::jsonb,
  inserted_at timestamptz not null default now()
);

create index if not exists idx_sw_nowcast_5s_inserted_at
  on public.sw_nowcast_5s (inserted_at desc);

create table if not exists public.mms_raw_fgm (
  id uuid primary key default gen_random_uuid(),
  sc_id text not null,
  observed_at timestamptz not null,
  payload jsonb not null,
  inserted_at timestamptz not null default now(),
  unique (sc_id, observed_at)
);

create table if not exists public.mms_raw_mec (
  id uuid primary key default gen_random_uuid(),
  sc_id text not null,
  observed_at timestamptz not null,
  payload jsonb not null,
  inserted_at timestamptz not null default now(),
  unique (sc_id, observed_at)
);

create table if not exists public.mms_recon_vectors_5s (
  timestamp timestamptz primary key,
  vector jsonb not null,
  quality jsonb not null default '{}'::jsonb,
  inserted_at timestamptz not null default now()
);

create table if not exists public.aurora_healpix_maps (
  timestamp timestamptz not null,
  nside integer not null,
  map jsonb not null,
  harmonics jsonb not null,
  inserted_at timestamptz not null default now(),
  primary key (timestamp, nside)
);

create table if not exists public.source_health (
  source text primary key,
  last_seen timestamptz,
  latency_seconds double precision,
  healthy boolean not null default false,
  message text,
  updated_at timestamptz not null default now()
);

create or replace function public.ingest_raw_sample(
  source text,
  stream text,
  observed_at timestamptz,
  payload jsonb
)
returns void
language plpgsql
security definer
as $$
begin
  insert into public.sw_raw_samples (source, stream, observed_at, payload)
  values (source, stream, observed_at, payload)
  on conflict (source, stream, observed_at) do update
    set payload = excluded.payload,
        inserted_at = now();
end;
$$;

create or replace function public.clean_raw_window(
  start_ts timestamptz,
  end_ts timestamptz
)
returns integer
language plpgsql
security definer
as $$
declare
  cleaned_count integer;
begin
  with candidate as (
    select
      source,
      stream,
      observed_at,
      payload,
      nullif((payload #>> '{solarWind,speed}')::double precision, 'NaN'::double precision) as speed,
      nullif((payload #>> '{solarWind,density}')::double precision, 'NaN'::double precision) as density,
      nullif((payload #>> '{magneticField,z}')::double precision, 'NaN'::double precision) as bz
    from public.sw_raw_samples
    where observed_at between start_ts and end_ts
      and stream = 'canonical'
  ),
  bounded as (
    select
      source,
      stream,
      observed_at,
      payload,
      case when speed between 200 and 2000 then speed else null end as speed,
      case when density between 0 and 500 then density else null end as density,
      case when bz between -200 and 200 then bz else null end as bz
    from candidate
  ),
  stats as (
    select
      percentile_cont(0.5) within group (order by speed) as med_speed,
      percentile_cont(0.5) within group (order by density) as med_density,
      percentile_cont(0.5) within group (order by bz) as med_bz
    from bounded
  ),
  normalized as (
    select
      b.source,
      b.stream,
      b.observed_at,
      jsonb_set(
        jsonb_set(
          jsonb_set(
            b.payload,
            '{solarWind,speed}',
            to_jsonb(coalesce(b.speed, s.med_speed, 400))
          ),
          '{solarWind,density}',
          to_jsonb(coalesce(b.density, s.med_density, 5))
        ),
        '{magneticField,z}',
        to_jsonb(coalesce(b.bz, s.med_bz, 0))
      ) as point,
      jsonb_build_object(
        'outlier', (b.speed is null or b.density is null or b.bz is null),
        'stale', false,
        'interpolated', false,
        'extrapolated', false,
        'lowConfidence', (b.speed is null or b.bz is null)
      ) as quality_flags,
      jsonb_build_object(
        'speed', jsonb_build_object('sigma', 8),
        'density', jsonb_build_object('sigma', 0.6),
        'bz', jsonb_build_object('sigma', 0.8)
      ) as uncertainty
    from bounded b
    cross join stats s
  )
  insert into public.sw_clean_samples (source, stream, observed_at, point, quality_flags, uncertainty)
  select source, stream, observed_at, point, quality_flags, uncertainty
  from normalized
  on conflict (source, stream, observed_at) do update
    set point = excluded.point,
        quality_flags = excluded.quality_flags,
        uncertainty = excluded.uncertainty,
        inserted_at = now();

  get diagnostics cleaned_count = row_count;
  return cleaned_count;
end;
$$;

create or replace function public.generate_nowcast_5s(
  start_ts timestamptz,
  end_ts timestamptz
)
returns integer
language plpgsql
security definer
as $$
declare
  inserted_count integer;
begin
  with timeline as (
    select generate_series(date_trunc('second', start_ts), date_trunc('second', end_ts), interval '5 seconds') as ts
  ),
  nearest as (
    select
      t.ts,
      c.point,
      c.quality_flags,
      c.uncertainty,
      c.observed_at,
      row_number() over (
        partition by t.ts
        order by abs(extract(epoch from (t.ts - c.observed_at)))
      ) as rn
    from timeline t
    join public.sw_clean_samples c
      on c.stream = 'canonical'
     and c.observed_at between start_ts - interval '5 minutes' and end_ts + interval '5 minutes'
  ),
  selected as (
    select
      ts,
      point,
      quality_flags,
      uncertainty,
      observed_at
    from nearest
    where rn = 1
  )
  insert into public.sw_nowcast_5s (timestamp, point, quality_flags, uncertainty)
  select
    ts,
    jsonb_set(point, '{timestamp}', to_jsonb(ts::text)),
    case
      when abs(extract(epoch from (ts - observed_at))) > 60
      then quality_flags || jsonb_build_object('stale', true, 'interpolated', true)
      else quality_flags
    end,
    uncertainty
  from selected
  on conflict (timestamp) do update
    set point = excluded.point,
        quality_flags = excluded.quality_flags,
        uncertainty = excluded.uncertainty,
        inserted_at = now();

  get diagnostics inserted_count = row_count;
  return inserted_count;
end;
$$;

create or replace function public.compute_mms_recon_vectors_5s(
  start_ts timestamptz,
  end_ts timestamptz
)
returns integer
language plpgsql
security definer
as $$
declare
  inserted_count integer;
begin
  with candidate as (
    select observed_at, payload
    from public.sw_raw_samples
    where stream = 'mms_recon'
      and observed_at between start_ts and end_ts
  ),
  timeline as (
    select generate_series(date_trunc('second', start_ts), date_trunc('second', end_ts), interval '5 seconds') as ts
  ),
  nearest as (
    select
      t.ts,
      c.payload,
      c.observed_at,
      row_number() over (
        partition by t.ts
        order by abs(extract(epoch from (t.ts - c.observed_at)))
      ) as rn
    from timeline t
    join candidate c on true
  )
  insert into public.mms_recon_vectors_5s (timestamp, vector, quality)
  select
    ts,
    payload,
    coalesce(payload -> 'quality', '{}'::jsonb)
  from nearest
  where rn = 1
  on conflict (timestamp) do update
    set vector = excluded.vector,
        quality = excluded.quality,
        inserted_at = now();

  get diagnostics inserted_count = row_count;
  return inserted_count;
end;
$$;

create or replace function public.build_aurora_healpix_map(
  ts timestamptz,
  nside integer default 64
)
returns void
language plpgsql
security definer
as $$
declare
  latest_point jsonb;
  map_payload jsonb;
  harmonics_payload jsonb;
begin
  select point into latest_point
  from public.sw_nowcast_5s
  where timestamp <= $1
  order by timestamp desc
  limit 1;

  if latest_point is null then
    return;
  end if;

  map_payload := jsonb_build_object(
    'nside', $2,
    'generated_at', $1,
    'kp', coalesce((latest_point #>> '{indices,kp}')::double precision, 2),
    'driver_bz', coalesce((latest_point #>> '{magneticField,z}')::double precision, 0)
  );

  harmonics_payload := jsonb_build_object(
    'lMax', 8,
    'powerSpectrum', jsonb_build_array(
      jsonb_build_object('l', 0, 'cL', 1.0),
      jsonb_build_object('l', 1, 'cL', 0.7),
      jsonb_build_object('l', 2, 'cL', 0.4)
    )
  );

  insert into public.aurora_healpix_maps (timestamp, nside, map, harmonics)
  values ($1, $2, map_payload, harmonics_payload)
  on conflict (timestamp, nside) do update
    set map = excluded.map,
        harmonics = excluded.harmonics,
        inserted_at = now();
end;
$$;

create or replace function public.get_feed_5s(
  lookback interval,
  max_rows integer default 17280
)
returns table (
  ts timestamptz,
  point jsonb,
  quality_flags jsonb,
  uncertainty jsonb
)
language sql
security definer
as $$
  select
    f.timestamp as ts,
    f.point,
    f.quality_flags,
    f.uncertainty
  from public.sw_nowcast_5s f
  where f.timestamp >= now() - lookback
  order by f.timestamp desc
  limit greatest(1, least(max_rows, 17280));
$$;

create or replace function public.get_mms_recon_feed(
  lookback interval,
  max_rows integer default 5000
)
returns table (
  ts timestamptz,
  vector jsonb,
  quality jsonb
)
language sql
security definer
as $$
  select
    m.timestamp as ts,
    m.vector,
    m.quality
  from public.mms_recon_vectors_5s m
  where m.timestamp >= now() - lookback
  order by m.timestamp desc
  limit greatest(1, least(max_rows, 5000));
$$;
