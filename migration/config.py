# -*- coding: utf-8 -*-
"""
이관 설정 & 매니페스트 (결정 A~E 인코딩).

원칙: 원본(MySQL 덤프 sql/*.sql)은 읽기 전용. 모든 변환은 Supabase(Postgres) 쪽에서만.
이 파일은 '무엇을/어디로/어떻게' 이관할지 선언만 한다. 실행은 orchestrator.py.
"""
import os

# ── 접속 (env 우선; 없으면 풀러 기본값). 비밀번호는 반드시 env/.env 로 주입 ──
PG = dict(
    host=os.getenv("PG_HOST", "aws-0-ap-northeast-1.pooler.supabase.com"),
    port=int(os.getenv("PG_PORT", "5432")),
    dbname=os.getenv("PG_DB", "postgres"),
    user=os.getenv("PG_USER", "postgres.bauhnnpioaephlwurxzg"),
    password=os.getenv("PG_PASS", ""),      # .env 에서 주입
    sslmode=os.getenv("PG_SSLMODE", "require"),
)

SQL_DIR = os.getenv("SQL_DIR", os.path.join(os.path.dirname(__file__), "..", "sql"))

# 병렬 워커 수 (풀러 세션 한도 고려: 과도하면 connection 초과)
MAX_WORKERS = int(os.getenv("MIG_WORKERS", "4"))
COPY_BATCH  = int(os.getenv("MIG_BATCH", "5000"))   # COPY 배치 행수

# ── 타깃 스키마 라우팅 ──
SCHEMA_LEGACY = "legacy"   # 원본 1:1 충실 이관(변환만) — 감사/롤백 근거
SCHEMA_CMS    = "cms"      # 그누보드 g4_* (결정 B)
SCHEMA_PUBLIC = "public"   # 정제·모델링 결과(dorm_* 등, 결정 A)

# ── (결정 D) 이관 제외: 임시/백업/테스트/중복/파생 ──
EXCLUDE_TABLES = {
    "room_info_test",          # 테스트 사본
    "room_elec_temp",          # 임시
    "room_elec_backup",        # 백업
    "room_move_ch",            # 작업본
    "course_copy",             # 사본
    "student_payment-new",     # 하이픈 작업본 (아래 RENAME 규칙도 참조)
    "student_payment_export",  # 내보내기 산출물
    "room_reserve_old",        # 2.8M 과거 스냅샷(정본은 reserve_info) — 감사시에만 별도 로드
}

# 검토 필요(기본 포함하되 로그로 경고) — 사용자 확정 전 주의
REVIEW_TABLES = {
    "course_info_new",   # course_info 의 신규 변형? 정본 확인 필요
    "room_reserve",      # 일자전개본(627k). 정본 reserve_info 와 중복 → legacy 로만 적재
}

# ── (결정 B) CMS 판별: g4_ 프리픽스 → cms 스키마 ──
def route_schema(table: str) -> str:
    if table.startswith("g4_"):
        return SCHEMA_CMS
    return SCHEMA_LEGACY

# ── (결정 6/식별자) 테이블/컬럼명 정규화: 하이픈 등 → 언더스코어 ──
RENAME_TABLES = {
    "student_payment-new": "student_payment_new",
}
def norm_ident(name: str) -> str:
    return RENAME_TABLES.get(name, name).replace("-", "_")

# ── (결정 C) 특수 핸들러: g4_score(1593컬럼) → EAV ──
#   1:1 리프트는 PG 1600 컬럼 한계에 근접해 위험 → 별도 SQL(schema/g4_score_eav.sql)로 정규화.
SPECIAL_TABLES = {
    "g4_score": "eav",   # 충실이관 스킵, 후처리 SQL 로 EAV 변환
}

# ── (결정 E) 개인정보 컬럼 패턴 → 마스킹/RLS 대상 ──
PII_COLUMN_PATTERNS = [
    "jumin", "password", "passwd", "passport", "tel", "hp", "phone",
    "email", "mb_1", "addr", "zip", "birth", "account", "card", "bank",
]
PII_TABLES = {
    "student_info", "student_info_history", "student_change",
    "student_info_invoice", "g4_member", "g4_score",
}

# ── (결정 3/4) 날짜/시간 정제 규칙 ──
ZERO_DATES = {"0000-00-00", "0000-00-00 00:00:00", "", "0000-00-00 00:00", " "}
# char/varchar 로 저장된 날짜 컬럼(이름 기반 힌트) → date 캐스팅 후보
DATE_LIKE_COLUMNS = ("_date", "s_date", "e_date", "rr_date", "birth", "mb_nick_date")

# ── 로드 순서 페이즈 (오케스트레이션 DAG) ──
#   phase 0: 스키마/도메인 마스터 준비(SQL)
#   phase 1: 대용량 독립 테이블 병렬 로드
#   phase 2: 나머지 업무 테이블 병렬 로드
#   phase 3: CMS(g4_*) 병렬 로드
#   phase 4: 모델링/제약/보안 후처리(SQL)
PHASE_BIG   = {"room_elec", "room_change_log", "room_move", "reserve_info",
               "reserve_info_history", "room_reserve",
               "student_info", "student_info_history", "student_info_invoice",
               "student_payment", "student_change", "g4_point", "zipcode"}
