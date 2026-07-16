# 레거시 SMEAG 시스템 로컬 구동 (PHP + MySQL)

목표: 백업 덤프로 **DB 복원** + **조회용 PHP 앱**을 로컬에서 즉시 띄운다.

> 이미 준비됨: `backup/`(덤프 복사됨), `src/`(조회 앱), `config/`(설정·Dockerfile).
> 남은 건 **런타임(Docker) 설치 → 기동 → import** 3단계뿐.

## 0. Docker 설치 (1회, 관리자 권한 필요 → 직접 실행)
```bash
# Homebrew 없으면 먼저:
/bin/bash -c "$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)"
# Docker Desktop:
brew install --cask docker
open -a Docker          # 최초 1회 실행/권한 승인 (고래 아이콘이 안정되면 준비완료)
```

## 1. DB + phpMyAdmin 기동
```bash
cd "/Users/kwangseobpark/smeag-old-system-analysis"
docker compose up -d db pma
docker compose logs -f db    # "ready for connections" 뜨면 Ctrl+C
```

## 2. 덤프 import (⚠️ 37%가 0000-00-00 → legacy.cnf 의 sql_mode='' 가 처리)
```bash
docker exec -i smeag-legacy-db \
  mysql -uroot -prootpass sunjae2117 < backup/sunjae2117_backup2.sql
```
> 228MB → 수 분 소요. 검증:
```bash
docker exec -it smeag-legacy-db \
  mysql -uroot -prootpass -e "USE sunjae2117; SHOW TABLES; SELECT COUNT(*) FROM room_reserve;"
```

## 3. 웹 앱 기동 (첫 실행은 mysqli 설치 위해 빌드 → 수 분)
```bash
docker compose up -d --build web
```

## 4. 접속
| 서비스 | 주소 | 계정 |
|--------|------|------|
| **조회 앱** | http://localhost:8000 | - |
| phpMyAdmin | http://localhost:8080 | 서버 `db` / root / rootpass |

조회 앱 기능: 테이블 전환(room_reserve/2026), 통계 카드(유형·건물·날짜범위),
학생번호(s_idx) 검색, 50건 페이지네이션. (prepared statement 로 SQL인젝션 방지)

---

## ⚠️ 제약 (반드시 확인)
1. **부분 덤프**: 이 백업엔 예약 테이블 2개뿐(`room_reserve`, `room_reserve_2026`).
   회원·객실·건물 **마스터 테이블이 없어** 원본 앱 전체 기능은 불가.
   → 조회 앱은 예약 데이터만으로 동작하도록 만들어 둠. 전체 구동은 **전체 DB 덤프** 필요.
2. **원본 PHP 소스 부재**: `src/` 의 앱은 데이터 확인용으로 새로 작성한 것.
   원본 소스를 확보하면 `src/` 내용을 교체하면 됨(DB 접속은 db.php 환경변수 사용).
3. PHP 5.6 은 amd64 전용 → Apple Silicon 에선 에뮬레이션이라 느림.

## 정지 / 초기화
```bash
docker compose down       # 정지(데이터 유지)
docker compose down -v     # DB 데이터까지 삭제
```
