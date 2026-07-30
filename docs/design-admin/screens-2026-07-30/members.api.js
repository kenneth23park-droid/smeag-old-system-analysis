/* eslint-disable */
// ═══ deploy/api/data.js 에 붙일 loader — members (회원관리 / member_list.php) ═══
//  · 소스: cms.g4_member (실측 2,053행) ⨝ legacy.student_info(유학원별 학생수) ⨝ legacy.uhak_agency_com(커미션건수)
//  · 읽기 전용(select 만). 원본 무변경.
//  · 개인정보 비노출(절대): mb_password, mb_jumin, mb_password_q, mb_password_a, mb_lost_certify,
//    mb_birth, mb_zip1/2, mb_addr1/2(상세주소), mb_4/mb_5(은행·계좌번호) → 쿼리에 넣지 않는다.
//  · kind(구분) 계산 근거:
//      ADMIN  = mb_level >= 8  (app.member_authenticate 의 force_th=8 = 관리자 강제 비번변경 기준)
//      AGENCY = mb_10(유학원코드) 있음 ∨ student_info.uhak_id 존재 ∨ uhak_agency_com.mb_id 존재
//      STAFF  = 그 외
//  · 스코프: 유학원 계정(scope.agency)은 자기 계정 1행만 본다(다른 유학원·직원 계정 PII 차단).
// ─────────────────────────────────────────────────────────────────────────────

const MAX_MEMBERS = 3000;      // 실측 2,053행 → 전량 반환 가능(상한만 방어적으로 둠)

async function loadMembers(q, scope) {
  const params = [MAX_MEMBERS];
  let own = "";
  const ag = scope && scope.agency;
  if (ag) { params.push(S(ag)); own = ` where lower(m.mb_id) = lower($${params.length})`; }
  const { rows } = await q(
    `with stu as (   -- 유학원 계정별 학생수(연결 근거: student_info.uhak_id = g4_member.mb_id)
        select lower(coalesce(uhak_id,'')) a, count(*) n
          from legacy.student_info where coalesce(uhak_id,'') <> '' group by 1),
      com as (      -- 커미션 규칙/이력 건수(uhak_agency_com.mb_id = g4_member.mb_id)
        select lower(mb_id) a, count(*) n from legacy.uhak_agency_com group by 1)
     select m.mb_id id, coalesce(m.mb_name,'') name, coalesce(m.mb_nick,'') nick,
            coalesce(m.mb_level,0) level,
            case when coalesce(m.mb_level,0) >= 8 then 'ADMIN'
                 when coalesce(m.mb_10,'') <> '' or stu.a is not null or com.a is not null then 'AGENCY'
                 else 'STAFF' end kind,
            coalesce(m.mb_email,'') email,
            coalesce(nullif(btrim(m.mb_hp),''), nullif(btrim(m.mb_tel),''), nullif(btrim(m.mb_6),''), '') phone,
            coalesce(m.mb_sns,'') sns,
            coalesce(nullif(btrim(m.mb_7),''), '') agency,      -- mb_7 = 유학원 표기명
            lower(coalesce(m.mb_8,'')) comm,                    -- percent | amount
            coalesce(m.mb_9,'') commval,
            case when m.mb_3 ~ '^\\d{4}-\\d{2}-\\d{2}' then left(m.mb_3,10) else '' end contract,
            coalesce(stu.n,0) students, coalesce(com.n,0) comms,
            coalesce(m.mb_recommend,0) recommend,               -- 유학원 등록실적 계산용
            coalesce(m.mb_11,0) weight,                         -- 유학원 비중 수치화
            case when coalesce(m.mb_leave_date,'') <> '' then 'leave'
                 when coalesce(m.mb_intercept_date,'') <> ''
                   or lower(coalesce(m.mb_memo_call,'')) = 'block' then 'block'
                 else 'normal' end status,
            coalesce(to_char(m.mb_datetime,'YYYY-MM-DD'),'') joined,
            coalesce(to_char(m.mb_today_login,'YYYY-MM-DD HH24:MI'),'') login,
            coalesce(m.mb_login_ip,'') ip,
            left(regexp_replace(coalesce(m.mb_memo,''), '\\s+', ' ', 'g'), 160) memo
       from cms.g4_member m
       left join stu on stu.a = lower(m.mb_id)
       left join com on com.a = lower(m.mb_id)${own}
      order by coalesce(m.mb_today_login, m.mb_datetime) desc nulls last, m.mb_no desc
      limit $1`, params);
  return rows.map((r) => ({ ...r, level: Number(r.level), students: Number(r.students),
    comms: Number(r.comms), recommend: Number(r.recommend), weight: Number(r.weight) }));
}

// ── handler 배선 (data.js) ──────────────────────────────────────────────────
// 1) const ALL_PARTS = [..., "members"];
// 2) parts 분기에 한 줄 추가:
//      if (parts.includes("members")) out.members = await loadMembers(q, scope);
// 3) 버전스탬프(loadStamp)에 회원 변경 감지 추가(선택). **mb_today_login 은 절대 넣지 말 것** —
//    stamp 는 전역(모든 parts 공용 ETag·캐시키)이라 회원이 로그인할 때마다 값이 바뀌면
//    학생·배치도 등 무거운 조각까지 전부 캐시가 깨진다. 신규가입만 감지하는 아래 한 줄이면 충분하다:
//      coalesce((select max(mb_no) from cms.g4_member)::text,'') mb_max
//    (기존 stamp select 목록 끝에 추가 + return 객체에 mb_max: r.mb_max)
//    회원목록은 거의 안 바뀌므로 LIVE.ttls.members = 300000(5분) 로 두면 충분하다.
