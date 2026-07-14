#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""flat dorm_reservations -> 정규화(buildings/students/rooms/reservations) 트랜잭션."""
import os
import psycopg2

c = psycopg2.connect(host=os.getenv('PG_HOST', 'aws-0-ap-northeast-1.pooler.supabase.com'), port=5432,
                     user=os.getenv('PG_USER', 'postgres.bauhnnpioaephlwurxzg'),
                     password=os.environ['PG_PASS'],
                     dbname='postgres', sslmode='require')
cur = c.cursor()

SQL = r"""
drop view if exists room_reserve_compat;
alter table dorm_reservations rename to dorm_reservations_flat;

-- 1) 건물
create table dorm_buildings (
  building_id smallserial primary key,
  bldg_type   char(1) unique not null,
  name        text
);
insert into dorm_buildings (bldg_type, name) values
  ('E','E동'),('S','S동'),('C','C동'),('P','P동'),('X','미지정(NULL)');

-- 2) 학생
create table dorm_students (
  student_id bigserial primary key,
  s_idx      integer unique not null
);
insert into dorm_students (s_idx)
select distinct s_idx from dorm_reservations_flat order by s_idx;

-- 3) 객실  (건물 x r_idx)
create table dorm_rooms (
  room_id     bigserial primary key,
  building_id smallint not null references dorm_buildings(building_id),
  r_idx       integer  not null,
  unique (building_id, r_idx)
);
insert into dorm_rooms (building_id, r_idx)
select distinct b.building_id, f.r_idx
from dorm_reservations_flat f
join dorm_buildings b on b.bldg_type = coalesce(f.bldg_type,'X')
order by 1,2;

-- 4) 예약 (FK)
create table dorm_reservations (
  id         bigserial primary key,
  room_id    bigint  not null references dorm_rooms(room_id),
  student_id bigint  not null references dorm_students(student_id),
  ri_idx     integer not null,
  check_in   date    not null,
  check_out  date    not null,
  num_days   integer not null,
  span_days  integer generated always as ((check_out - check_in) + 1) stored,
  is_reserved boolean not null default false,
  status     text    generated always as (case when is_reserved then 'reserved' else 'confirmed' end) stored,
  created_at timestamptz default now()
);
insert into dorm_reservations (room_id, student_id, ri_idx, check_in, check_out, num_days, is_reserved)
select rm.room_id, st.student_id, f.ri_idx, f.check_in, f.check_out, f.num_days, f.is_reserved
from dorm_reservations_flat f
join dorm_buildings b  on b.bldg_type = coalesce(f.bldg_type,'X')
join dorm_rooms    rm on rm.building_id = b.building_id and rm.r_idx = f.r_idx
join dorm_students st on st.s_idx = f.s_idx;

create index idx_res_room_ci   on dorm_reservations (room_id, check_in);
create index idx_res_student   on dorm_reservations (student_id);
create index idx_res_ci_co     on dorm_reservations (check_in, check_out);

-- 5) 레거시 UI 호환 뷰(일자 전개) 재생성
create view room_reserve_compat as
select r.id as rr_idx,
       rm.r_idx,
       r.ri_idx,
       d::date as rr_date,
       st.s_idx,
       case when r.is_reserved then 'R' else 'I' end as rr_type,
       nullif(b.bldg_type,'X') as bldg_type
from dorm_reservations r
join dorm_rooms     rm on rm.room_id = r.room_id
join dorm_buildings b  on b.building_id = rm.building_id
join dorm_students  st on st.student_id = r.student_id
cross join lateral generate_series(r.check_in::timestamp, r.check_out::timestamp, interval '1 day') d;
"""

try:
    cur.execute(SQL)
    # 검증
    cur.execute("select count(*) from dorm_reservations_flat"); flat = cur.fetchone()[0]
    cur.execute("select count(*) from dorm_reservations");      res  = cur.fetchone()[0]
    cur.execute("select count(*) from dorm_buildings");         bld  = cur.fetchone()[0]
    cur.execute("select count(*) from dorm_students");          stu  = cur.fetchone()[0]
    cur.execute("select count(*) from dorm_rooms");             rms  = cur.fetchone()[0]
    print(f"flat={flat} res={res} buildings={bld} students={stu} rooms={rms}")
    assert flat == res, f"행수 불일치! flat={flat} res={res}"
    c.commit()
    print("COMMIT OK")
except Exception as e:
    c.rollback()
    print("ROLLBACK:", e)
    raise
finally:
    cur.close(); c.close()
