-- תוכן בבעלות משתמשים, עם נראות ומינויים.
-- להרצה פעם אחת ב-SQL Editor של Supabase, אחרי 0001.

create extension if not exists pgcrypto;

-- ---------------------------------------------------------------- חבילות
-- kind קובע איזה מנוע שאלות מפעיל את החבילה בצד הלקוח:
--   groups · elements · iso — מנועים ייעודיים, מגיעים מהזריעה
--   topic                   — המנוע הגנרי, וזה מה שמשתמש יוצר
create table if not exists public.decks (
  id          uuid primary key default gen_random_uuid(),
  owner_id    uuid not null references auth.users (id) on delete cascade,
  kind        text not null check (kind in ('groups','elements','iso','topic')),
  title       text not null,
  subtitle    text,
  color       text,
  visibility  text not null default 'private' check (visibility in ('private','public')),
  data        jsonb not null,
  item_count  integer not null default 0,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);

create index if not exists decks_public_idx on public.decks (visibility, updated_at desc);
create index if not exists decks_owner_idx  on public.decks (owner_id);

-- גרסה קודמת נשמרת בכל כתיבה, כדי שיהיה למה לחזור.
-- זה מה שגיט נתן בחינם כשהתוכן ישב בריפו.
create table if not exists public.deck_history (
  id         bigint generated always as identity primary key,
  deck_id    uuid not null references public.decks (id) on delete cascade,
  data       jsonb not null,
  title      text,
  saved_at   timestamptz not null default now(),
  saved_by   uuid references auth.users (id) on delete set null
);

create index if not exists deck_history_deck_idx on public.deck_history (deck_id, saved_at desc);

create or replace function public.snapshot_deck() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if tg_op = 'UPDATE' and new.data is distinct from old.data then
    insert into public.deck_history (deck_id, data, title, saved_by)
    values (old.id, old.data, old.title, auth.uid());
    new.updated_at := now();
  end if;
  return new;
end $$;

drop trigger if exists decks_snapshot on public.decks;
create trigger decks_snapshot before update on public.decks
  for each row execute function public.snapshot_deck();

-- ---------------------------------------------------------------- מינויים
create table if not exists public.deck_subscriptions (
  user_id  uuid not null references auth.users (id) on delete cascade,
  deck_id  uuid not null references public.decks (id) on delete cascade,
  added_at timestamptz not null default now(),
  primary key (user_id, deck_id)
);

-- ---------------------------------------------------------------- הרשאות
alter table public.decks              enable row level security;
alter table public.deck_history       enable row level security;
alter table public.deck_subscriptions enable row level security;

-- קריאה: חבילות ציבוריות לכולם, פרטיות רק לבעלים
drop policy if exists decks_read on public.decks;
create policy decks_read on public.decks
  for select to authenticated
  using (visibility = 'public' or owner_id = auth.uid());

-- כתיבה: רק הבעלים, ורק על שורות שהוא הבעלים שלהן
drop policy if exists decks_insert on public.decks;
create policy decks_insert on public.decks
  for insert to authenticated with check (owner_id = auth.uid());

drop policy if exists decks_update on public.decks;
create policy decks_update on public.decks
  for update to authenticated
  using (owner_id = auth.uid()) with check (owner_id = auth.uid());

drop policy if exists decks_delete on public.decks;
create policy decks_delete on public.decks
  for delete to authenticated using (owner_id = auth.uid());

-- היסטוריה נקראת רק ע"י בעל החבילה
drop policy if exists deck_history_read on public.deck_history;
create policy deck_history_read on public.deck_history
  for select to authenticated
  using (exists (select 1 from public.decks d
                 where d.id = deck_history.deck_id and d.owner_id = auth.uid()));

-- מינויים: כל אחד רק את שלו, ורק לחבילה שמותר לו לראות
drop policy if exists subs_read on public.deck_subscriptions;
create policy subs_read on public.deck_subscriptions
  for select to authenticated using (user_id = auth.uid());

drop policy if exists subs_write on public.deck_subscriptions;
create policy subs_write on public.deck_subscriptions
  for insert to authenticated
  with check (user_id = auth.uid()
    and exists (select 1 from public.decks d
                where d.id = deck_id and (d.visibility = 'public' or d.owner_id = auth.uid())));

drop policy if exists subs_delete on public.deck_subscriptions;
create policy subs_delete on public.deck_subscriptions
  for delete to authenticated using (user_id = auth.uid());

-- ------------------------------------------------- העברת היסטוריה קיימת
-- מפתחות הכרטיסים היו 'fg:methyl' וכדומה. עכשיו הם '<deck_id>:<item_id>'.
-- הפונקציה נוגעת אך ורק בשורות של הקורא, ולכן בטוחה כ-security definer.
create or replace function public.remap_card_keys(old_prefix text, deck uuid)
returns integer
language plpgsql security definer set search_path = public as $$
declare moved integer;
begin
  if auth.uid() is null then raise exception 'נדרשת התחברות'; end if;
  if not exists (select 1 from public.decks d where d.id = deck and d.owner_id = auth.uid())
    then raise exception 'החבילה אינה שלך'; end if;

  with moved_rows as (
    update public.card_state
       set card_key = deck::text || ':' || right(card_key, -length(old_prefix))
     where user_id = auth.uid()
       and card_key like old_prefix || '%'
       -- שורה שכבר הועברה לא תועבר שוב
       and not exists (
         select 1 from public.card_state c2
          where c2.user_id = auth.uid()
            and c2.card_key = deck::text || ':' || right(public.card_state.card_key, -length(old_prefix)))
    returning 1)
  select count(*) into moved from moved_rows;

  update public.review_log
     set card_key = deck::text || ':' || right(card_key, -length(old_prefix))
   where user_id = auth.uid() and card_key like old_prefix || '%';

  return moved;
end $$;

revoke all on function public.remap_card_keys(text, uuid) from public;
grant execute on function public.remap_card_keys(text, uuid) to authenticated;
