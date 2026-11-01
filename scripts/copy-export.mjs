// 探索ページ用のデータを data/export から public/data にコピーする（npm の prebuild で自動実行される）。
//   - コピーするのは index.json、meta.json、works-NNN.json。works.json は大きいのでコピーしない。
//   - public/data/ に残っている古い works-*.json は先に消す（チャンク数が減ったときに古いものが残らないように）。
//   - public/data/index.json には、チャンクから算出した years（配信開始年。新しい順）を足す。
// astro dev は prebuild を通らないので、データを書き出し直したら `node scripts/copy-export.mjs` を手で実行する。
import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const srcDir = join(root, 'data', 'export');
const destDir = join(root, 'public', 'data');
const CHUNK = /^works-\d+\.json$/;

/** メッセージを出して終了コード1で止める */
function fail(message) {
  console.error(`[copy-export] ${message}`);
  process.exit(1);
}

function readJson(path) {
  try {
    return JSON.parse(readFileSync(path, 'utf8'));
  } catch (e) {
    return fail(`${path} を JSON として読めませんでした（${e.message}）`);
  }
}

if (!existsSync(join(srcDir, 'index.json'))) {
  fail(
    `${srcDir} に index.json がありません。先に次を実行して、作品データを書き出してください。\n` +
      '  npm run ingest -- --synthetic 3000 && npm run derive && npm run export',
  );
}

const index = readJson(join(srcDir, 'index.json'));
// index.json に載っているチャンクだけを対象にする（名前の形式と存在も確かめる）
const chunks = Array.isArray(index.chunks) ? index.chunks : [];
for (const name of chunks) {
  if (typeof name !== 'string' || !CHUNK.test(name)) fail(`index.json のチャンク名が不正です: ${JSON.stringify(name)}`);
  if (!existsSync(join(srcDir, name))) fail(`index.json に載っているチャンクがありません: ${name}（npm run export をやり直してください）`);
}

// 配信開始年（d の先頭4桁）を全チャンクから集める。index.json には無いので、ここで足す
const years = new Set();
for (const name of chunks) {
  const records = readJson(join(srcDir, name));
  if (!Array.isArray(records)) fail(`${name} が配列ではありません`);
  for (const w of records) {
    if (w && typeof w.d === 'string' && /^\d{4}-/.test(w.d)) years.add(Number(w.d.slice(0, 4)));
  }
}
const sortedYears = [...years].sort((a, b) => b - a);

mkdirSync(destDir, { recursive: true });
for (const f of readdirSync(destDir)) if (CHUNK.test(f)) rmSync(join(destDir, f));
for (const name of chunks) copyFileSync(join(srcDir, name), join(destDir, name));

if (existsSync(join(srcDir, 'meta.json'))) {
  copyFileSync(join(srcDir, 'meta.json'), join(destDir, 'meta.json'));
} else {
  rmSync(join(destDir, 'meta.json'), { force: true });
  console.warn('[copy-export] meta.json が data/export にありません（コピーを省きました）');
}
// index.json は最後に書く（チャンクが揃う前に、新しい index が参照されないように）
writeFileSync(join(destDir, 'index.json'), JSON.stringify({ ...index, years: sortedYears }));

const range = sortedYears.length ? `${sortedYears[0]}〜${sortedYears[sortedYears.length - 1]}年` : '年なし';
console.log(`[copy-export] ${index.total ?? '?'} 件・${chunks.length} チャンクを public/data/ にコピーしました（${range}）`);
