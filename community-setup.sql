-- Fight Week: Community tab (posts, likes, saves, comments, friends)
-- Paste ALL of this into Supabase > SQL Editor > New query, then click Run. Run it once.

-- ---------- helpers ----------
-- the league commissioner can remove any post or comment
create or replace function public.fw_is_commish() returns boolean
language sql stable as $$ select auth.uid() = '414eba8d-669f-4cbb-8976-abb42c12c228'::uuid $$;

-- ---------- friends: request, then accept ----------
create table if not exists public.friendships (
  requester   uuid not null references public.profiles(id) on delete cascade,
  addressee   uuid not null references public.profiles(id) on delete cascade,
  status      text not null default 'pending' check (status in ('pending','accepted')),
  created_at  timestamptz not null default now(),
  accepted_at timestamptz,
  primary key (requester, addressee),
  check (requester <> addressee)
);
-- one friendship per pair, whichever way round it was sent
create unique index if not exists friendships_one_per_pair
  on public.friendships (least(requester, addressee), greatest(requester, addressee));

create or replace function public.fw_are_friends(a uuid, b uuid) returns boolean
language sql stable security definer set search_path = public as $$
  select exists (select 1 from friendships
                 where status = 'accepted'
                   and ((requester = a and addressee = b) or (requester = b and addressee = a)))
$$;

-- ---------- posts ----------
create table if not exists public.posts (
  id          bigint generated always as identity primary key,
  author      uuid not null default auth.uid() references public.profiles(id) on delete cascade,
  body        text not null check (char_length(btrim(body)) between 1 and 1000),
  visibility  text not null default 'public' check (visibility in ('public','friends')),
  card_id     text references public.cards(id) on delete set null,
  fight_id    text,
  created_at  timestamptz not null default now()
);
create index if not exists posts_newest on public.posts (created_at desc);

create or replace function public.fw_can_see_post(p bigint) returns boolean
language sql stable security definer set search_path = public as $$
  select exists (select 1 from posts x
                 where x.id = p
                   and (x.visibility = 'public' or x.author = auth.uid() or fw_are_friends(x.author, auth.uid())))
$$;

-- ---------- likes, saves, comments ----------
create table if not exists public.post_likes (
  post_id    bigint not null references public.posts(id) on delete cascade,
  user_id    uuid not null default auth.uid() references public.profiles(id) on delete cascade,
  created_at timestamptz not null default now(),
  primary key (post_id, user_id)
);
create table if not exists public.post_saves (
  post_id    bigint not null references public.posts(id) on delete cascade,
  user_id    uuid not null default auth.uid() references public.profiles(id) on delete cascade,
  created_at timestamptz not null default now(),
  primary key (post_id, user_id)
);
create table if not exists public.post_comments (
  id         bigint generated always as identity primary key,
  post_id    bigint not null references public.posts(id) on delete cascade,
  author     uuid not null default auth.uid() references public.profiles(id) on delete cascade,
  body       text not null check (char_length(btrim(body)) between 1 and 500),
  created_at timestamptz not null default now()
);
create index if not exists post_comments_by_post on public.post_comments (post_id, created_at);

-- ---------- who can do what ----------
alter table public.friendships   enable row level security;
alter table public.posts         enable row level security;
alter table public.post_likes    enable row level security;
alter table public.post_saves    enable row level security;
alter table public.post_comments enable row level security;

-- friendships: you see the ones you're in; you send requests as yourself; only the person asked can accept; either side can remove
create policy "friends read"   on public.friendships for select to authenticated using ((select auth.uid()) in (requester, addressee));
create policy "friends ask"    on public.friendships for insert to authenticated with check (requester = (select auth.uid()) and status = 'pending');
create policy "friends accept" on public.friendships for update to authenticated using (addressee = (select auth.uid())) with check (addressee = (select auth.uid()) and status = 'accepted');
create policy "friends remove" on public.friendships for delete to authenticated using ((select auth.uid()) in (requester, addressee));

-- posts: everyone sees public posts; friends-only posts go to the author's accepted friends; authors post as themselves; author or commissioner can delete
create policy "posts read"   on public.posts for select to authenticated using (visibility = 'public' or author = (select auth.uid()) or public.fw_are_friends(author, (select auth.uid())));
create policy "posts write"  on public.posts for insert to authenticated with check (author = (select auth.uid()));
create policy "posts delete" on public.posts for delete to authenticated using (author = (select auth.uid()) or public.fw_is_commish());

-- likes: visible on posts you can see; like/unlike as yourself
create policy "likes read"   on public.post_likes for select to authenticated using (public.fw_can_see_post(post_id));
create policy "likes add"    on public.post_likes for insert to authenticated with check (user_id = (select auth.uid()) and public.fw_can_see_post(post_id));
create policy "likes remove" on public.post_likes for delete to authenticated using (user_id = (select auth.uid()));

-- saves: private to you
create policy "saves read"   on public.post_saves for select to authenticated using (user_id = (select auth.uid()));
create policy "saves add"    on public.post_saves for insert to authenticated with check (user_id = (select auth.uid()) and public.fw_can_see_post(post_id));
create policy "saves remove" on public.post_saves for delete to authenticated using (user_id = (select auth.uid()));

-- comments: visible on posts you can see; comment as yourself; comment author or commissioner can delete
create policy "comments read"   on public.post_comments for select to authenticated using (public.fw_can_see_post(post_id));
create policy "comments add"    on public.post_comments for insert to authenticated with check (author = (select auth.uid()) and public.fw_can_see_post(post_id));
create policy "comments delete" on public.post_comments for delete to authenticated using (author = (select auth.uid()) or public.fw_is_commish());

grant select, insert, update, delete on public.friendships, public.posts, public.post_likes, public.post_saves, public.post_comments to authenticated;
