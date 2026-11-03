import { afterEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { affiliateMode, outboundUrl, rewriteAffiliateId, siteAffiliateId } from '../src/lib/links.ts';

const saved = { m: process.env.AFFILIATE_LINKS, s: process.env.FANZA_SITE_AFFILIATE_ID };
afterEach(() => {
  if (saved.m === undefined) delete process.env.AFFILIATE_LINKS; else process.env.AFFILIATE_LINKS = saved.m;
  if (saved.s === undefined) delete process.env.FANZA_SITE_AFFILIATE_ID; else process.env.FANZA_SITE_AFFILIATE_ID = saved.s;
});

describe('rewriteAffiliateId', () => {
  it('af_id を差し替える（fanza / dmm）', () => {
    assert.equal(rewriteAffiliateId('https://al.fanza.co.jp/?lurl=x&af_id=test-990&ch=api', 'site-003'), 'https://al.fanza.co.jp/?lurl=x&af_id=site-003&ch=api');
    assert.equal(rewriteAffiliateId('https://al.dmm.co.jp/?af_id=test-990', 'site-003'), 'https://al.dmm.co.jp/?af_id=site-003');
  });
  it('litevideo の affi_id を差し替える', () => {
    assert.equal(rewriteAffiliateId('https://www.dmm.co.jp/litevideo/-/part/=/affi_id=test-990/cid=abc/', 'site-003'), 'https://www.dmm.co.jp/litevideo/-/part/=/affi_id=site-003/cid=abc/');
  });
  it('無関係のURLと siteId が null のときは変更なし', () => {
    assert.equal(rewriteAffiliateId('https://example.com/?af_id=a', 'site-003'), 'https://example.com/?af_id=a');
    assert.equal(rewriteAffiliateId('https://al.fanza.co.jp/?af_id=a', null), 'https://al.fanza.co.jp/?af_id=a');
  });
});

describe('affiliateMode / siteAffiliateId', () => {
  it('既定は off。on と書いたときだけ on', () => {
    delete process.env.AFFILIATE_LINKS;
    assert.equal(affiliateMode(), 'off');
    process.env.AFFILIATE_LINKS = 'ON';
    assert.equal(affiliateMode(), 'off');
    process.env.AFFILIATE_LINKS = 'on';
    assert.equal(affiliateMode(), 'on');
  });
  it('サイト用IDは未設定・空なら null', () => {
    delete process.env.FANZA_SITE_AFFILIATE_ID;
    assert.equal(siteAffiliateId(), null);
    process.env.FANZA_SITE_AFFILIATE_ID = '';
    assert.equal(siteAffiliateId(), null);
    process.env.FANZA_SITE_AFFILIATE_ID = 'site-003';
    assert.equal(siteAffiliateId(), 'site-003');
  });
});

describe('outboundUrl', () => {
  const w = { affiliateUrl: 'https://al.fanza.co.jp/?af_id=a', url: 'https://www.dmm.co.jp/item/' };
  it('off では公式URL', () => {
    delete process.env.AFFILIATE_LINKS;
    assert.equal(outboundUrl(w), w.url);
  });
  it('on ではアフィリエイトURL。無ければ公式URL', () => {
    process.env.AFFILIATE_LINKS = 'on';
    assert.equal(outboundUrl(w), w.affiliateUrl);
    assert.equal(outboundUrl({ ...w, affiliateUrl: null }), w.url);
  });
  it('どちらも無い・http(s) 以外は null', () => {
    process.env.AFFILIATE_LINKS = 'on';
    assert.equal(outboundUrl({ affiliateUrl: null, url: null }), null);
    assert.equal(outboundUrl({ affiliateUrl: 'javascript:alert(1)', url: null }), null);
  });
});
