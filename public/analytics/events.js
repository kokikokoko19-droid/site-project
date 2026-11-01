/*
 * 計測イベント（GA4）の送信。全ページで <script is:inline defer src="/analytics/events.js"> として読み込む。
 *
 * 方針
 *  - イベント委任のみ。document に1回だけ登録するので、後から差し込まれる要素
 *    （探索ページのカードやモーダル）のクリックも拾える。
 *  - gtag が無い（PUBLIC_GA4_ID 未設定、合成データ、開発時）ときは何も送らず、
 *    window.__events に { name, params } を積むだけにする（ブラウザでの動作確認用）。
 *  - 個人を特定できる値は送らない。検索語は送らず、文字数だけ送る。作品名や出演者名も送らない。
 *  - ページを離れる操作（リンクや検索の送信）は transport_type: 'beacon' で送り、遷移で取りこぼさないようにする。
 *  - 登録は capture 段階で行う。ほかのスクリプトが伝播を止めても拾えるようにするため。
 *    （ここでは preventDefault も stopPropagation もしない。既存の動作は変えない）
 */
(function () {
  'use strict';
  if (window.__eventsBound) return;
  window.__eventsBound = true;

  var LOG_LIMIT = 200;
  window.__events = window.__events || [];

  /** イベントを送る。空文字と null の値は落とす。計測の失敗でページを壊さない */
  function send(name, params) {
    try {
      var p = {};
      for (var k in params) {
        if (params[k] !== '' && params[k] != null) p[k] = params[k];
      }
      if (typeof window.gtag === 'function') {
        window.gtag('event', name, p);
        return;
      }
      window.__events.push({ name: name, params: p });
      if (window.__events.length > LOG_LIMIT) window.__events.shift();
    } catch (e) {
      /* 何もしない */
    }
  }

  /** 同じサイト内のリンクなら pathname を返す。外部リンクや解釈できない値は '' */
  function pathOf(href) {
    try {
      var u = new URL(href, location.href);
      return u.origin === location.origin ? u.pathname : '';
    } catch (e) {
      return '';
    }
  }

  /** '/go/abc/' のようなパスから、接頭辞（go など）の次の1区間（作品ID）を取り出す。無ければ '' */
  function idAfter(path, prefix) {
    var parts = path.split('/'); // ['', 'go', 'abc', '']
    if (parts[1] !== prefix || !parts[2]) return '';
    try {
      return decodeURIComponent(parts[2]);
    } catch (e) {
      return parts[2];
    }
  }

  /** 作品ページ（/v/{id}/）にいるときの作品ID。それ以外は '' */
  function currentWorkId() {
    return idAfter(location.pathname, 'v');
  }

  /** 探索ページの絞り込みチップの種類（data-len / data-g / data-lab）を名前にする */
  var CHIP_KEYS = { len: 'len', g: 'genre', lab: 'label' };
  function chipKey(el) {
    for (var k in CHIP_KEYS) {
      if (k in el.dataset) return CHIP_KEYS[k];
    }
    return 'other';
  }

  function onClick(e) {
    var t = e.target;
    if (!t || !t.closest) return;
    var el;

    // FANZAへのボタン（PR）。リンク先は中継ページ /go/{id}/ なので、その id を作品IDとして送る。
    // data-cta 付きのボタンのほか、/go/ へのリンクはすべて対象にする
    // （探索ページのモーダル内のボタンは JS で組み立てていて、data-cta が付いていないため）
    if ((el = t.closest('[data-cta], a[href^="/go/"]'))) {
      send('cta_click', {
        content_id: idAfter(pathOf(el.getAttribute('href') || ''), 'go') || currentWorkId(),
        cta_type: el.getAttribute('data-cta') || (el.closest('#modal') ? 'modal' : 'link'),
        transport_type: 'beacon',
      });
      return;
    }

    // サンプル動画の再生ボタン（SampleMovie.astro）
    if ((el = t.closest('[data-sample-play]'))) {
      send('sample_play', { content_id: currentWorkId() });
      return;
    }

    // 探索ページの絞り込みチップ
    if ((el = t.closest('#panel .chip'))) {
      send('filter_use', { filter: 'chip', filter_key: chipKey(el) });
      return;
    }

    // 軸ページへの移動（作品ページの軸リンク、トップの入口）
    if ((el = t.closest('.axis-links a, .entry a'))) {
      send('axis_nav', {
        axis: pathOf(el.getAttribute('href') || '').split('/')[1],
        place: el.closest('.axis-links') ? 'work' : 'entry',
        transport_type: 'beacon',
      });
      return;
    }

    // 作品カード（一覧・探索結果・モーダル内の似た作品）
    if ((el = t.closest('.card'))) {
      var link = el.matches('a[href]') ? el : el.querySelector('a[href]');
      send('card_open', {
        content_id: el.getAttribute('data-id') || (link ? idAfter(pathOf(link.getAttribute('href')), 'v') : ''),
        place: el.closest('#modal') ? 'modal' : el.closest('#results') ? 'explore' : 'list',
        transport_type: 'beacon',
      });
    }
  }

  // 探索ページの絞り込み（選択・チェック・スライダー）。スライダーは動かし終えたとき（change）だけ送る
  function onChange(e) {
    var el = e.target;
    if (!el || !el.closest || !el.closest('#panel')) return;
    var id = (el.id || '').replace(/^f-/, '');
    var tag = el.tagName;
    if (tag === 'SELECT') {
      // 選んだ値（出演者名など）は送らない。指定したか、解除したかだけ
      send('filter_use', { filter: 'select', filter_key: id, filter_value: el.value === '' ? 'clear' : 'set' });
    } else if (tag === 'INPUT' && el.type === 'checkbox') {
      send('filter_use', { filter: 'checkbox', filter_key: id, filter_value: el.checked ? 1 : 0 });
    } else if (tag === 'INPUT' && el.type === 'range') {
      var v = Number(el.value);
      send('filter_use', {
        filter: 'slider',
        filter_key: el.getAttribute('data-k') || id,
        filter_value: isFinite(v) ? v : '',
      });
    }
  }

  // 検索フォーム（ヘッダー、探索ページ）。検索語は送らず、文字数だけ送る。空の送信は数えない
  function onSubmit(e) {
    var form = e.target;
    if (!form || !form.querySelector) return;
    var input = form.querySelector('input[type="search"], input[name="q"]');
    if (!input) return;
    var length = Array.from(String(input.value || '').trim()).length;
    if (length === 0) return;
    send('search', {
      query_length: length,
      place: form.closest('header') ? 'header' : 'page',
      transport_type: 'beacon',
    });
  }

  document.addEventListener('click', onClick, true);
  document.addEventListener('change', onChange, true);
  document.addEventListener('submit', onSubmit, true);
})();
