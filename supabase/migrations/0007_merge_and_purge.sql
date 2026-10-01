-- איחוד נושאים, ומחיקה מלאה של נושאים ציבוריים בידי אדמין.
-- להרצה פעם אחת ב-SQL Editor של Supabase, אחרי 0006. אידמפוטנטית:
-- רק פונקציות, בלי שינוי בנתונים.

-- ------------------------------------------------------- 1. איחוד נושאים
-- מאחד נושאים לתוך נושא שבבעלות הקורא. הכול בטרנזקציה אחת — איחוד
-- שנפל באמצע לא משאיר חצי נושא או התקדמות שעברה רק בחלקה.
--
-- מקור שבבעלותי: הפריטים עוברים, ההתקדמות של כל מי שתרגל אותו
--   (גם מנויים) עוברת איתם, המנויים עוברים ליעד אם הוא ציבורי, והמקור נמחק.
-- מקור של אחר (ציבורי ומאושר, או שאני רשום אליו): הפריטים מועתקים,
--   רק ההתקדמות שלי עוברת, והמינוי שלי אליו מוסר. הנושא עצמו לא נפגע.
--
-- פריט שה-id שלו כבר קיים ביעד: אם הוא זהה לחלוטין — לא מוכפל, וההתקדמות
-- מתאחדת (החזרה המאוחרת נשארת, כמו בכל מקום אחר). אם שונה — מקבל id חדש
-- (x-2, x-3…) כדי ששני הכרטיסים יישארו, כל אחד עם ההיסטוריה שלו.
--
-- עץ האיזומרים לא מתאחד: יש בו הפניות בין פריטים (parent), ושינוי id
-- היה שובר אותן.
--
-- מחזירה {into, added, merged, deleted, map}; map הוא מפתח ישן ← חדש
-- ('<deck>:<item>'), כדי שהלקוח יעביר גם את העותק המקומי שלו.
create or replace function public.merge_decks(p_into uuid, p_from uuid[])
returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  uid       uuid := auth.uid();
  v_into    public.decks%rowtype;
  v_src     public.decks%rowtype;
  v_items   jsonb;
  v_srcarr  jsonb;
  v_ids     jsonb := '{}';    -- id ← הפריט, לזיהוי התנגשויות
  v_all     jsonb := '{}';    -- מפתחות של מקורות שלי: לכל המשתמשים
  v_own     jsonb := '{}';    -- מפתחות של מקורות של אחרים: רק לקורא
  v_seen    uuid[] := '{}';
  it        jsonb;
  old_id    text;
  new_id    text;
  n         int;
  v_added   int := 0;
  v_deleted int := 0;
begin
  if uid is null then raise exception 'נדרשת התחברות' using errcode = '42501'; end if;
  if p_from is null or cardinality(p_from) = 0 then raise exception 'לא נבחרו נושאים לאיחוד'; end if;
  if p_into = any(p_from) then raise exception 'אי אפשר לאחד נושא עם עצמו'; end if;

  select * into v_into from public.decks where id = p_into for update;
  if not found then raise exception 'הנושא לא נמצא' using errcode = 'PT404'; end if;
  if v_into.owner_id <> uid then
    raise exception 'אפשר לאחד רק לתוך נושא שלך' using errcode = '42501';
  end if;
  if v_into.kind = 'iso' then raise exception 'עץ האיזומרים אינו ניתן לאיחוד'; end if;

  -- נושא ישן שמור לפעמים כ-{cards:[…]}. היעד נכתב תמיד כמערך.
  v_items := case when jsonb_typeof(v_into.data) = 'array' then v_into.data
                  when jsonb_typeof(v_into.data -> 'cards') = 'array' then v_into.data -> 'cards'
                  else '[]'::jsonb end;
  for it in select value from jsonb_array_elements(v_items) loop
    if jsonb_typeof(it) = 'object' and nullif(it ->> 'id', '') is not null then
      v_ids := v_ids || jsonb_build_object(it ->> 'id', it);
    end if;
  end loop;

  -- לפי הסדר שנבחר, כדי שהפריטים יתווספו בסדר צפוי
  for v_src in
    select * from public.decks
     where id = any(p_from)
     order by array_position(p_from, id)
       for update
  loop
    if v_src.id = any(v_seen) then continue; end if;
    v_seen := v_seen || v_src.id;

    -- security definer עוקף RLS, ולכן הבדיקה של decks_read חוזרת כאן במפורש.
    -- ההודעה לא מזכירה את הכותרת: נושא שאין לי גישה אליו לא ייחשף דרכה.
    if not (v_src.owner_id = uid
            or (v_src.visibility = 'public'
                and (v_src.review_status = 'approved'
                     or public.is_admin()
                     or exists (select 1 from public.deck_subscriptions s
                                 where s.deck_id = v_src.id and s.user_id = uid)))) then
      raise exception 'אין גישה לאחד הנושאים שנבחרו' using errcode = '42501';
    end if;
    if v_src.kind <> v_into.kind then
      raise exception 'אפשר לאחד רק נושאים מאותו סוג ("%" שונה)', v_src.title;
    end if;

    v_srcarr := case when jsonb_typeof(v_src.data) = 'array' then v_src.data
                     when jsonb_typeof(v_src.data -> 'cards') = 'array' then v_src.data -> 'cards'
                     else '[]'::jsonb end;

    for it in select value from jsonb_array_elements(v_srcarr) loop
      -- פריט בלי id ממילא מסונן בלקוח ואין לו התקדמות
      if jsonb_typeof(it) <> 'object' or nullif(it ->> 'id', '') is null then continue; end if;
      old_id := it ->> 'id';
      new_id := old_id;

      if v_ids ? old_id then
        if v_ids -> old_id = it then
          new_id := null;                       -- זהה: לא מוסיפים, רק ממפים
        else
          n := 2;
          while v_ids ? (old_id || '-' || n) loop n := n + 1; end loop;
          new_id := old_id || '-' || n;
          it := jsonb_set(it, '{id}', to_jsonb(new_id));
        end if;
      end if;

      if new_id is not null then
        v_ids   := v_ids || jsonb_build_object(new_id, it);
        v_items := v_items || jsonb_build_array(it);
        v_added := v_added + 1;
      end if;

      if v_src.owner_id = uid then
        v_all := v_all || jsonb_build_object(v_src.id::text || ':' || old_id,
                                             p_into::text || ':' || coalesce(new_id, old_id));
      else
        v_own := v_own || jsonb_build_object(v_src.id::text || ':' || old_id,
                                             p_into::text || ':' || coalesce(new_id, old_id));
      end if;
    end loop;

    if v_src.owner_id = uid then
      -- מנויים ממשיכים ליעד — רק כשהוא ציבורי. מינוי לנושא פרטי לא נותן
      -- גישה, והיה מחכה בשקט עד שהנושא יפורסם.
      if v_into.visibility = 'public' then
        insert into public.deck_subscriptions (user_id, deck_id)
        select s.user_id, p_into from public.deck_subscriptions s
         where s.deck_id = v_src.id
        on conflict do nothing;
      end if;
    else
      delete from public.deck_subscriptions
       where deck_id = v_src.id and user_id = uid;
    end if;
  end loop;

  if cardinality(v_seen) <> (select count(distinct x) from unnest(p_from) x) then
    raise exception 'אחד הנושאים שנבחרו כבר לא קיים' using errcode = 'PT404';
  end if;

  -- decks_moderate רץ כרגיל: יעד ציבורי של משתמש רגיל חוזר לאישור, כמו
  -- בכל עריכה. snapshot_deck שומר את הגרסה שלפני האיחוד.
  update public.decks
     set data = v_items, item_count = jsonb_array_length(v_items)
   where id = p_into;

  -- ההתקדמות. כמה מפתחות ישנים שממופים לאותו חדש (פריט זהה בשני נושאים) —
  -- נשאר זה עם החזרה המאוחרת; ומול מה שכבר קיים ביעד, card_state_guard
  -- מדלג על עדכון ישן יותר.
  insert into public.card_state (user_id, card_key, stability, difficulty, due, last_review, reps, lapses)
  select distinct on (c.user_id, m.value)
         c.user_id, m.value, c.stability, c.difficulty, c.due, c.last_review, c.reps, c.lapses
    from public.card_state c
    join (select key, value, true as everyone from jsonb_each_text(v_all)
          union all
          select key, value, false from jsonb_each_text(v_own)) m on m.key = c.card_key
   where m.everyone or c.user_id = uid
   order by c.user_id, m.value, c.last_review desc
  on conflict (user_id, card_key) do update
     set stability = excluded.stability, difficulty = excluded.difficulty, due = excluded.due,
         last_review = excluded.last_review, reps = excluded.reps, lapses = excluded.lapses;

  update public.review_log r set card_key = m.value
    from jsonb_each_text(v_all) m where r.card_key = m.key;
  update public.review_log r set card_key = m.value
    from jsonb_each_text(v_own) m where r.card_key = m.key and r.user_id = uid;

  delete from public.card_state c using jsonb_each_text(v_own) m
   where c.card_key = m.key and c.user_id = uid;

  -- מקורות שלי: כל מה שנשאר תחת המפתח שלהם (כולל פריטים שנמחקו מהם
  -- מזמן) יתום מרגע המחיקה — הולך איתם.
  with gone as (
    delete from public.decks d
     where d.id = any(v_seen) and d.owner_id = uid
    returning d.id)
  select count(*) into v_deleted from gone;

  delete from public.card_state c
   where exists (select 1 from unnest(v_seen) g(id)
                  where c.card_key like g.id::text || ':%'
                    and not exists (select 1 from public.decks d where d.id = g.id));
  delete from public.review_log r
   where exists (select 1 from unnest(v_seen) g(id)
                  where r.card_key like g.id::text || ':%'
                    and not exists (select 1 from public.decks d where d.id = g.id));

  return jsonb_build_object('into', p_into, 'added', v_added, 'merged', cardinality(v_seen),
                            'deleted', v_deleted, 'map', v_all || v_own);
end $$;

revoke all on function public.merge_decks(uuid, uuid[]) from public, anon;
grant execute on function public.merge_decks(uuid, uuid[]) to authenticated;

-- ------------------------------------------- 2. מחיקה מלאה בידי אדמין
-- מחיקה רגילה (decks_admin_delete) מסירה את הנושא, אבל ההתקדמות של כל מי
-- שתרגל אותו נשארת יתומה בשרת. כאן הכול יוצא: הנושא, ההיסטוריה שלו
-- והמינויים (cascade), ו-card_state ו-review_log של כל המשתמשים.
-- רק מה שהאדמין רואה במסך הניהול — ציבורי או נדחה — או נושא שלו.
-- נושאים פרטיים של אחרים לא נמחקים, גם אם ה-id שלהם נשלח.
-- מחזירה כמה נושאים נמחקו.
create or replace function public.admin_purge_decks(p_decks uuid[])
returns integer
language plpgsql security definer set search_path = public as $$
declare
  v_ids uuid[];
begin
  if not public.is_admin() then raise exception 'אין הרשאה' using errcode = '42501'; end if;
  if p_decks is null or cardinality(p_decks) = 0 then return 0; end if;

  with gone as (
    delete from public.decks d
     where d.id = any(p_decks)
       and (d.visibility = 'public' or d.review_status = 'rejected' or d.owner_id = auth.uid())
    returning d.id)
  select coalesce(array_agg(id), '{}') into v_ids from gone;

  if cardinality(v_ids) > 0 then
    -- uuid הוא הקס ומקפים — אין בו תווים כלליים של LIKE
    delete from public.card_state c using unnest(v_ids) g(id)
     where c.card_key like g.id::text || ':%';
    delete from public.review_log r using unnest(v_ids) g(id)
     where r.card_key like g.id::text || ':%';
  end if;

  return cardinality(v_ids);
end $$;

revoke all on function public.admin_purge_decks(uuid[]) from public, anon;
grant execute on function public.admin_purge_decks(uuid[]) to authenticated;

-- ------------------------------------------------------------ 3. רענון
notify pgrst, 'reload schema';
