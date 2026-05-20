-- Fix ambiguous reference between function arg `nside` and table column `nside`.
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
