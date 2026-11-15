// コンテンツコレクションの定義。運営者が書く「ガイド記事」と「特集」を Markdown で置く。
//   ガイド: src/content/guide/*.md   → /guide/{slug}/
//   特集:   src/content/feature/*.md → /feature/{slug}/
//   運営者から: src/content/notes/YYYY-MM-DD.md → トップの「運営者から」（OperatorNote.astro が最新の1件を出す。ページは作らない）
// draft の既定は true。公開するときに false にする（本番ビルドは draft のページを作らず、一覧にも出さない）。
import { defineCollection } from 'astro:content';
import { glob } from 'astro/loaders';
import { z } from 'astro/zod';

// 2つのコレクションに共通する frontmatter
const common = {
  title: z.string(),
  description: z.string(),
  /** 公開日。YAML の `2026-11-01` は UTC の 0 時として読まれる（表示側も UTC で整える） */
  date: z.coerce.date(),
  /** 更新日。直したときだけ書く */
  updated: z.coerce.date().optional(),
  draft: z.boolean().default(true),
};

const guide = defineCollection({
  loader: glob({ pattern: '*.md', base: './src/content/guide' }),
  schema: z.object({ ...common }),
});

const feature = defineCollection({
  loader: glob({ pattern: '*.md', base: './src/content/feature' }),
  schema: z.object({
    ...common,
    /** 特集に載せる作品の content_id（書いた順に表示）。数字だけのIDは "" で囲んで文字列にする */
    works: z.array(z.string()).default([]),
    /** 特集の導入文（見出しの下に出す）。本文とは別に短く書く */
    intro: z.string().optional(),
  }),
});

// 「運営者から」の文。週次の自動生成（scripts/draft-weekly.ts）か、運営者が自分で書いたもの（source: operator）を置く。
// ファイル名は YYYY-MM-DD.md。ほかの md（README など）は読まない。
const notes = defineCollection({
  loader: glob({ pattern: '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9].md', base: './src/content/notes' }),
  schema: z.object({
    /** 掲載日（YAML の `2026-11-16` は UTC の 0 時として読まれる。表示側も UTC で整える） */
    date: z.coerce.date(),
    /** 書いた主体。llm: Claude の文、template: 数字だけの定型文、operator: 運営者が自分で書いた文（自動生成はその週を上書きしない） */
    source: z.enum(['llm', 'template', 'operator']),
    draft: z.boolean().default(true),
  }),
});

export const collections = { guide, feature, notes };
