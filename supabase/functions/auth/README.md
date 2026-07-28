# auth — Supabase 네이티브 로그인 (PHP 대체)

레거시 계정(아이디/비밀번호)으로 로그인하는 **Edge Function**. PHP·Docker 불필요.
검증은 DB RPC `app.member_authenticate`(레이트리밋 15분·10회 + IP로깅, service_role 전용),
세션은 이 함수가 발급하는 **httpOnly·Secure 쿠키 JWT**(위조 불가).

## 구성

| 파일 | 역할 |
|---|---|
| `index.ts` | 라우팅·화면·검증·세션 (의존성 0, Web Crypto만) |
| `../../config.toml` | `verify_jwt=false` (공개 로그인) |
| `migration/schema/member_auth_edge.sql` | 검증 RPC (적용·테스트 완료) |

## 라우팅

| 메서드 | 요청 | 동작 |
|---|---|---|
| GET | `/` | 세션 있으면 랜딩, 없으면 로그인 폼 |
| POST | `action=login` | 검증 → 쿠키 발급 → 303 리다이렉트 |
| POST | `action=logout` | 쿠키 파기 → 303 |
| GET | `?me` | 세션 JSON (프론트 연동용) |

## 배포 (한 번만, 로컬에 Supabase CLI 필요)

```bash
# 1) CLI 설치 (택1)
brew install supabase/tap/supabase        # macOS

# 2) 로그인 & 프로젝트 연결
supabase login
supabase link --project-ref bauhnnpioaephlwurxzg

# 3) 세션 서명 비밀키 설정 (길고 랜덤하게)
supabase secrets set AUTH_SESSION_SECRET="$(openssl rand -hex 32)"
#    SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY 는 자동 주입됨(설정 불필요)

# 4) 배포 (공개 로그인이라 JWT 검증 끔)
supabase functions deploy auth --no-verify-jwt
```

배포 후 접속 주소:
```
https://bauhnnpioaephlwurxzg.supabase.co/functions/v1/auth
```

## 검증 완료 (DB 계층)

- 로그인 성공: `cebusme00/1234`(g4_member Lv10), `admin1/admin1`(admin_users bcrypt)
- 실패 거부: 오답·빈값·없는 계정
- 레이트리밋: 동일 IP 10회 실패 → 잠금(정답도 차단), 다른 IP 정상, 15분 후 해제

## 남은 보안 과제 (배포 전 결정)

- **약한 비밀번호**: `1234`·`1@1.1` 다수 → 관리자(Lv8+) `must_change` 강제 권장(배선 기존재)
- 레이트리밋 창/횟수(현재 15분·10회)는 운영 관찰 후 조정

## 프론트 연동

실제 관리 화면(예약·학생·정산)은 `?me` 로 세션을 확인해 붙인다.
Cross-origin 앱이면 쿠키 대신 `?me` 응답의 JWT 를 Authorization 헤더로 전달하는 방식으로 확장.
