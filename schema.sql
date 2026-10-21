create table if not exists messages (
  id bigint generated always as identity primary key,
  session_id text not null,
  role text not null,
  content text not null,
  created_at timestamptz default now()
);
create table if not exists memories (
  id bigint generated always as identity primary key,
  session_id text not null,
  fact text not null,
  created_at timestamptz default now()
);
create index if not exists messages_session_idx on messages (session_id, created_at);
create index if not exists memories_session_idx on memories (session_id);
