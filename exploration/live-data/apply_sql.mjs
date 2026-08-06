// migration/schema/*.sql 를 라이브 Supabase 에 적용하는 러너.
//   node exploration/live-data/apply_sql.mjs migration/schema/room_moves.sql [...]
//   node exploration/live-data/apply_sql.mjs -e "select 1"
// 원본 MySQL 및 legacy/cms 스키마는 건드리지 않는다(스크립트 내용 자체가 app 전용).
import fs from "node:fs";
import path from "node:path";
import pg from "/Users/kwangseobpark/smeag-old-system-analysis/deploy/node_modules/pg/lib/index.js";

const ROOT = "/Users/kwangseobpark/smeag-old-system-analysis";
const env = {};
for (const line of fs.readFileSync(path.join(ROOT, ".env"), "utf8").split("\n")) {
  const m = line.match(/^([A-Z_]+)=(.*)$/);
  if (m) env[m[1]] = m[2].trim().replace(/^["']|["']$/g, "");
}
const c = new pg.Client({
  host: env.PG_HOST, port: +(env.PG_PORT || 5432), database: env.PG_DB || "postgres",
  user: env.PG_USER, password: env.PG_PASS, ssl: { rejectUnauthorized: false },
  connectionTimeoutMillis: 20000, statement_timeout: 300000,
});
await c.connect();

const args = process.argv.slice(2);
try {
  if (args[0] === "-e") {
    const r = await c.query(args.slice(1).join(" "));
    console.log(JSON.stringify(r.rows, null, 1));
  } else {
    for (const f of args) {
      const p = path.isAbsolute(f) ? f : path.join(ROOT, f);
      const sql = fs.readFileSync(p, "utf8");
      const t = Date.now();
      await c.query(sql);
      console.log(`✔ ${path.basename(p)}  ${Date.now() - t}ms`);
    }
  }
} catch (e) {
  console.error("✖", e.message);
  if (e.position) console.error("   position:", e.position);
  process.exitCode = 1;
} finally {
  await c.end();
}
