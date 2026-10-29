-- AntiKobongan — Skema Supabase (Postgres) Lengkap & Idempotent.
-- Jalankan di Supabase SQL Editor. Aman dijalankan ulang berkali-kali.

-- 1. TABEL READINGS (Data Pengukuran Sensor)
create table if not exists public.readings (
  id bigint generated always as identity primary key,
  node_id text not null,
  received_at timestamptz not null default now(),
  sensor_ts timestamptz,
  suhu double precision not null,
  kelembapan double precision not null,
  gas integer not null,
  tekanan double precision,
  kelembapan_tanah double precision,
  risk_score integer,
  status text
);
create index if not exists readings_node_time_idx on public.readings (node_id, received_at desc);
create unique index if not exists readings_node_sensor_ts_uniq on public.readings (node_id, sensor_ts) where sensor_ts is not null;

-- 2. TABEL NODE STATUS (Status Online & Heartbeat Terakhir Per Node)
create table if not exists public.node_status (
  node_id text primary key,
  online boolean not null default false,
  last_seen timestamptz,
  updated_at timestamptz not null default now()
);

-- 3. TABEL EVENTS & ALERTS (Log Kejadian & Peringatan Risiko)
create table if not exists public.events (
  id bigint generated always as identity primary key,
  created_at timestamptz not null default now(),
  node_id text,
  kind text not null,
  message text,
  meta jsonb
);
create index if not exists events_time_idx on public.events (created_at desc);

create table if not exists public.alerts (
  id bigint generated always as identity primary key,
  node_id text not null,
  level text not null,
  pesan text not null,
  ts timestamptz not null default now(),
  diakui_oleh text,
  diakui_pada timestamptz
);
create index if not exists alerts_node_time_idx on public.alerts (node_id, ts desc);

-- 4. TABEL NODES (Master Data Node & Lokasi Geografis)
create table if not exists public.nodes (
  id bigint generated always as identity primary key,
  node_id text not null unique,
  nama text not null,
  gunung text,
  lat double precision,
  lon double precision,
  aktif boolean not null default true,
  created_at timestamptz not null default now()
);

-- 5. TABEL BACKEND HEARTBEAT (Deteksi Laptop/Daemon Aktif)
create table if not exists public.backend_heartbeat (
  id integer primary key default 1,
  ts timestamptz not null default now(),
  status text not null default 'active'
);

-- Inisialisasi baris heartbeat default
insert into public.backend_heartbeat (id, ts, status)
values (1, now(), 'active')
on conflict (id) do nothing;

-- 6. ROW LEVEL SECURITY (RLS) & POLICIES
alter table public.readings enable row level security;
alter table public.node_status enable row level security;
alter table public.events enable row level security;
alter table public.alerts enable row level security;
alter table public.nodes enable row level security;
alter table public.backend_heartbeat enable row level security;

-- Hak baca publik (anon key) untuk dashboard
drop policy if exists anon_select_readings on public.readings;
create policy anon_select_readings on public.readings for select to anon using (true);

drop policy if exists anon_select_node_status on public.node_status;
create policy anon_select_node_status on public.node_status for select to anon using (true);

drop policy if exists anon_select_events on public.events;
create policy anon_select_events on public.events for select to anon using (true);

drop policy if exists anon_select_alerts on public.alerts;
create policy anon_select_alerts on public.alerts for select to anon using (true);

drop policy if exists anon_select_nodes on public.nodes;
create policy anon_select_nodes on public.nodes for select to anon using (true);

drop policy if exists anon_select_backend_heartbeat on public.backend_heartbeat;
create policy anon_select_backend_heartbeat on public.backend_heartbeat for select to anon using (true);
