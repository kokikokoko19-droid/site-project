import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { buildAuthorizationHeader, hmacSha1Signature, normalizeParams, percentEncode, signatureBaseString } from '../src/x/oauth.ts';
import type { Param } from '../src/x/oauth.ts';

/** X（旧Twitter）の公式ドキュメント「Creating a signature」の例。署名は hCtSmYh+iHYCEqBWrE7C7hYmtUk= */
const DOC = {
  method: 'POST', url: 'https://api.twitter.com/1.1/statuses/update.json?include_entities=true',
  consumerKey: 'xvz1evFS4wEEPTGEFPHBog', consumerSecret: 'kAcSOqF21Fu85e7zjz7ZN2U4ZRhfV3WpwPAoE3Z7kBw',
  token: '370773112-GmHxMAgYyLbNEtIKZeRNFsMKPR9EyMZeS9weJAEb', tokenSecret: 'LswwdoUaIvS8ltyTt5jkRh4J50vUPVVHtR2YPi5kE',
  nonce: 'kYjzVBB8Y0ZFabxSWbWovY3uYSQ2pTgmZeNu2VS4cg', timestamp: 1318622958,
  bodyParams: [['status', 'Hello Ladies + Gentlemen, a signed OAuth request!']] as Param[],
};

describe('percentEncode（RFC 5849 3.6）', () => {
  it('非予約文字（英数字と - . _ ~）はそのまま', () => {
    assert.equal(percentEncode('AZaz09-._~'), 'AZaz09-._~');
  });
  it('! * \' ( ) も含め、それ以外は大文字16進の %XX にする', () => {
    assert.equal(percentEncode("!*'() +/=&%@:,;"), '%21%2A%27%28%29%20%2B%2F%3D%26%25%40%3A%2C%3B');
  });
  it('日本語は UTF-8 のバイト単位でエンコードする', () => {
    assert.equal(percentEncode('日本語'), '%E6%97%A5%E6%9C%AC%E8%AA%9E');
  });
});

describe('署名ベース文字列（RFC 5849 3.4.1）', () => {
  it('3.4.1.1 の例（クエリと本文のパラメータ、同名パラメータの値順、空の値）と一致する', () => {
    const base = signatureBaseString('POST', 'http://example.com/request?b5=%3D%253D&a3=a&c%40=&a2=r%20b', [
      ['c2', ''], ['a3', '2 q'], // 本文 "c2&a3=2+q" を復号したもの
      ['oauth_consumer_key', '9djdj82h48djs9d2'], ['oauth_token', 'kkk9d7dh3k39sjv7'], ['oauth_signature_method', 'HMAC-SHA1'],
      ['oauth_timestamp', '137131201'], ['oauth_nonce', '7d8f3e4a'], ['oauth_signature', 'bYT5CMsGcbgUdFHObYMEfcx6bsw='],
    ]);
    assert.equal(base,
      'POST&http%3A%2F%2Fexample.com%2Frequest&a2%3Dr%2520b%26a3%3D2%2520q%26a3%3Da%26b5%3D%253D%25253D%26c%2540%3D%26c2%3D'
      + '%26oauth_consumer_key%3D9djdj82h48djs9d2%26oauth_nonce%3D7d8f3e4a%26oauth_signature_method%3DHMAC-SHA1'
      + '%26oauth_timestamp%3D137131201%26oauth_token%3Dkkk9d7dh3k39sjv7');
  });
  it('3.4.1.2 のベース URI: スキームとホストは小文字、既定ポートは除き、それ以外のポートは残す', () => {
    const uri = (u: string): string => signatureBaseString('GET', u, []).split('&')[1];
    assert.equal(uri('HTTP://EXAMPLE.COM:80/r%20v/X?id=123'), 'http%3A%2F%2Fexample.com%2Fr%2520v%2FX');
    assert.equal(uri('https://www.example.net:8080/?q=1'), 'https%3A%2F%2Fwww.example.net%3A8080%2F');
    assert.equal(uri('HTTPS://API.X.COM:443/2/tweets'), uri('https://api.x.com/2/tweets'));
  });
  it('メソッドは大文字にする', () => {
    assert.ok(signatureBaseString('post', 'https://api.x.com/2/tweets', []).startsWith('POST&'));
  });
  it('正規化: 名前→値の順（エンコード後のバイト順）に並べる', () => {
    assert.equal(normalizeParams([['b', '2'], ['a', '2'], ['a', '1'], ['A', 'x'], ['a b', '3']]), 'A=x&a=1&a=2&a%20b=3&b=2');
  });
});

describe('buildAuthorizationHeader', () => {
  it('公式ドキュメントの例（本文のパラメータとクエリを含む）と署名が一致する', () => {
    const header = buildAuthorizationHeader(DOC);
    assert.ok(header.includes('oauth_signature="hCtSmYh%2BiHYCEqBWrE7C7hYmtUk%3D"'), header);
    assert.equal(header,
      'OAuth oauth_consumer_key="xvz1evFS4wEEPTGEFPHBog", oauth_nonce="kYjzVBB8Y0ZFabxSWbWovY3uYSQ2pTgmZeNu2VS4cg", '
      + 'oauth_signature="hCtSmYh%2BiHYCEqBWrE7C7hYmtUk%3D", oauth_signature_method="HMAC-SHA1", oauth_timestamp="1318622958", '
      + 'oauth_token="370773112-GmHxMAgYyLbNEtIKZeRNFsMKPR9EyMZeS9weJAEb", oauth_version="1.0"');
  });
  it('署名は鍵・ベース文字列から独立に計算した値と一致する', () => {
    const base = signatureBaseString(DOC.method, DOC.url, [
      ['oauth_consumer_key', DOC.consumerKey], ['oauth_nonce', DOC.nonce], ['oauth_signature_method', 'HMAC-SHA1'],
      ['oauth_timestamp', '1318622958'], ['oauth_token', DOC.token], ['oauth_version', '1.0'], ...DOC.bodyParams,
    ]);
    assert.equal(hmacSha1Signature(base, DOC.consumerSecret, DOC.tokenSecret), 'hCtSmYh+iHYCEqBWrE7C7hYmtUk=');
  });
  it('クエリの値を変えると署名が変わり、同じ内容をクエリで渡しても本文で渡しても同じ署名になる', () => {
    const sig = (over: object): string => /oauth_signature="([^"]+)"/.exec(buildAuthorizationHeader({ ...DOC, ...over }))![1];
    const base = { bodyParams: [] as Param[], url: 'https://api.x.com/2/tweets' };
    const a = sig({ ...base, url: 'https://api.x.com/2/tweets?x=1' }), b = sig({ ...base, url: 'https://api.x.com/2/tweets?x=2' });
    assert.notEqual(a, b);
    assert.equal(a, sig({ ...base, bodyParams: [['x', '1']] }));
  });
  it('nonce と timestamp を省くと、毎回違う nonce と現在の秒時刻になる', () => {
    const { nonce: _n, timestamp: _t, ...rest } = DOC;
    const before = Math.floor(Date.now() / 1000);
    const [h1, h2] = [buildAuthorizationHeader(rest), buildAuthorizationHeader(rest)];
    const get = (h: string, k: string): string => new RegExp(`${k}="([^"]*)"`).exec(h)![1];
    assert.match(get(h1, 'oauth_nonce'), /^[0-9a-f]{32}$/);
    assert.notEqual(get(h1, 'oauth_nonce'), get(h2, 'oauth_nonce'));
    assert.ok(Number(get(h1, 'oauth_timestamp')) >= before && Number(get(h1, 'oauth_timestamp')) <= before + 5);
  });
  it('ヘッダーはパラメータ名の昇順で、値はすべて二重引用符で囲み、秘密そのものは含まない', () => {
    const header = buildAuthorizationHeader({ ...DOC, bodyParams: [] });
    const names = [...header.matchAll(/(oauth_\w+)="/g)].map((m) => m[1]);
    assert.deepEqual(names, [...names].sort());
    assert.equal(names.length, 7);
    assert.ok(!header.includes(DOC.consumerSecret) && !header.includes(DOC.tokenSecret));
    assert.ok(header.startsWith('OAuth '));
  });
});
