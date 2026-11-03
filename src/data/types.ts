/**
 * 正規化後のデータ型（docs/03 技術調査と docs/02 設計方針3章に対応）。
 * 紹介文相当（comment）や女優画像は規約上扱わないため、型に含めない。
 */

/** id と名前の対（ジャンル・出演者・シリーズ・メーカー・レーベル・監督） */
export type NamedRef = { id: string; name: string; ruby?: string | null };

/** 配信形式ごとの価格 */
export type Delivery = { type: string; price: number | null; listPrice: number | null };

/** キャンペーン（セール） */
export type Campaign = { title: string; begin: string | null; end: string | null };

/** サンプル動画（公式プレーヤーのURL。サイズ別） */
export type SampleMovie = { sizes: Record<string, string>; pcFlag: number | null; spFlag: number | null };

export type WorkStatus = 'active' | 'gone';

/** 作品 */
export type Work = {
  contentId: string;
  productId: string | null;
  title: string;
  url: string | null;
  affiliateUrl: string | null;
  volumeMin: number | null;
  releasedAt: string | null; // ISO 8601 の日付（YYYY-MM-DD）または日時
  reviewCount: number;
  reviewAvg: number | null;
  priceMin: number | null;
  listPrice: number | null;
  deliveries: Delivery[];
  imageList: string | null;
  imageSmall: string | null;
  imageLarge: string | null;
  sampleImages: string[];
  sampleMovie: SampleMovie | null;
  campaigns: Campaign[];
  genres: NamedRef[];
  actresses: NamedRef[];
  series: NamedRef[];
  makers: NamedRef[];
  labels: NamedRef[];
  directors: NamedRef[];
  rankPosition: number | null;
  fetchedAt: string; // ISO 8601 日時
  status: WorkStatus;
};

/** 派生ラベル（docs/02 5.2） */
export type DerivedLabel =
  | '新作' | '定番' | '高評価' | '長尺' | '短尺' | 'セール中'
  | '初見向け' | 'シリーズ追い向け' | '出演者追い向け';

/** ラベル閾値（既定値は docs/02 5.2 の仮値） */
export type LabelThresholds = {
  newDays: number;            // 新作: 配信開始からの日数以内
  classicYears: number;       // 定番: 配信開始からの年数以上
  classicReviews: number;     // 定番: レビュー件数以上
  topAvg: number;             // 高評価: 平均以上
  topReviews: number;         // 高評価: 件数以上
  longMin: number;            // 長尺: 分以上
  shortMin: number;           // 短尺: 分以下
  seriesFollow: number;       // シリーズ追い向け: 同シリーズの作品数以上
  actressFollow: number;      // 出演者追い向け: 同出演者の作品数以上
};

export const DEFAULT_THRESHOLDS: LabelThresholds = {
  newDays: 30, classicYears: 3, classicReviews: 50, topAvg: 4.5, topReviews: 20,
  longMin: 180, shortMin: 60, seriesFollow: 12, actressFollow: 20,
};

/** 似た作品 */
export type Similar = { contentId: string; similarId: string; score: number };

/** 探索UI用の軽量レコード（カード表示に必要な項目だけ） */
export type WorkCardRecord = {
  id: string;
  t: string;              // title
  a: string[];            // actress names
  m: string | null;       // maker name
  s: string | null;       // series name
  g: string[];            // genre names
  v: number | null;       // volumeMin
  d: string | null;       // releasedAt (YYYY-MM-DD)
  rc: number;             // reviewCount
  ra: number | null;      // reviewAvg
  p: number | null;       // priceMin
  lp: number | null;      // listPrice
  sale: boolean;          // セール中
  sm: boolean;            // サンプル動画あり
  img: string | null;     // imageSmall
  rk: number | null;      // rankPosition
  lb: DerivedLabel[];     // 派生ラベル
  ob: boolean;            // 外部リンク先（アフィリエイトURLか公式URL）があるか。/go/ の有無と一致
};

/**
 * 出演者のプロフィール（ActressSearch 由来）。
 * 顔写真（imageURL）は規約上使わないため、型にも保存にも含めない。
 */
export type ActressProfile = {
  id: string;
  name: string;
  ruby: string | null;
  birthday: string | null;
  bloodType: string | null;
  hobby: string | null;
  prefectures: string | null;
  height: number | null;
  bust: number | null;
  waist: number | null;
  hip: number | null;
  cup: string | null;
  listUrl: string | null; // listURL の digital を優先し、無ければ他の値
  fetchedAt: string; // ISO 8601 日時
};
