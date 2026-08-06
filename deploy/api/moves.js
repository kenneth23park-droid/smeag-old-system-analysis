// ============================================================================
// /api/moves — 기숙사 방 이동 관리 API (Supabase Postgres 직접, PHP 없음)
// ----------------------------------------------------------------------------
// 기획: docs/기획_방이동관리_2026-08-06.md
// DB 계층: migration/schema/room_moves.sql · room_facts.sql · room_validate.sql · room_move_rpc.sql
//
// 라우팅(단일 함수):
//   GET  /api/moves?from=&to=&status=&s_idx=        → 이동 목록(status: ALL|OPEN|APPROVE|REVIEW|…)
//   GET  /api/moves?op=validate&s_idx=&to_r_idx=&at=&end_date=
//   GET  /api/moves?op=timeline&r_idx=&from=&to=    → 침대 타임라인(§10)
//   GET  /api/moves?op=history&s_idx=               → 학생 이동 이력(§15)
//   GET  /api/moves?op=facts&s_idx=                 → 체류 확정정보(결측 칸 확인용)
//   POST /api/moves {op:'create',   ...,  idem}
//   POST /api/moves {op:'confirm'|'cancel'|'complete', move_id}
//   POST /api/moves {op:'approve'|'reject', move_id}   ← Lv10+ 전용(예외 승인)
//   POST /api/moves {op:'facts', s_idx, patch}
//
// 권한(결정 5, 2026-08-06):
//   · 조회·등록·확정·취소·완료 = Lv8+
//   · 예외 승인/반려          = Lv10+  (RPC 안에서도 p_level 로 다시 검증한다)
//   유효권한 = max(세션 mb_level, app.member_level_override) — /api/data 와 같은 규약.
//
// 안전장치(기존 blocks.js·edit.js 규약과 동일):
//   · 로그인 세션 필수 · 멱등키(idem) 로 더블서밋 차단 · 화이트리스트 밖 입력은 무시
//   · 원본 MySQL 및 legacy/cms 데이터 불변. 쓰기는 app 스키마에만 일어난다.
//     (기존 방 배정 "종료"도 원본을 자르지 않고 app.assignment_terminations 에 기록한다)
//
// 필요 환경변수(Vercel): PG_HOST PG_PORT PG_DB PG_USER PG_PASS AUTH_SESSION_SECRET
// ============================================================================
import crypto from "node:crypto";
import pg from "pg";

const SECRET = process.env.AUTH_SESSION_SECRET || "CHANGE_ME_dev_only_secret";
const COOKIE = "sme_session";
const WRITE_MIN_LEVEL = 8;      // 이동 등록·확정·취소·완료
const APPROVE_MIN_LEVEL = 10;   // 예외 승인·반려 (DB 의 app.room_move_approver_level() 과 같은 값)

const PG = {
  host: process.env.PG_HOST,
  port: Number(process.env.PG_PORT || 5432),
  database: process.env.PG_DB || "postgres",
  user: process.env.PG_USER,
  password: process.env.PG_PASS,
  ssl: { rejectUnauthorized: false },
  statement_timeout: 20000,
};

let shared = null;
async function getClient() {
  if (shared) {
    try { await shared.query("select 1"); return shared; }
    catch { try { await shared.end(); } catch { /* noop */ } shared = null; }
  }
  const c = new pg.Client(PG);
  c.on("error", () => { shared = null; });
  await c.connect();
  shared = c;
  return c;
}
async function rpc(sql, params) {
  const c = await getClient();
  const { rows } = await c.query(sql, params);
  return rows[0] ? rows[0].r : null;
}

// ── 세션(JWT HS256) — /api/auth 와 동일 규약 ─────────────────────────────────
function readCookie(req, name) {
  const raw = req.headers.cookie || "";
  for (const part of raw.split(";")) {
    const i = part.indexOf("=");
    if (i < 0) continue;
    if (part.slice(0, i).trim() === name) return decodeURIComponent(part.slice(i + 1).trim());
  }
  return null;
}
function verifySession(token) {
  try {
    const [p1, p2, p3] = String(token).split(".");
    if (!p1 || !p2 || !p3) return null;
    const expected = crypto.createHmac("sha256", SECRET).update(`${p1}.${p2}`).digest("base64url");
    const a = Buffer.from(p3), b = Buffer.from(expected);
    if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;
    const body = JSON.parse(Buffer.from(p2, "base64url").toString("utf8"));
    if (typeof body.exp === "number" && body.exp < Math.floor(Date.now() / 1000)) return null;
    return body;
  } catch { return null; }
}
// 유효권한: 세션 레벨과 신전산 오버라이드 중 큰 값(레거시 실무자 다수가 Lv7 이라 필요).
async function effectiveLevel(session) {
  const base = Number(session.mb_level || 0);
  try {
    const c = await getClient();
    const { rows } = await c.query("select app.member_level_of($1) lv", [String(session.mb_id || "")]);
    return Math.max(base, Number((rows[0] && rows[0].lv) || 0));
  } catch { return base; }
}

// ── 입력 정규화 ──────────────────────────────────────────────────────────────
const isYmd = (s) => /^\d{4}-\d{2}-\d{2}$/.test(String(s || ""));
const dateOrNull = (s) => (isYmd(s) ? s : null);
const intOrNull = (s) => (/^\d{1,12}$/.test(String(s || "")) ? Number(s) : null);
const S = (v, n) => (v == null ? null : String(v).slice(0, n || 500) || null);
const STATUSES = new Set(["ALL", "OPEN", "APPROVE", "REVIEW", "PLANNED", "CONFIRMED", "COMPLETED", "CANCELLED"]);
// 체류 확정정보에서 받을 칸(그 외는 조용히 버린다 — RPC 안에서도 다시 검증한다)
const FACT_KEYS = new Set(["graduation_date", "actual_checkout_date", "checkout_time", "arrival_at",
  "pickup_confirmed", "gender_confirmed", "requested_room_type", "note"]);
function pickFacts(raw) {
  if (!raw || typeof raw !== "object") return null;
  const out = {};
  for (const [k, v] of Object.entries(raw)) if (FACT_KEYS.has(k)) out[k] = v === "" ? null : v;
  return Object.keys(out).length ? out : null;
}

async function readBody(req) {
  if (req.body && typeof req.body === "object") return req.body;
  const chunks = [];
  for await (const c of req) chunks.push(c);
  const raw = Buffer.concat(chunks).toString("utf8");
  if (!raw) return {};
  try { return JSON.parse(raw); } catch { return null; }
}

// ── 핸들러 ───────────────────────────────────────────────────────────────────
export default async function handler(req, res) {
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.setHeader("Cache-Control", "no-store");

  const session = verifySession(readCookie(req, COOKIE));
  if (!session) {
    return res.status(401).json({ ok: false, error: "no_session",
      message: "로그인 세션이 없습니다. 다시 로그인하세요." });
  }
  const level = await effectiveLevel(session);
  // 이동 원장은 전 캠퍼스 방·침대·학생 구성을 드러내므로 조회도 직원 권한이 필요하다.
  if (level < WRITE_MIN_LEVEL) {
    return res.status(403).json({ ok: false, error: "forbidden",
      message: "방 이동 관리 권한이 없습니다. 담당 매니저에게 요청하세요." });
  }
  const actor = String(session.mb_id || "").slice(0, 40) || "unknown";

  try {
    // ── 조회 ────────────────────────────────────────────────────────────────
    if (req.method === "GET") {
      const url = new URL(req.url, "http://x");
      const op = url.searchParams.get("op") || "list";

      if (op === "validate") {
        const sIdx = intOrNull(url.searchParams.get("s_idx"));
        const toBed = intOrNull(url.searchParams.get("to_r_idx"));
        const at = url.searchParams.get("at");
        if (!sIdx || !toBed || !at) {
          return res.status(400).json({ ok: false, error: "bad_request",
            message: "학생·대상 침대·이동 예정일시가 필요합니다." });
        }
        const r = await rpc(
          "select app.room_move_validate($1::int,$2::int,$3::timestamptz,$4::date) as r",
          [sIdx, toBed, at, dateOrNull(url.searchParams.get("end_date"))]);
        return res.status(200).json({ ok: true, level, validate: r });
      }

      if (op === "timeline") {
        const bed = intOrNull(url.searchParams.get("r_idx"));
        if (!bed) return res.status(400).json({ ok: false, error: "bad_request" });
        const r = await rpc("select app.bed_timeline($1::int,$2::date,$3::date) as r",
          [bed, dateOrNull(url.searchParams.get("from")), dateOrNull(url.searchParams.get("to"))]);
        return res.status(200).json({ ok: true, timeline: r });
      }

      if (op === "history") {
        const sIdx = intOrNull(url.searchParams.get("s_idx"));
        if (!sIdx) return res.status(400).json({ ok: false, error: "bad_request" });
        const r = await rpc("select app.room_move_history($1::int) as r", [sIdx]);
        return res.status(200).json({ ok: true, history: r });
      }

      if (op === "facts") {
        const sIdx = intOrNull(url.searchParams.get("s_idx"));
        if (!sIdx) return res.status(400).json({ ok: false, error: "bad_request" });
        const c = await getClient();
        const { rows } = await c.query("select to_jsonb(v) r from app.v_student_stay v where v.s_idx = $1", [sIdx]);
        return res.status(200).json({ ok: true, facts: rows[0] ? rows[0].r : null });
      }

      // 기본: 목록
      const st = String(url.searchParams.get("status") || "OPEN").toUpperCase();
      const r = await rpc("select app.room_move_list($1::date,$2::date,$3,$4::int,$5::int) as r", [
        dateOrNull(url.searchParams.get("from")),
        dateOrNull(url.searchParams.get("to")),
        STATUSES.has(st) ? st : "OPEN",
        intOrNull(url.searchParams.get("s_idx")),
        intOrNull(url.searchParams.get("limit")) || 500,
      ]);
      return res.status(200).json({ ok: true, level,
        canApprove: level >= APPROVE_MIN_LEVEL, moves: r });
    }

    if (req.method !== "POST") {
      res.setHeader("Allow", "GET, POST");
      return res.status(405).json({ ok: false, error: "method_not_allowed" });
    }

    // ── 쓰기 ────────────────────────────────────────────────────────────────
    const body = await readBody(req);
    if (!body) return res.status(400).json({ ok: false, error: "bad_json" });
    const op = String(body.op || "");
    const idem = body.idem == null ? null
      : String(body.idem).replace(/[^\w:.-]/g, "").slice(0, 80) || null;
    const moveId = intOrNull(body.move_id);

    if (op === "facts") {
      const sIdx = intOrNull(body.s_idx);
      const patch = pickFacts(body.patch);
      if (!sIdx || !patch) return res.status(400).json({ ok: false, error: "bad_request" });
      const r = await rpc("select app.stay_facts_set($1::int,$2::jsonb,$3) as r",
        [sIdx, JSON.stringify(patch), actor]);
      return res.status(r && r.ok === false ? 400 : 200).json(r);
    }

    if (op === "create") {
      const payload = {
        s_idx: intOrNull(body.s_idx),
        to_r_idx: intOrNull(body.to_r_idx),
        planned_move_at: S(body.planned_move_at, 40),
        end_date: dateOrNull(body.end_date),
        move_reason: S(body.move_reason, 200),
        note: S(body.note, 1000),
        priority: intOrNull(body.priority),
        depends_on_move_id: intOrNull(body.depends_on_move_id),
        vehicle: S(body.vehicle, 100),
        staff: S(body.staff, 100),
        exception_reason: S(body.exception_reason, 500),
      };
      const facts = pickFacts(body.facts);
      if (facts) payload.facts = facts;
      if (!payload.s_idx || !payload.to_r_idx || !payload.planned_move_at) {
        return res.status(400).json({ ok: false, error: "bad_request",
          message: "학생·대상 침대·이동 예정일시는 필수입니다." });
      }
      const r = await rpc("select app.room_move_create($1::jsonb,$2,$3::int,$4) as r",
        [JSON.stringify(payload), actor, level, idem]);
      return res.status(r && r.ok === false ? 400 : 200).json(r);
    }

    if (!moveId) return res.status(400).json({ ok: false, error: "bad_request", message: "move_id 가 필요합니다." });

    if (op === "confirm") {
      const r = await rpc("select app.room_move_confirm($1::bigint,$2,$3::int) as r", [moveId, actor, level]);
      return res.status(r && r.ok === false ? 400 : 200).json(r);
    }
    if (op === "complete") {
      const r = await rpc("select app.room_move_complete($1::bigint,$2,$3::int,$4::timestamptz) as r",
        [moveId, actor, level, S(body.actual_move_at, 40)]);
      return res.status(r && r.ok === false ? 400 : 200).json(r);
    }
    if (op === "cancel") {
      // 취소는 삭제가 아니다 — 상태 전이(CANCELLED)로 이력을 남긴다. 그래서 비밀번호 재확인 대상이 아니다.
      const r = await rpc("select app.room_move_cancel($1::bigint,$2,$3::int,$4) as r",
        [moveId, actor, level, S(body.reason, 500)]);
      return res.status(r && r.ok === false ? 400 : 200).json(r);
    }
    if (op === "approve" || op === "reject") {
      if (level < APPROVE_MIN_LEVEL) {
        return res.status(403).json({ ok: false, error: "forbidden",
          message: `예외 ${op === "approve" ? "승인" : "반려"}은 Lv${APPROVE_MIN_LEVEL} 이상만 가능합니다.` });
      }
      const fn = op === "approve" ? "room_move_approve" : "room_move_reject";
      const r = await rpc(`select app.${fn}($1::bigint,$2,$3::int,$4) as r`,
        [moveId, actor, level, S(op === "approve" ? body.note : body.reason, 500)]);
      return res.status(r && r.ok === false ? 400 : 200).json(r);
    }

    return res.status(400).json({ ok: false, error: "bad_op" });
  } catch (e) {
    shared = null;
    console.error("[/api/moves]", (e && e.message) || e);
    return res.status(500).json({ ok: false, error: "server_error",
      message: "처리에 실패했습니다. 잠시 후 다시 시도하세요." });
  }
}
