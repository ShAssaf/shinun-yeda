-- מצב הזיכרון של כל כרטיס לכל משתמש, לפי FSRS-6.
-- להרצה פעם אחת ב-SQL Editor של Supabase.

create table if not exists public.card_state (
  user_id     uuid        not null references auth.users (id) on delete cascade,
  card_key    text        not null,
  stability   double precision not null,   -- ימים עד שהזיכרון יורד ל-90%
  difficulty  double precision not null,   -- 1..10
  due         timestamptz not null,
  last_review timestamptz not null,
  reps        integer     not null default 0,
  lapses      integer     not null default 0,
  updated_at  timestamptz not null default now(),
  primary key (user_id, card_key)
);

create index if not exists card_state_due_idx on public.card_state (user_id, due);

-- יומן חזרות — לא נדרש לתזמון, אבל בלעדיו אי אפשר יהיה לכייל
-- את פרמטרי FSRS לפי ההיסטוריה האישית בהמשך.
create table if not exists public.review_log (
  id           bigint generated always as identity primary key,
  user_id      uuid        not null references auth.users (id) on delete cascade,
  card_key     text        not null,
  rating       smallint    not null check (rating between 1 and 4),
  reviewed_at  timestamptz not null default now(),
  elapsed_days double precision,
  duration_ms  integer
);

create index if not exists review_log_user_idx on public.review_log (user_id, reviewed_at desc);

alter table public.card_state enable row level security;
alter table public.review_log enable row level security;

-- כל משתמש רואה ומשנה רק את השורות שלו
drop policy if exists card_state_own on public.card_state;
create policy card_state_own on public.card_state
  for all to authenticated
  using (auth.uid() = user_id)
  with check (auth.uid() = user_id);

drop policy if exists review_log_own on public.review_log;
create policy review_log_own on public.review_log
  for all to authenticated
  using (auth.uid() = user_id)
  with check (auth.uid() = user_id);
