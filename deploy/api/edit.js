// ============================================================================
// /api/edit — 행정팀 입력 저장 API (Supabase Postgres 직접, PHP 없음)
// ----------------------------------------------------------------------------
// 행정팀 회신(2026-07-30) 반영:
//   Q-8 → 변경환불 접수의 **약속기한(DUE)** 을 앞으로 입력한다 → 저장 경로 필요
//         + 처리결과(RESULT) 확정 전이(종결→종결은 확인 필요)
//   Q-9 → 센터수납 **달러/페소 분할납부**를 구조화(2칸 + 행 추가)로 저장
//
// DB 계층: migration/schema/admin_edits.sql
//   app.student_change_set(p_key,p_idx,p_patch,p_by,p_force)
//   app.center_pay_set(p_key,p_sidx,p_patch,p_splits,p_by)
//   app.center_pay_split_list(p_sidx)
//
// 라우팅(단일 함수):
//   GET  /api/edit?op=splits&sidx=123                → 분할납부 내역
//   POST /api/edit {op:'chgref', idx, patch:{...}, idem, force?}
//   POST /api/edit {op:'centerpay', sidx, patch:{...}, splits:[...], idem}
//
// 안전장치(기존 blocks.js·write_layer 규약과 동일):
//   · 로그인 세션 필수, 쓰기는 Lv8 이상
//   · 멱등키(idem) — 같은 키 재요청은 최초 결과 재생(중복 저장 없음)
//   · 화이트리스트 컬럼만 반영(RPC 내부에서 재검증) · PK 는 WHERE 로만
//   · 저장 시 app.change_log 기록 → 구전산 역방향 일일동기화가 집어감
//   · 원본 MySQL 불변. 여기 쓰기는 Supabase 내부에만 일어난다.
//
// 필요 환경변수(Vercel): PG_HOST PG_PORT PG_DB PG_USER PG_PASS [AUTH_SESSION_SECRET]
// ============================================================================
import crypto from "node:crypto";
import pg from "pg";

const SECRET = process.env.AUTH_SESSION_SECRET || "CHANGE_ME_dev_only_secret";
const COOKIE = "sme_session";
const WRITE_MIN_LEVEL = 8;
const MAX_SPLITS = 20;             // 분할납부 행 상한(입력 폭주 방지)

const PG = {
  host: process.env.PG_HOST,
  port: Number(process.env.PG_PORT || 5432),
  database: process.env.PG_DB || "postgres",
  user: process.env.PG_USER,
  password: process.env.PG_PASS,
  ssl: { rejectUnauthorized: false },
  statement_timeout: 15000,
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
  return rows[0].r;
}

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

async function readBody(req) {
  if (req.body && typeof req.body === "object") return req.body;
  const chunks = [];
  for await (const c of req) chunks.push(c);
  const raw = Buffer.concat(chunks).toString("utf8");
  if (!raw) return {};
  try { return JSON.parse(raw); } catch { return null; }
}

const isYmd = (s) => /^\d{4}-\d{2}-\d{2}$/.test(String(s || ""));
const S = (v, n) => String(v == null ? "" : v).slice(0, n);

// 화이트리스트 — RPC 에서도 재검증하지만 여기서 1차로 걸러 불필요한 왕복을 줄인다.
const CHGREF_COLS = new Set(["info_due_date", "info_process", "info_result", "info_complete_date"]);
const CPAY_COLS = new Set(["pay_status", "pay_channel", "exchange_date", "exchange_rate",
  "center_pay_amount", "center_pay_unit", "center_pay_date", "center_pay_memo"]);
const UNITS = new Set(["dollor", "peso", "won", "usd"]);
const RESULTS = new Set(["", "center", "account", "collection", "refund", "holding", "cancel"]);

// 회원정보 수정 허용 칸(레거시 member_form.php 입력칸) — RPC 내부에서 다시 검증한다.
// 제외: mb_id(PK) · mb_password · mb_jumin · mb_password_q/a · mb_lost_certify · mb_point
const MEMBER_COLS = new Set(["mb_level", "mb_name", "mb_nick", "mb_email", "mb_homepage",
  "mb_tel", "mb_hp", "mb_zip1", "mb_zip2", "mb_addr1", "mb_addr2", "mb_birth", "mb_sex",
  "mb_mailling", "mb_sms", "mb_open", "mb_signature", "mb_profile", "mb_memo",
  "mb_leave_date", "mb_intercept_date",
  "mb_1", "mb_2", "mb_3", "mb_4", "mb_5", "mb_6", "mb_7", "mb_8", "mb_9", "mb_10", "mb_11"]);

// ── 삭제 재인증(confirm) 검증 ───────────────────────────────────────────────
// 정책(2026-08-03): 삭제 작업은 모든 환경에서 로그인 비밀번호를 다시 묻는다.
// /api/auth {action:'confirm', password} 가 발급한 5분짜리 토큰을 검증한다.
// (서버리스 함수끼리 모듈을 공유하지 않아 blocks.js 와 같은 사본을 둔다.)
function verifyConfirm(token, mb_id, purpose) {
  try {
    const [p, sig] = String(token || "").split(".");
    if (!p || !sig) return false;
    const expected = crypto.createHmac("sha256", SECRET).update(p).digest("base64url");
    const a = Buffer.from(sig), b = Buffer.from(expected);
    if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return false;
    const body = JSON.parse(Buffer.from(p, "base64url").toString("utf8"));
    if (body.typ !== "confirm") return false;
    if (String(body.sub || "") !== String(mb_id || "")) return false;
    if (String(body.pur || "") !== String(purpose || "delete")) return false;
    return Number(body.exp) > Math.floor(Date.now() / 1000);
  } catch { return false; }
}
// 삭제성 요청인가 — op 이름이 delete 로 끝나거나 body.del===true 면 재인증을 요구한다.
const isDeleteOp = (body) => body.del === true || /(^|_)delete$/i.test(String(body.op || ""));

function pickPatch(raw, allow, max = 250) {
  const out = {};
  if (!raw || typeof raw !== "object") return out;
  for (const [k, v] of Object.entries(raw)) {
    if (!allow.has(k)) continue;
    out[k] = S(v, max);
  }
  return out;
}
function normSplits(raw) {
  if (!Array.isArray(raw)) return null;
  const out = [];
  for (const it of raw) {
    if (!it || typeof it !== "object") continue;
    const unit = String(it.unit || "peso").toLowerCase();
    if (!UNITS.has(unit)) continue;
    const amt = Number(String(it.amount == null ? "" : it.amount).replace(/[^0-9.]/g, ""));
    if (!Number.isFinite(amt) || amt < 0) continue;
    if (amt === 0 && !S(it.note, 1)) continue;                 // 빈 행은 버린다
    out.push({
      unit, amount: amt, note: S(it.note, 120),
      pay_date: isYmd(it.pay_date) ? it.pay_date : null,
    });
    if (out.length >= MAX_SPLITS) break;
  }
  return out;
}

export default async function handler(req, res) {
  res.setHeader("Cache-Control", "no-store");
  res.setHeader("Content-Type", "application/json; charset=utf-8");

  const session = verifySession(readCookie(req, COOKIE));
  if (!session) {
    res.statusCode = 401;
    return res.end(JSON.stringify({ ok: false, error: "no_session",
      message: "로그인 세션이 없습니다. 다시 로그인하세요." }));
  }
  const actor = S(session.mb_id, 40) || "admin";
  // 유효권한 = max(세션 레벨, app.member_level_override) — 레거시 g4_member 무변경(data.js 와 동일 규칙)
  let level = Number(session.mb_level || 0);
  try {
    const c = await getClient();
    const { rows } = await c.query(`select app.member_level_of($1) lv`, [actor]);
    level = Math.max(level, Number((rows[0] && rows[0].lv) || 0));
  } catch (_) { /* 오버라이드 테이블 없음 → 세션 레벨 그대로 */ }

  try {
    // ── 조회: 분할납부 내역 ────────────────────────────────────────────────
    if (req.method === "GET") {
      const url = new URL(req.url, "http://x");
      if (url.searchParams.get("op") !== "splits") {
        res.statusCode = 400;
        return res.end(JSON.stringify({ ok: false, error: "bad_op" }));
      }
      const sidx = Number(url.searchParams.get("sidx"));
      if (!Number.isFinite(sidx)) {
        res.statusCode = 400;
        return res.end(JSON.stringify({ ok: false, error: "bad_sidx" }));
      }
      const r = await rpc("select app.center_pay_split_list($1::bigint) as r", [sidx]);
      return res.end(JSON.stringify({ ok: true, sidx, splits: r }));
    }

    if (req.method !== "POST") {
      res.statusCode = 405;
      res.setHeader("Allow", "GET, POST");
      return res.end(JSON.stringify({ ok: false, error: "method_not_allowed" }));
    }
    if (level < WRITE_MIN_LEVEL) {
      res.statusCode = 403;
      return res.end(JSON.stringify({ ok: false, error: "forbidden",
        message: `저장 권한이 없습니다(Lv${level} < Lv${WRITE_MIN_LEVEL}).` }));
    }

    const body = await readBody(req);
    if (!body) {
      res.statusCode = 400;
      return res.end(JSON.stringify({ ok: false, error: "bad_json" }));
    }
    // 삭제성 요청은 로그인 비밀번호 재확인 토큰이 있어야 한다(정책 2026-08-03).
    if (isDeleteOp(body) && !verifyConfirm(body.confirm, session.mb_id, "delete")) {
      res.statusCode = 403;
      return res.end(JSON.stringify({ ok: false, error: "need_password",
        message: "삭제하려면 로그인 비밀번호를 다시 입력해야 합니다." }));
    }
    const idem = S(body.idem, 120);
    if (!idem) {
      res.statusCode = 400;
      return res.end(JSON.stringify({ ok: false, error: "no_idem",
        message: "멱등키(idem)가 필요합니다 — 중복 저장 방지용." }));
    }

    // ── Q-8: 변경환불 접수 수정(DUE·RESULT·완료일) ─────────────────────────
    if (body.op === "chgref") {
      const idx = Number(body.idx);
      if (!Number.isFinite(idx)) {
        res.statusCode = 400;
        return res.end(JSON.stringify({ ok: false, error: "bad_idx" }));
      }
      const patch = pickPatch(body.patch, CHGREF_COLS);
      if (!Object.keys(patch).length) {
        res.statusCode = 400;
        return res.end(JSON.stringify({ ok: false, error: "empty_patch",
          message: "저장할 값이 없습니다(허용: DUE·PROCESS·RESULT·COMPLETE)." }));
      }
      if (patch.info_due_date != null && patch.info_due_date !== "" && !isYmd(patch.info_due_date)) {
        res.statusCode = 400;
        return res.end(JSON.stringify({ ok: false, error: "bad_date",
          message: "약속기한 형식은 YYYY-MM-DD 입니다." }));
      }
      if (patch.info_result != null && !RESULTS.has(patch.info_result)) {
        res.statusCode = 400;
        return res.end(JSON.stringify({ ok: false, error: "bad_result" }));
      }
      const r = await rpc(
        "select app.student_change_set($1,$2::bigint,$3::jsonb,$4,$5) as r",
        [idem, idx, JSON.stringify(patch), actor, body.force === true]);
      if (r && r.ok === false && r.error !== "need_confirm") res.statusCode = 400;
      return res.end(JSON.stringify(r));
    }

    // ── Q-9: 센터수납(합계 + 달러/페소 분할내역) ───────────────────────────
    if (body.op === "centerpay") {
      const sidx = Number(body.sidx);
      if (!Number.isFinite(sidx)) {
        res.statusCode = 400;
        return res.end(JSON.stringify({ ok: false, error: "bad_sidx" }));
      }
      const patch = pickPatch(body.patch, CPAY_COLS);
      const splits = normSplits(body.splits);
      if (!Object.keys(patch).length && splits == null) {
        res.statusCode = 400;
        return res.end(JSON.stringify({ ok: false, error: "empty_patch",
          message: "저장할 값이 없습니다." }));
      }
      for (const k of ["exchange_date", "center_pay_date"]) {
        if (patch[k] && !isYmd(patch[k])) {
          res.statusCode = 400;
          return res.end(JSON.stringify({ ok: false, error: "bad_date",
            message: `${k} 형식은 YYYY-MM-DD 입니다.` }));
        }
      }
      if (patch.center_pay_unit && !UNITS.has(String(patch.center_pay_unit).toLowerCase())) {
        res.statusCode = 400;
        return res.end(JSON.stringify({ ok: false, error: "bad_unit" }));
      }
      const r = await rpc(
        "select app.center_pay_set($1,$2::bigint,$3::jsonb,$4::jsonb,$5) as r",
        [idem, sidx, JSON.stringify(patch), splits == null ? null : JSON.stringify(splits), actor]);
      if (r && r.ok === false) res.statusCode = 400;
      return res.end(JSON.stringify(r));
    }

    // ── 회원정보 수정(레거시 member_form.php) ─────────────────────────────
    // 레거시 원본 cms.g4_member 는 건드리지 않는다 — app.member_edits 오버레이 + change_log.
    // 권한(mb_level)만은 기존 app.member_level_override 로 흘러간다(RPC 내부 분기).
    if (body.op === "member") {
      const id = S(body.id, 40);
      if (!id) {
        res.statusCode = 400;
        return res.end(JSON.stringify({ ok: false, error: "bad_id", message: "회원아이디가 필요합니다." }));
      }
      const patch = pickPatch(body.patch, MEMBER_COLS, 4000);
      if (!Object.keys(patch).length) {
        res.statusCode = 400;
        return res.end(JSON.stringify({ ok: false, error: "empty_patch", message: "저장할 값이 없습니다." }));
      }
      for (const k of ["mb_leave_date", "mb_intercept_date"]) {
        if (patch[k] && !isYmd(patch[k])) {
          res.statusCode = 400;
          return res.end(JSON.stringify({ ok: false, error: "bad_date",
            message: `${k} 형식은 YYYY-MM-DD 입니다.` }));
        }
      }
      if (patch.mb_level && !/^([1-9]|10)$/.test(patch.mb_level)) {
        res.statusCode = 400;
        return res.end(JSON.stringify({ ok: false, error: "bad_level", message: "권한은 1~10 입니다." }));
      }
      const r = await rpc("select app.member_edit_set($1,$2,$3::jsonb,$4) as r",
        [idem, id, JSON.stringify(patch), actor]);
      if (r && r.ok === false) res.statusCode = 400;
      return res.end(JSON.stringify(r));
    }

    res.statusCode = 400;
    return res.end(JSON.stringify({ ok: false, error: "bad_op",
      message: "op 은 chgref | centerpay | member 중 하나입니다." }));
  } catch (e) {
    shared = null;
    res.statusCode = 500;
    return res.end(JSON.stringify({ ok: false, error: "server_error",
      message: "저장에 실패했습니다. 잠시 후 다시 시도하세요.",
      detail: String((e && e.message) || e).slice(0, 200) }));
  }
}
