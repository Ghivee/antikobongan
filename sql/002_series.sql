-- AntiKobongan — Migrasi 002: agregasi riwayat, audit skor, admin.
-- Jalankan SETELAH 001_schema.sql di Supabase SQL Editor.
-- Idempotent: aman dijalankan ulang dan tidak menghapus data.
-- Butuh Postgres 14+ (date_bin); Supabase memakai Postgres 15.

-- 1. AUDIT SKOR RISIKO
-- gas_excess dipakai rumus risiko firmware; tanpa kolom ini skor historis tidak
-- bisa dihitung ulang. formula_version = versi calcRiskScore di firmware.
alter table public.readings add column if not exists gas_excess integer;
alter table public.readings add column if not exists formula_version smallint;

-- 2. METADATA NODE (dikelola dari panel admin dasbor lewat POST /api/nodes)
alter table public.nodes add column if not exists lapisan text;
alter table public.nodes add column if not exists ketinggian double precision;
alter table public.nodes add column if not exists updated_at timestamptz not null default now();

-- Status notifikasi Telegram pencatat (ditampilkan di tab I/O dasbor).
alter table public.backend_heartbeat add column if not exists telegram boolean;

-- 3. INDEX
create index if not exists events_node_time_idx on public.events (node_id, created_at desc);

-- 4. RIWAYAT TERAGREGASI PER BUCKET WAKTU
-- Dipanggil /api/series lewat POST /rest/v1/rpc/reading_series.
-- Mengembalikan satu baris per bucket yang BERISI data; bucket kosong tidak
-- dikembalikan sehingga klien bisa menandai jeda sebagai "tidak ada data".
create or replace function public.reading_series(
  p_node text,
  p_from timestamptz,
  p_to timestamptz,
  p_bucket_seconds integer
)
returns table (
  t timestamptz,
  n integer,
  suhu_avg double precision, suhu_min double precision, suhu_max double precision,
  rh_avg double precision, rh_min double precision, rh_max double precision,
  gas_avg double precision, gas_min integer, gas_max integer,
  tanah_avg double precision, tanah_min double precision, tanah_max double precision,
  tekanan_avg double precision,
  risk_avg double precision, risk_min integer, risk_max integer
)
language sql
stable
security invoker
set search_path = public
as $$
  select
    date_bin(make_interval(secs => greatest(p_bucket_seconds, 1)), r.received_at, timestamptz '2000-01-01 00:00:00+00') as t,
    count(*)::integer as n,
    avg(r.suhu), min(r.suhu), max(r.suhu),
    avg(r.kelembapan), min(r.kelembapan), max(r.kelembapan),
    avg(r.gas)::double precision, min(r.gas), max(r.gas),
    avg(r.kelembapan_tanah), min(r.kelembapan_tanah), max(r.kelembapan_tanah),
    avg(r.tekanan),
    avg(r.risk_score)::double precision, min(r.risk_score), max(r.risk_score)
  from public.readings r
  where r.node_id = p_node
    and r.received_at >= p_from
    and r.received_at < p_to
  group by 1
  order by 1 asc;
$$;

-- 5. RINGKASAN PEMBACAAN TERAKHIR (untuk /api/latest)
create or replace function public.reading_latest(p_node text)
returns table (
  received_at timestamptz,
  sensor_ts timestamptz,
  suhu double precision,
  kelembapan double precision,
  gas integer,
  gas_excess integer,
  tekanan double precision,
  kelembapan_tanah double precision,
  risk_score integer,
  status text,
  formula_version smallint,
  first_at timestamptz,
  total bigint,
  has_tekanan boolean
)
language sql
stable
security invoker
set search_path = public
as $$
  with last_row as (
    select r.received_at, r.sensor_ts, r.suhu, r.kelembapan, r.gas, r.gas_excess, r.tekanan,
           r.kelembapan_tanah, r.risk_score, r.status, r.formula_version
    from public.readings r
    where r.node_id = p_node
    order by r.received_at desc
    limit 1
  ),
  stats as (
    select min(r.received_at) as first_at,
           count(*) as total,
           bool_or(r.tekanan is not null) as has_tekanan
    from public.readings r
    where r.node_id = p_node
  )
  select l.received_at, l.sensor_ts, l.suhu, l.kelembapan, l.gas, l.gas_excess, l.tekanan,
         l.kelembapan_tanah, l.risk_score, l.status, l.formula_version,
         s.first_at, s.total, coalesce(s.has_tekanan, false)
  from last_row l cross join stats s;
$$;

grant execute on function public.reading_series(text, timestamptz, timestamptz, integer) to anon, authenticated, service_role;
grant execute on function public.reading_latest(text) to anon, authenticated, service_role;

-- 6. RATE LIMIT PIN ADMIN
-- Hanya service role (API serverless) yang boleh membaca/menulis: RLS aktif
-- tanpa policy untuk anon.
create table if not exists public.admin_attempts (
  id bigint generated always as identity primary key,
  ip_hash text not null,
  ok boolean not null default false,
  at timestamptz not null default now()
);
create index if not exists admin_attempts_ip_time_idx on public.admin_attempts (ip_hash, at desc);
alter table public.admin_attempts enable row level security;

-- Muat ulang cache skema PostgREST agar fungsi & kolom baru langsung terlihat.
notify pgrst, 'reload schema';
