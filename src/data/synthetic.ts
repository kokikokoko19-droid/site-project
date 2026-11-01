/**
 * テスト用の合成レスポンス生成（docs/03 の ItemList の形をまねたダミーデータ）。
 * 実在の作品・人物の名称は含めない。シード固定の疑似乱数なので、同じ引数なら常に同じ結果になる。
 * 欠損やゆらぎを一定割合で混ぜ、normalize が型ゆらぎを吸収できるかの確認に使う。
 */

/** 欠損・ゆらぎの発生率。最初の2行が仕様の7種で、3行目以降は補助的な低率の欠損 */
const RATE = {
  noActress: 0.08, noReview: 0.15, noSampleMovie: 0.3, hasCampaign: 0.15,
  volumeHms: 0.1, noSampleL: 0.2, noSeries: 0.4,
  noVolume: 0.03, noDate: 0.02, slashDate: 0.1, noImage: 0.03,
  noListPrice: 0.3, noDeliveries: 0.1, noAffiliate: 0.02, noDirector: 0.4,
};

const DAY = 86400000;
const DATE_START = Date.UTC(2021, 0, 1);
const DATE_DAYS = (Date.UTC(2026, 9, 31) - DATE_START) / DAY + 1; // 2021-01-01〜2026-10-31
const DELIVERY_TYPES = ['hd', '4k', 'download', 'stream', 'iosdl', 'androiddl'];

const pad2 = (n: number): string => String(n).padStart(2, '0');
const withComma = (n: number): string => String(n).replace(/\B(?=(\d{3})+(?!\d))/g, ',');

/** 0→A, 25→Z, 26→AA ... */
function alpha(n: number): string {
  let s = '';
  for (let x = n; x >= 0; x = Math.floor(x / 26) - 1) s = String.fromCharCode(65 + (x % 26)) + s;
  return s;
}

/** mulberry32。seed と作品番号から状態を作るので、作品ごとに独立して決定的になる */
function makeRng(seed: number, i: number): () => number {
  let a = (Math.imul(seed | 0, 0x9e3779b1) ^ Math.imul((i | 0) + 0x7f4a7c15, 0x85ebca6b)) >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), a | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** 0〜size-1 から重複なく k 個選ぶ */
function pickDistinct(r: () => number, size: number, k: number): number[] {
  const idx = Array.from({ length: size }, (_, n) => n);
  for (let n = 0; n < k; n++) {
    const j = n + Math.floor(r() * (size - n));
    const tmp = idx[n] as number;
    idx[n] = idx[j] as number;
    idx[j] = tmp;
  }
  return idx.slice(0, k);
}

/** 生の item を1件合成する。i は作品番号（content_id は syn + 5桁ゼロ埋め） */
export function syntheticItem(i: number, seed: number = 1): any {
  const r = makeRng(seed, i);
  const chance = (p: number): boolean => r() < p;
  const int = (lo: number, hi: number): number => lo + Math.floor(r() * (hi - lo + 1)); // 両端を含む
  const ref = (base: number, n: number, name: string, ruby?: string) =>
    ruby === undefined ? { id: base + n + 1, name } : { id: base + n + 1, name, ruby };
  const cid = `syn${String(i).padStart(5, '0')}`;
  const url = `https://example.invalid/works/${cid}`;
  const pics = `https://example.invalid/pics/${cid}`;

  const item: Record<string, any> = {
    service_code: 'digital', service_name: 'サービスA', floor_code: 'videoa', floor_name: 'フロアA',
    category_name: 'カテゴリA', content_id: cid, product_id: cid,
    title: `作品 ${String(i).padStart(4, '0')}`, URL: url,
  };
  if (!chance(RATE.noAffiliate)) {
    item.affiliateURL = `https://al.example.invalid/?lurl=${encodeURIComponent(url)}&af_id=dummy-990&ch=api`;
  }

  // volume: 30〜300分。"120" 形式と "1:29:00" 形式が混ざる
  const minutes = int(30, 300);
  const vu = r();
  if (vu >= RATE.noVolume) {
    const hms = vu < RATE.noVolume + RATE.volumeHms;
    item.volume = hms ? `${Math.floor(minutes / 60)}:${pad2(minutes % 60)}:00` : String(minutes);
  }

  // review: 件数は少ない方に偏らせ、平均は高い方に偏らせる（0件は review 欠落で表す）
  if (!chance(RATE.noReview)) {
    item.review = { count: 1 + Math.floor(r() ** 2 * 500), average: (1 + 4 * Math.sqrt(r())).toFixed(2) };
  }

  // prices: 300〜3000円。"980"・"980~"・"1,980" のゆらぎ
  const price = int(30, 300) * 10;
  const tilde = chance(0.4);
  const comma = price >= 1000 && chance(0.3);
  const prices: Record<string, any> = { price: (comma ? withComma(price) : String(price)) + (tilde ? '~' : '') };
  if (!chance(RATE.noListPrice)) prices.list_price = String(Math.round(price * (1.1 + r() * 0.4) / 10) * 10);
  if (!chance(RATE.noDeliveries)) {
    const start = int(0, DELIVERY_TYPES.length - 1);
    const delivery = Array.from({ length: int(1, 3) }, (_, j) => {
      const d: Record<string, any> = { type: DELIVERY_TYPES[(start + j) % DELIVERY_TYPES.length], price: String(price + 100 * j) };
      if (chance(0.5)) d.list_price = String(Math.round((price + 100 * j) * 1.3 / 10) * 10);
      return d;
    });
    prices.deliveries = { delivery };
  }
  item.prices = prices;

  // date: 2021〜2026年。"YYYY-MM-DD HH:MM:SS" と "YYYY/M/D H:MM" が混ざる
  const day = new Date(DATE_START + int(0, DATE_DAYS - 1) * DAY);
  const [y, mo, d, hh, mi, ss] = [day.getUTCFullYear(), day.getUTCMonth() + 1, day.getUTCDate(), int(0, 23), int(0, 59), int(0, 59)];
  const du = r();
  if (du >= RATE.noDate) {
    item.date = du < RATE.noDate + RATE.slashDate
      ? `${y}/${mo}/${d} ${hh}:${pad2(mi)}`
      : `${y}-${pad2(mo)}-${pad2(d)} ${pad2(hh)}:${pad2(mi)}:${pad2(ss)}`;
  }

  if (!chance(RATE.noImage)) {
    item.imageURL = { list: `${pics}/${cid}pt.jpg`, small: `${pics}/${cid}ps.jpg`, large: `${pics}/${cid}pl.jpg` };
  }

  // sampleImageURL: sample_l が無いものが約20%（そのうち一部は sample_s も無い）
  const count = int(5, 20);
  const shots = (mark: string) => ({ image: Array.from({ length: count }, (_, k) => `${pics}/${cid}${mark}${k + 1}.jpg`) });
  const noL = chance(RATE.noSampleL);
  const noS = noL && chance(0.15);
  if (!noS) {
    item.sampleImageURL = { sample_s: shots('-') };
    if (!noL) item.sampleImageURL.sample_l = shots('jp-');
  }

  // sampleMovieURL: 公式プレーヤーのURL風。フラグは数値と文字列が混ざる
  if (!chance(RATE.noSampleMovie)) {
    const mv = (size: string) => `https://example.invalid/litevideo/-/part/=/cid=${cid}/size=${size}/`;
    const flag = (v: number) => (chance(0.3) ? String(v) : v);
    item.sampleMovieURL = {
      size_476_306: mv('476_306'), size_560_360: mv('560_360'), size_644_414: mv('644_414'), size_720_480: mv('720_480'),
      pc_flag: flag(1), sp_flag: flag(chance(0.8) ? 1 : 0),
    };
  }

  // campaign: 約15%の作品に1〜2件
  if (chance(RATE.hasCampaign)) {
    item.campaign = Array.from({ length: int(1, 2) }, (_, k) => {
      const begin = new Date(DATE_START + int(0, DATE_DAYS - 15) * DAY);
      const end = new Date(begin.getTime() + int(3, 14) * DAY);
      const ymd = (t: Date) => `${t.getUTCFullYear()}-${pad2(t.getUTCMonth() + 1)}-${pad2(t.getUTCDate())}`;
      return { date_begin: `${ymd(begin)} 10:00:00`, date_end: `${ymd(end)} 23:59:59`, title: `キャンペーン${alpha(k)}` };
    });
  }

  // iteminfo: キー単位で欠落する（出演者・シリーズ・監督）
  const mk = int(0, 9);
  const lb = int(0, 11);
  const iteminfo: Record<string, any> = {
    genre: pickDistinct(r, 20, int(1, 4)).map((n) => ref(1000, n, `タグ${pad2(n + 1)}`)),
    maker: [ref(3000, mk, `メーカー${alpha(mk)}`)],
    label: [ref(4000, lb, `レーベル${alpha(lb)}`)],
  };
  if (!chance(RATE.noSeries)) {
    const n = int(0, 29);
    iteminfo.series = [ref(5000, n, `シリーズ${pad2(n + 1)}`)];
  }
  if (!chance(RATE.noActress)) {
    iteminfo.actress = pickDistinct(r, 40, int(1, 3)).map((n) => ref(2000, n, `出演者${alpha(n)}`, `しゅつえんしゃ${alpha(n)}`));
  }
  if (!chance(RATE.noDirector)) {
    const n = int(0, 7);
    iteminfo.director = [ref(6000, n, `監督${alpha(n)}`, `かんとく${alpha(n)}`)];
  }
  item.iteminfo = iteminfo;
  return item;
}

/**
 * ItemList の外枠つきレスポンスを合成する。offset は1始まりの先頭位置で、作品番号は offset から振る。
 * total を省くと、この呼び出しで返す範囲が最後になる。total を超える分は実APIと同様に返さない。
 */
export function syntheticItemList(
  { count, offset = 1, total, seed = 1 }: { count: number; offset?: number; total?: number; seed?: number },
): any {
  const totalCount = total ?? offset + count - 1;
  const n = Math.max(0, Math.min(count, totalCount - offset + 1));
  return {
    request: {
      parameters: {
        api_id: 'dummy', affiliate_id: 'dummy-990', site: 'FANZA', service: 'digital', floor: 'videoa',
        hits: String(count), offset: String(offset), sort: 'date', output: 'json',
      },
    },
    result: {
      status: 200,
      result_count: n,
      total_count: totalCount,
      first_position: offset,
      items: Array.from({ length: n }, (_, k) => syntheticItem(offset + k, seed)),
    },
  };
}
