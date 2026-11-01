/**
 * 作品データを保存する SQLite 層（Node 組み込みの node:sqlite を使用）。
 * 取得から外れた作品は消さずに gone にし、一定期間たってから purgeGone で削除する。
 */
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import type { Similar, Work, WorkStatus } from './types.ts';
import { REF_PROPS, SCHEMA_SQL, UPSERT_WORK_SQL, emptyRefs, rowToWork, workToParams } from './db-schema.ts';
import type { RefJoinRow, RefMap, SqlValue, WorkRow } from './db-schema.ts';

export type ListOptions = { status?: WorkStatus; limit?: number; offset?: number };

/**
 * 作品データ層の公開API。
 * replaceDerivedLabels / replaceSimilar は、渡した作品の分だけを置き換える（渡さなかった作品には触れない）。
 */
export type Db = {
  /** 追加または更新して active に戻す。処理した件数を返す */
  upsertWorks(works: Work[]): number;
  setRankPositions(entries: { contentId: string; rankPosition: number }[]): void;
  /** activeIds に含まれない active を gone にして、その件数を返す */
  markGone(activeIds: Iterable<string>, now: string): number;
  /** gone になって olderThanDays 日を超えた作品を関連行ごと削除し、その件数を返す */
  purgeGone(olderThanDays: number, now: string): number;
  getWork(contentId: string): Work | null;
  /** content_id 昇順で返す（ページングが安定するように） */
  listWorks(opts?: ListOptions): Work[];
  countWorks(status?: WorkStatus): number;
  replaceDerivedLabels(entries: { contentId: string; labels: string[] }[]): void;
  /** 登録した順に返す */
  getLabels(contentId: string): string[];
  replaceSimilar(entries: Similar[]): void;
  /** score の高い順に返す */
  getSimilar(contentId: string): Similar[];
  setMeta(key: string, value: string): void;
  getMeta(key: string): string | null;
  close(): void;
};

const DAY_MS = 86_400_000;
const REF_CHUNK = 500; // IN 句に渡す ID の上限（バインド変数の数の制限を避ける）

/** limit / offset が 0 以上の整数かを確かめる */
function checkCount(name: string, v: number | undefined): void {
  if (v !== undefined && (!Number.isInteger(v) || v < 0)) {
    throw new RangeError(`${name} は 0 以上の整数で指定してください: ${v}`);
  }
}

/** DB を開く（':memory:' も可）。初回はスキーマを作成する */
export function openDb(path: string): Db {
  if (path !== ':memory:' && path !== '') mkdirSync(dirname(path), { recursive: true });
  const db = new DatabaseSync(path);
  db.exec('PRAGMA journal_mode = WAL'); // メモリDBでは無視される
  db.exec('PRAGMA foreign_keys = ON');
  db.exec('PRAGMA busy_timeout = 5000');
  db.exec(SCHEMA_SQL);

  const q = (sql: string) => db.prepare(sql);
  const upsertWork = q(UPSERT_WORK_SQL);
  const upsertRef = q(`INSERT INTO refs (kind, id, name, ruby) VALUES (?, ?, ?, ?)
    ON CONFLICT(kind, id) DO UPDATE SET name = excluded.name, ruby = COALESCE(excluded.ruby, refs.ruby)`);
  const deleteWorkRefs = q('DELETE FROM work_refs WHERE content_id = ?');
  const insertWorkRef = q('INSERT INTO work_refs (content_id, kind, ref_id, position) VALUES (?, ?, ?, ?)');
  const setRank = q('UPDATE works SET rank_position = ? WHERE content_id = ?');
  const selectActive = q("SELECT content_id FROM works WHERE status = 'active'");
  const markOne = q("UPDATE works SET status = 'gone', gone_at = ? WHERE content_id = ? AND status = 'active'");
  const selectGone = q("SELECT content_id, gone_at FROM works WHERE status = 'gone' AND gone_at IS NOT NULL");
  const deleteWork = q('DELETE FROM works WHERE content_id = ?');
  const selectWork = q('SELECT * FROM works WHERE content_id = ?');
  const deleteLabels = q('DELETE FROM derived_labels WHERE content_id = ?');
  const insertLabel = q('INSERT OR IGNORE INTO derived_labels (content_id, label) VALUES (?, ?)');
  const selectLabels = q('SELECT label FROM derived_labels WHERE content_id = ? ORDER BY rowid');
  const deleteSimilarFrom = q('DELETE FROM similar WHERE content_id = ?');
  const deleteSimilarTo = q('DELETE FROM similar WHERE similar_id = ?');
  const insertSimilar = q('INSERT OR REPLACE INTO similar (content_id, similar_id, score) VALUES (?, ?, ?)');
  const selectSimilar = q(`SELECT content_id, similar_id, score FROM similar
    WHERE content_id = ? ORDER BY score DESC, similar_id`);
  const putMeta = q('INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value');
  const readMeta = q('SELECT value FROM meta WHERE key = ?');
  let closed = false;

  /** 書き込みをひとまとめにする。途中で失敗したら全部巻き戻す */
  const tx = <T>(fn: () => T): T => {
    db.exec('BEGIN IMMEDIATE');
    try {
      const result = fn();
      db.exec('COMMIT');
      return result;
    } catch (e) {
      try { db.exec('ROLLBACK'); } catch { /* 元のエラーを優先する */ }
      throw e;
    }
  };

  /** works の行に refs を結合して Work を組み立てる */
  const loadWorks = (rows: WorkRow[]): Work[] => {
    const refs = new Map<string, RefMap>();
    for (let i = 0; i < rows.length; i += REF_CHUNK) {
      const ids = rows.slice(i, i + REF_CHUNK).map((r) => r.content_id);
      const found = db.prepare(`SELECT wr.content_id, wr.kind, r.id, r.name, r.ruby
        FROM work_refs wr JOIN refs r ON r.kind = wr.kind AND r.id = wr.ref_id
        WHERE wr.content_id IN (${ids.map(() => '?').join(', ')})
        ORDER BY wr.content_id, wr.kind, wr.position`).all(...ids) as RefJoinRow[];
      for (const f of found) {
        let m = refs.get(f.content_id);
        if (!m) refs.set(f.content_id, (m = emptyRefs()));
        m[f.kind].push({ id: f.id, name: f.name, ruby: f.ruby });
      }
    }
    return rows.map((r) => rowToWork(r, refs.get(r.content_id) ?? emptyRefs()));
  };

  return {
    upsertWorks(works) {
      return tx(() => {
        for (const w of works) {
          upsertWork.run(...workToParams(w));
          deleteWorkRefs.run(w.contentId);
          for (const [kind, prop] of REF_PROPS) {
            const seen = new Set<string>();
            (w[prop] ?? []).forEach((ref, i) => {
              const id = String(ref.id);
              if (seen.has(id)) return; // 同じ作品の中の重複は先頭だけ残す
              seen.add(id);
              upsertRef.run(kind, id, ref.name, ref.ruby ?? null);
              insertWorkRef.run(w.contentId, kind, id, i);
            });
          }
        }
        return works.length;
      });
    },

    setRankPositions(entries) {
      tx(() => { for (const e of entries) setRank.run(e.rankPosition, e.contentId); });
    },

    markGone(activeIds, now) {
      const keep = new Set(activeIds);
      return tx(() => {
        let n = 0;
        for (const row of selectActive.all() as { content_id: string }[]) {
          if (!keep.has(row.content_id)) n += Number(markOne.run(now, row.content_id).changes);
        }
        return n;
      });
    },

    purgeGone(olderThanDays, now) {
      const cutoff = Date.parse(now) - olderThanDays * DAY_MS;
      if (!Number.isFinite(olderThanDays) || olderThanDays < 0 || Number.isNaN(cutoff)) {
        throw new RangeError(`purgeGone の引数が不正です: olderThanDays=${olderThanDays}, now=${now}`);
      }
      return tx(() => {
        let n = 0;
        for (const row of selectGone.all() as { content_id: string; gone_at: string }[]) {
          if (!(Date.parse(row.gone_at) < cutoff)) continue; // 期限内（または日時として読めない）なら残す
          for (const st of [deleteWorkRefs, deleteLabels, deleteSimilarFrom, deleteSimilarTo]) st.run(row.content_id);
          n += Number(deleteWork.run(row.content_id).changes);
        }
        return n;
      });
    },

    getWork(contentId) {
      const row = selectWork.get(contentId) as WorkRow | undefined;
      return row ? loadWorks([row])[0] : null;
    },

    listWorks(opts = {}) {
      const { status, limit, offset } = opts;
      checkCount('limit', limit);
      checkCount('offset', offset);
      const params: SqlValue[] = status ? [status] : [];
      let sql = `SELECT * FROM works${status ? ' WHERE status = ?' : ''} ORDER BY content_id`;
      if (limit !== undefined || offset !== undefined) {
        sql += ' LIMIT ? OFFSET ?';
        params.push(limit ?? -1, offset ?? 0); // SQLite は LIMIT なしの OFFSET を許さないので -1（無制限）
      }
      return loadWorks(db.prepare(sql).all(...params) as WorkRow[]);
    },

    countWorks(status) {
      const row = (status
        ? db.prepare('SELECT COUNT(*) AS n FROM works WHERE status = ?').get(status)
        : db.prepare('SELECT COUNT(*) AS n FROM works').get()) as { n: number };
      return Number(row.n);
    },

    replaceDerivedLabels(entries) {
      tx(() => {
        for (const e of entries) {
          deleteLabels.run(e.contentId);
          for (const label of e.labels) insertLabel.run(e.contentId, label);
        }
      });
    },

    getLabels(contentId) {
      return (selectLabels.all(contentId) as { label: string }[]).map((r) => r.label);
    },

    replaceSimilar(entries) {
      tx(() => {
        for (const id of new Set(entries.map((e) => e.contentId))) deleteSimilarFrom.run(id);
        for (const e of entries) insertSimilar.run(e.contentId, e.similarId, e.score);
      });
    },

    getSimilar(contentId) {
      const rows = selectSimilar.all(contentId) as { content_id: string; similar_id: string; score: number }[];
      return rows.map((r) => ({ contentId: r.content_id, similarId: r.similar_id, score: r.score }));
    },

    setMeta(key, value) {
      putMeta.run(key, value);
    },

    getMeta(key) {
      const row = readMeta.get(key) as { value: string | null } | undefined;
      return row?.value ?? null;
    },

    close() {
      if (closed) return; // 二重に閉じてもエラーにしない
      closed = true;
      db.close();
    },
  };
}
