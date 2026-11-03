/**
 * 外部リンク（FANZA）の切替。公開直後（審査承認前）はアフィリエイトIDなしの公式URLだけを使い、
 * 承認後に環境変数で有効にする。値の扱いは docs/07_運用手順.md の「公開から承認までの手順」を参照。
 */

/** AFFILIATE_LINKS が `on` のときだけ on。未設定・それ以外は off */
export function affiliateMode(): 'off' | 'on' {
  return process.env.AFFILIATE_LINKS === 'on' ? 'on' : 'off';
}

/** サイト用アフィリエイトID（承認後に発行されるもの）。未設定なら null */
export function siteAffiliateId(): string | null {
  const v = process.env.FANZA_SITE_AFFILIATE_ID;
  return typeof v === 'string' && v.trim() !== '' ? v.trim() : null;
}

/**
 * URL 内のアフィリエイトIDをサイト用IDに差し替える。
 * 対象は al.fanza.co.jp / al.dmm.co.jp の af_id、および litevideo の affi_id。siteId が null や他のURLは変更なし。
 */
export function rewriteAffiliateId(url: string, siteId: string | null): string {
  if (!siteId) return url;
  const id = encodeURIComponent(siteId);
  if (/^https?:\/\/al\.(fanza\.co\.jp|dmm\.co\.jp)\//.test(url)) {
    return url.replace(/([?&]af_id=)[^&#]*/, (_m, p: string) => p + id);
  }
  if (url.includes('litevideo')) {
    return url.replace(/([?&/]affi_id=)[^&#/]*/, (_m, p: string) => p + id);
  }
  return url;
}

/**
 * 「FANZAで見る」の移動先。on かつ affiliateUrl があればそれ、なければ公式の商品ページ（IDなし）。
 * http(s) 以外のURLは使わない。どちらも無ければ null（ボタンも /go/ ページも作らない）。
 */
export function outboundUrl(work: { affiliateUrl: string | null; url: string | null }): string | null {
  const ok = (u: string | null): u is string => typeof u === 'string' && /^https?:\/\//.test(u);
  if (affiliateMode() === 'on' && ok(work.affiliateUrl)) return work.affiliateUrl;
  return ok(work.url) ? work.url : null;
}
