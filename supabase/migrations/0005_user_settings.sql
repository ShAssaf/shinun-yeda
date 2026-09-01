-- הגדרות משתמש — שורה אחת לכל משתמש.
-- תאריך המבחן חייב להיות בשרת: הוא משפיע על תזמון החזרות עצמו, ולכן
-- מכשיר שני בלי התאריך היה מתזמן כרטיסים למועד שאחרי המבחן.

create table if not exists public.user_settings (
  user_id    uuid primary key references auth.users (id) on delete cascade,
  exam_date  date,
  rounds     integer not null default 0,
  updated_at timestamptz not null default now()
);

alter table public.user_settings enable row level security;

drop policy if exists settings_own on public.user_settings;
create policy settings_own on public.user_settings
  for all to authenticated
  using (user_id = auth.uid())
  with check (user_id = auth.uid());
