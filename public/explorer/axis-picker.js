// 出演者・シリーズ・メーカー用の「検索式」選択部品（テキスト入力＋候補リスト）。
// 候補は呼び出し側が読み込み済みのカードデータから集計して渡す（ビルド時には埋め込まない）。
// 1軸につき1つだけ選べる。選ぶとチップで表示し、✕で解除する。

const MAX = 20; // 候補の表示上限

/** 全角半角・大文字小文字をそろえる（部分一致の比較用） */
export const norm = (s) => String(s).normalize('NFKC').toLowerCase().trim();

/** 値を名前ごとの件数に集計して、件数の多い順の配列にする */
export function tally(values) {
  const m = new Map();
  for (const v of values) if (v) m.set(v, (m.get(v) || 0) + 1);
  return [...m].map(([name, n]) => ({ name, n, key: norm(name) })).sort((a, b) => b.n - a.n || a.name.localeCompare(b.name, 'ja'));
}

const el = (tag, props = {}) => Object.assign(document.createElement(tag), props);

/**
 * root 内に部品を組み立てる。
 * 戻り値: setItems(集計済みの配列) / setValue(名前または空文字)
 */
export function createPicker(root, { label, onChange }) {
  const id = 'pk-' + root.dataset.axis;
  let items = [], value = '', shown = [], active = -1;

  const chipBox = el('div', { className: 'chips' });
  const input = el('input', {
    type: 'text', id: id + '-in', className: 'pk-input', placeholder: `${label}名を入力`, autocomplete: 'off',
    autocapitalize: 'off', spellcheck: false,
  });
  input.setAttribute('role', 'combobox');
  input.setAttribute('aria-label', label);
  input.setAttribute('aria-autocomplete', 'list');
  input.setAttribute('aria-expanded', 'false');
  input.setAttribute('aria-controls', id + '-list');
  const list = el('ul', { id: id + '-list', className: 'pk-list', hidden: true });
  list.setAttribute('role', 'listbox');
  list.setAttribute('aria-label', `${label}の候補`);
  const wrap = el('div', { className: 'pk-wrap' });
  wrap.append(input, list);
  root.append(chipBox, wrap);

  function setActive(i) {
    active = i;
    [...list.children].forEach((li, j) => li.setAttribute('aria-selected', String(j === i)));
    if (i >= 0 && list.children[i]) {
      input.setAttribute('aria-activedescendant', list.children[i].id);
      list.children[i].scrollIntoView({ block: 'nearest' });
    } else input.removeAttribute('aria-activedescendant');
  }
  function close() {
    list.hidden = true;
    input.setAttribute('aria-expanded', 'false');
    setActive(-1);
  }
  function open() {
    const q = norm(input.value);
    shown = (q ? items.filter((x) => x.key.includes(q)) : items).slice(0, MAX); // items は件数順
    list.textContent = '';
    shown.forEach((x, i) => {
      const li = el('li', { id: `${id}-o${i}`, className: 'pk-opt' });
      li.setAttribute('role', 'option');
      li.setAttribute('aria-selected', 'false');
      li.dataset.i = i;
      li.append(el('span', { textContent: x.name }), el('small', { textContent: `${x.n}件` }));
      list.append(li);
    });
    if (!shown.length) list.append(el('li', { className: 'pk-none', textContent: '該当する候補がありません' }));
    list.hidden = false;
    input.setAttribute('aria-expanded', 'true');
    setActive(-1);
  }
  function renderChip() {
    chipBox.textContent = '';
    wrap.hidden = !!value; // 1軸1つなので、選択中は入力欄を隠す
    if (!value) return;
    const b = el('button', { type: 'button', className: 'chip on pk-chip', textContent: `${value} ✕` });
    b.setAttribute('aria-label', `${label}「${value}」を解除`);
    b.addEventListener('click', () => { api.setValue(''); onChange(''); input.focus(); });
    chipBox.append(b);
  }
  function choose(i) {
    const x = shown[i];
    if (!x) return;
    input.value = '';
    close();
    api.setValue(x.name);
    onChange(x.name);
  }

  input.addEventListener('input', open);
  input.addEventListener('focus', open);
  input.addEventListener('blur', () => setTimeout(close, 120)); // 候補のクリックを先に受けてから閉じる
  input.addEventListener('keydown', (e) => {
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      if (list.hidden) open();
      if (!shown.length) return;
      const d = e.key === 'ArrowDown' ? 1 : -1;
      setActive((active + d + shown.length) % shown.length);
    } else if (e.key === 'Enter') {
      if (!list.hidden && shown.length) { e.preventDefault(); choose(active >= 0 ? active : 0); }
    } else if (e.key === 'Escape' && !list.hidden) {
      e.preventDefault(); e.stopPropagation(); close();
    }
  });
  list.addEventListener('mousedown', (e) => e.preventDefault()); // クリックで入力欄のフォーカスを失わない
  list.addEventListener('click', (e) => { const li = e.target.closest('[data-i]'); if (li) choose(Number(li.dataset.i)); });

  const api = {
    setItems(next) { items = next; if (!list.hidden) open(); },
    setValue(v) { value = v || ''; renderChip(); },
  };
  renderChip();
  return api;
}
