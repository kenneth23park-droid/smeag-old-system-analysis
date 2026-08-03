// ============================================================================
// /api/blocks — 기숙사 방막기(Block) 공유 원장 API (Supabase Postgres 직접, PHP 없음)
// ----------------------------------------------------------------------------
// · 배치도/DORM LIST 의 "방막기"를 브라우저 localStorage 가 아니라 서버에 저장한다.
//   → 직원 A가 막은 방이 직원 B 화면에도 즉시 보인다(공유). 기간(from~to) 차단 지원.
// · DB 계층: migration/schema/room_blocks.sql  (app.room_block_list / _set / _release)
// · 원본 레거시 MySQL 은 물론 legacy/cms 스키마도 일절 건드리지 않는다(app 스키마 전용).
//
// 라우팅(단일 함수):
//   GET  /api/blocks?from=YYYY-MM-DD&to=YYYY-MM-DD   → 활성 블록 목록(기간 생략 시 전체)
//   POST /api/blocks  {op:'block',   items:[...], from,to, reason, memo, idem}
//   POST /api/blocks  {op:'release', items:[...], from,to}
//     items: [{room_key:'BX|CAPITAL1|415', bed_no:1, campus, group_name, room_no}]
//     bed_no 0 = 방 전체 / from,to 생략 = 무기한(기존 방막기와 동일 의미)
//
// 작성자(actor) 기록 — 구전산 room_move 에 작업자 기록이 없어 추적 불가했던 문제 대응:
//   ① /api/auth 세션 쿠키(JWT)가 있으면 그 사용자 → verified=true
//   ② 없으면 X-SME-User 헤더(클라이언트 로컬 세션) → verified=false 로 정직하게 표시
//   ③ 둘 다 없으면 'anonymous'
//   ※ 현재 사이트는 로그인 게이트가 꺼져 있어 ②가 기본 경로다. /api/auth 로그인을
//      다시 켜면 별도 수정 없이 ①로 승격된다.
//
// 필요 환경변수(Vercel): PG_HOST PG_PORT PG_DB PG_USER PG_PASS [AUTH_SESSION_SECRET]
// ============================================================================
import crypto from "node:crypto";
import pg from "pg";

const SECRET = process.env.AUTH_SESSION_SECRET || "CHANGE_ME_dev_only_secret";
const COOKIE = "sme_session";
const MAX_ITEMS = 2000;        // 한 요청에 처리할 방/침대 상한(드래그 폭주 방지)

const PG = {
  host: process.env.PG_HOST,
  port: Number(process.env.PG_PORT || 5432),
  database: process.env.PG_DB || "postgres",
  user: process.env.PG_USER,
  password: process.env.PG_PASS,
  ssl: { rejectUnauthorized: false },
  statement_timeout: 15000,
};

// ── 커넥션 재사용(warm 인스턴스 동안) ────────────────────────────────────────
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

// ── 세션(있으면 사용, 없으면 헤더 폴백) ─────────────────────────────────────
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
// 작성자(actor)는 **서버 세션에서만** 얻는다. 클라이언트가 보내는 X-SME-User 헤더는 위조가
// 가능하므로 더 이상 신뢰하지 않는다(무시). 세션이 없으면 호출 자체가 401 로 끊긴다.
// /api/auth 세션 클레임: { mb_id, mb_name, mb_level, ... }
function actorOf(session) {
  return { name: String(session.mb_id || "").slice(0, 40), verified: true };
}
const WRITE_MIN_LEVEL = 8;   // 방막기 쓰기는 내부 운영 권한(관리자/매니저)만

// ── 입력 정규화 ──────────────────────────────────────────────────────────────
const isYmd = (s) => /^\d{4}-\d{2}-\d{2}$/.test(String(s || ""));
const dateOrNull = (s) => (isYmd(s) ? s : null);
const REASONS = new Set(["MAINT", "CLEAN", "HOLD", "ETC"]);

function normItems(raw) {
  if (!Array.isArray(raw)) return [];
  const out = [], seen = new Set();
  for (const it of raw) {
    if (!it || typeof it !== "object") continue;
    if (it.id != null && Number.isFinite(Number(it.id))) { out.push({ id: Number(it.id) }); continue; }
    const key = String(it.room_key || "").trim().slice(0, 120);
    if (!key) continue;
    const bed = Math.max(0, Math.min(99, Number(it.bed_no) || 0));
    const dedup = key + "#" + bed;
    if (seen.has(dedup)) continue;
    seen.add(dedup);
    out.push({
      room_key: key,
      bed_no: bed,
      campus: String(it.campus || "").slice(0, 40),
      group_name: String(it.group_name || "").slice(0, 60),
      room_no: String(it.room_no || "").slice(0, 40),
    });
    if (out.length >= MAX_ITEMS) break;
  }
  return out;
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
  res.setHeader("Cache-Control", "no-store");

  // 인증: 조회·쓰기 모두 로그인 필수. 쓰기는 Lv8 이상만(외부에서 전 객실을 뒤집는 것을 차단).
  const session = verifySession(readCookie(req, COOKIE));
  if (!session) {
    return res.status(401).json({ ok: false, error: "no_session",
      message: "로그인 세션이 없습니다. 다시 로그인하세요." });
  }
  // 방막기 원장은 내부 운영정보(전 캠퍼스 방·침대 구성)라 조회도 직원 권한이 필요하다.
  if (Number(session.mb_level || 0) < WRITE_MIN_LEVEL) {
    return res.status(403).json({ ok: false, error: "forbidden",
      message: req.method === "POST"
        ? "방막기 변경 권한이 없습니다. 담당 매니저에게 요청하세요."
        : "방막기 정보를 조회할 권한이 없습니다." });
  }
  const actor = actorOf(session);

  try {
    if (req.method === "GET") {
      const url = new URL(req.url, "http://x");
      const from = dateOrNull(url.searchParams.get("from"));
      const to = dateOrNull(url.searchParams.get("to"));
      const blocks = await rpc("select app.room_block_list($1::date,$2::date) as r", [from, to]);
      return res.status(200).json({ ok: true, actor: actor.name, verified: actor.verified, blocks });
    }

    if (req.method !== "POST") {
      res.setHeader("Allow", "GET, POST");
      return res.status(405).json({ ok: false, error: "method_not_allowed" });
    }

    const body = await readBody(req);
    if (!body) return res.status(400).json({ ok: false, error: "bad_json" });

    const items = normItems(body.items);
    if (!items.length) return res.status(400).json({ ok: false, error: "no_items" });

    const from = dateOrNull(body.from);
    const to = dateOrNull(body.to);
    if ((body.from && !from) || (body.to && !to))
      return res.status(400).json({ ok: false, error: "bad_date" });
    if (from && to && from > to)
      return res.status(400).json({ ok: false, error: "bad_range" });
    // 기간은 둘 다 있거나 둘 다 없어야 한다(한쪽만 = 열린 구간은 지원하지 않음)
    if (!!from !== !!to && body.op !== "release")
      return res.status(400).json({ ok: false, error: "half_range" });

    if (body.op === "release") {
      const r = await rpc("select app.room_block_release($1::jsonb,$2::date,$3::date,$4) as r",
        [JSON.stringify(items), from, to, actor.name]);
      return res.status(200).json({ ...r, actor: actor.name, verified: actor.verified });
    }

    if (body.op === "block") {
      const reason = REASONS.has(String(body.reason || "").toUpperCase())
        ? String(body.reason).toUpperCase() : "ETC";
      const memo = body.memo == null ? null : String(body.memo).slice(0, 500);
      const idem = body.idem == null ? null : String(body.idem).replace(/[^\w:.-]/g, "").slice(0, 80) || null;
      const r = await rpc(
        "select app.room_block_set($1::jsonb,$2::date,$3::date,$4,$5,$6,$7,$8) as r",
        [JSON.stringify(items), from, to, reason, memo, actor.name, actor.verified, idem]);
      return res.status(r && r.ok === false ? 400 : 200).json({ ...r, actor: actor.name, verified: actor.verified });
    }

    return res.status(400).json({ ok: false, error: "bad_op" });
  } catch (e) {
    shared = null;
    return res.status(500).json({ ok: false, error: "server_error", message: String((e && e.message) || e).slice(0, 200) });
  }
}
