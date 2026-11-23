/**
 * 投稿履歴（x_posts テーブル）。node:sqlite を使う。
 * catalog.sqlite と同じファイルを開いてもよいが、作るのは x_posts テーブル（と、その索引）だけで、他のテーブルには触れない。
 * 「日」の区切りは日本時間（JST、UTC+9）。posted_at は UTC の ISO 8601（ミリ秒つき、Z 終わり）で持ち、
 * 同じ形式の文字列どうしの大小で時刻の前後を比べる。
 */
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

export type PostKind = 'daily' | 'feature' | 'sale';
export const POST_KINDS: readonly PostKind[] = ['daily', 'feature', 'sale'];

export type PostRecord = {
  contentId: string;
  postedAt: Date;
  /** 実投稿で返ってきた tweet の ID。dry-run は null */
  tweetId: string | null;
  text: string;
  kind: PostKind;
  dryRun: boolean;
};

export type PostStore = {
  /** 1件記録する（dry-run も記録し、dry_run=1 で区別する） */
  recordPost(rec: PostRecord): void;
  /** now（省略すると現在）から days 日さかのぼった時刻以降に記録された作品の contentId（実投稿・dry-run の両方） */
  recentContentIds(days: number, now?: Date): Set<string>;
  /** 日本時間の日付（YYYY-MM-DD）の日に記録された件数。dryRun を省くか false なら実投稿、true なら dry-run だけを数える */
  countPostsOn(dateKey: string, dryRun?: boolean): number;
  /** その日に記録された contentId を古い順に（実投稿・dry-run の両方） */
  contentIdsOn(dateKey: string): string[];
  close(): void;
};

const SCHEMA = `
CREATE TABLE IF NOT EXISTS x_posts (
  id INTEGER PRIMARY KEY,
  content_id TEXT NOT NULL,
  posted_at TEXT NOT NULL,
  tweet_id TEXT,
  text TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('daily', 'feature', 'sale')),
  dry_run INTEGER NOT NULL DEFAULT 0 CHECK (dry_run IN (0, 1))
);
CREATE INDEX IF NOT EXISTS idx_x_posts_posted_at ON x_posts (posted_at);
CREATE INDEX IF NOT EXISTS idx_x_posts_content_id ON x_posts (content_id);
`;

const DAY_MS = 24 * 60 * 60 * 1000;
const JST_OFFSET_MS = 9 * 60 * 60 * 1000;

/** 日本時間の日付キー（YYYY-MM-DD）。日本は夏時間が無いので +9 時間固定 */
export function jstDateKey(d: Date): string {
  return new Date(d.getTime() + JST_OFFSET_MS).toISOString().slice(0, 10);
}

/** 日本時間の日付キーの日を、UTC の ISO 文字列の範囲 [始まり, 翌日の始まり) にする */
function dayRange(dateKey: string): [string, string] {
  const start = /^\d{4}-\d{2}-\d{2}$/.test(dateKey) ? Date.parse(`${dateKey}T00:00:00+09:00`) : NaN;
  if (Number.isNaN(start)) throw new RangeError(`日付は YYYY-MM-DD の形式で指定してください: ${dateKey}`);
  return [new Date(start).toISOString(), new Date(start + DAY_MS).toISOString()];
}

/** 投稿履歴を開く。dbPath が ':memory:' ならメモリ上、それ以外は親ディレクトリを作ってからファイルを開く */
export function openPostStore(dbPath: string): PostStore {
  if (dbPath !== ':memory:' && dbPath !== '') mkdirSync(dirname(dbPath), { recursive: true });
  const db = new DatabaseSync(dbPath);
  db.exec('PRAGMA busy_timeout = 5000');
  db.exec(SCHEMA);

  const insert = db.prepare('INSERT INTO x_posts (content_id, posted_at, tweet_id, text, kind, dry_run) VALUES (?, ?, ?, ?, ?, ?)');
  const recent = db.prepare('SELECT DISTINCT content_id FROM x_posts WHERE posted_at >= ?');
  const count = db.prepare('SELECT COUNT(*) AS n FROM x_posts WHERE posted_at >= ? AND posted_at < ? AND dry_run = ?');
  const idsOn = db.prepare('SELECT content_id FROM x_posts WHERE posted_at >= ? AND posted_at < ? ORDER BY posted_at, id');
  let closed = false;

  return {
    recordPost(rec) {
      if (!POST_KINDS.includes(rec.kind)) throw new RangeError(`kind は ${POST_KINDS.join('・')} のどれかにしてください: ${rec.kind}`);
      insert.run(rec.contentId, rec.postedAt.toISOString(), rec.tweetId, rec.text, rec.kind, rec.dryRun ? 1 : 0);
    },
    recentContentIds(days, now = new Date()) {
      if (!Number.isFinite(days) || days < 0) throw new RangeError(`days には 0 以上の数を指定してください: ${days}`);
      const since = new Date(now.getTime() - days * DAY_MS).toISOString();
      return new Set(recent.all(since).map((row) => row.content_id as string));
    },
    countPostsOn(dateKey, dryRun = false) {
      const [from, to] = dayRange(dateKey);
      return Number((count.get(from, to, dryRun ? 1 : 0) as { n: number | bigint }).n);
    },
    contentIdsOn(dateKey) {
      const [from, to] = dayRange(dateKey);
      return idsOn.all(from, to).map((row) => row.content_id as string);
    },
    close() {
      if (closed) return;
      closed = true;
      db.close();
    },
  };
}
