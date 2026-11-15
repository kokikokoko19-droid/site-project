import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { discountRate, monthDay, sampleSmallUrl } from '../src/lib/format.ts';

describe('monthDay', () => {
  it('月/日を先頭の0なしで返す。欠損や形式違いは空文字', () => {
    assert.equal(monthDay('2026-12-04'), '12/4');
    assert.equal(monthDay('2026-01-10T10:00:00'), '1/10');
    assert.equal(monthDay(null), '');
    assert.equal(monthDay('12/4'), '');
  });
});

describe('discountRate', () => {
  it('定価が高いときだけ整数の割引率', () => {
    assert.equal(discountRate(1400, 2000), 30);
    assert.equal(discountRate(1480, 1980), 25);
    assert.equal(discountRate(2000, 2000), null);
    assert.equal(discountRate(2100, 2000), null);
    assert.equal(discountRate(null, 2000), null);
    assert.equal(discountRate(100, 0), null);
    assert.equal(discountRate(1999, 2000), null); // 丸めて0%になるときは出さない
  });
});

describe('sampleSmallUrl', () => {
  it('大きい版から小さい版を組み立てる', () => {
    assert.equal(sampleSmallUrl('https://pics.example.invalid/digital/video/abc00123/abc00123jp-1.jpg'), 'https://pics.example.invalid/digital/video/abc00123/abc00123-1.jpg');
    assert.equal(sampleSmallUrl('https://pics.example.invalid/x/abc00123/abc00123jp-15.jpg'), 'https://pics.example.invalid/x/abc00123/abc00123-15.jpg');
  });
  it('形が合わないときは null', () => {
    assert.equal(sampleSmallUrl('https://pics.example.invalid/x/abc00123/abc00123-1.jpg'), null);
    assert.equal(sampleSmallUrl('https://pics.example.invalid/x/abc00123/abc00123jp-1.png'), null);
    assert.equal(sampleSmallUrl('https://pics.example.invalid/x/abc00123/abc00123jp-a.jpg'), null);
    assert.equal(sampleSmallUrl(''), null);
  });
});
