// コンテンツコレクションの定義。運営者が書く「ガイド記事」と「特集」を Markdown で置く。
//   ガイド: src/content/guide/*.md   → /guide/{slug}/
//   特集:   src/content/feature/*.md → /feature/{slug}/
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

export const collections = { guide, feature };
