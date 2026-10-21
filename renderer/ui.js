'use strict';
/* 共通UI部品：要素生成・モーダル・通知・処理中表示。innerHTML は使わず textContent のみ（XSS対策） */

const Views = {};

function h(tag, props, ...kids) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(props || {})) {
    if (v == null || v === false) continue;
    if (k === 'class') el.className = v;
    else if (k === 'style' && typeof v === 'object') Object.assign(el.style, v);
    else if (k.startsWith('on') && typeof v === 'function') el.addEventListener(k.slice(2).toLowerCase(), v);
    else if (k === 'text') el.textContent = v;
    else if (k === 'dataset') Object.assign(el.dataset, v);
    else if (['value', 'checked', 'disabled', 'title', 'type', 'placeholder', 'id', 'maxLength', 'rows', 'selected', 'readOnly', 'hidden', 'href', 'name'].includes(k)) el[k] = v;
    else el.setAttribute(k, v === true ? '' : v);
  }
  const add = (kid) => {
    if (kid == null || kid === false) return;
    if (Array.isArray(kid)) kid.forEach(add);
    else el.appendChild(kid instanceof Node ? kid : document.createTextNode(String(kid)));
  };
  kids.forEach(add);
  return el;
}
const $ = (sel, root = document) => root.querySelector(sel);
const clear = (el) => { while (el.firstChild) el.removeChild(el.firstChild); return el; };

/** 用語ラベル：やさしい言い方 + 小さく原語 */
function termLabel(key, opts = {}) {
  const t = TERMS[key];
  const span = h('span', { title: t.hint });
  span.appendChild(document.createTextNode(opts.text || t.ja));
  if (settingsRef.showOriginal && !opts.noEn) span.appendChild(h('span', { class: 'en' }, t.en));
  return span;
}

/* ---------------- 日時 ---------------- */
function relTime(iso) {
  const d = new Date(iso); if (isNaN(d)) return '';
  const s = (Date.now() - d.getTime()) / 1000;
  if (s < 60) return 'たった今';
  if (s < 3600) return `${Math.floor(s / 60)}分前`;
  if (s < 86400) return `${Math.floor(s / 3600)}時間前`;
  if (s < 86400 * 30) return `${Math.floor(s / 86400)}日前`;
  if (s < 86400 * 365) return `${Math.floor(s / 86400 / 30)}か月前`;
  return `${Math.floor(s / 86400 / 365)}年前`;
}
function fullTime(iso) {
  const d = new Date(iso); if (isNaN(d)) return '';
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}年${d.getMonth() + 1}月${d.getDate()}日 ${p(d.getHours())}:${p(d.getMinutes())}`;
}

/* ---------------- 通知 ---------------- */
function toast(msg, kind) {
  const el = h('div', { class: 'toast' + (kind === 'error' ? ' error' : '') }, msg);
  $('#toasts').appendChild(el);
  setTimeout(() => el.remove(), kind === 'error' ? 6000 : 3200);
}

/* ---------------- 処理中表示 ---------------- */
let busyCount = 0;
function busyOn(text) { busyCount++; $('#busyProg').hidden = true; $('#busyText').textContent = text || '処理中…'; $('#busy').hidden = false; }
function busyOff() { busyCount = Math.max(0, busyCount - 1); if (!busyCount) { $('#busy').hidden = true; $('#busyProg').hidden = true; } }
/** 処理中の画面に進み具合（%の帯）を出す。p: { percent, label, rate, size, done, total } */
function busyProgress(p) {
  if ($('#busy').hidden) return;
  $('#busyProg').hidden = false;
  $('#busyBar').style.width = Math.max(2, Math.min(100, p.percent || 0)) + '%';
  $('#busyText').textContent = `${p.label || '処理中'}… ${Math.round(p.percent || 0)}%`;
  const bits = [];
  if (p.total) bits.push(`${p.done}/${p.total} 個`);
  if (p.size) bits.push(p.size);
  if (p.rate) bits.push(p.rate);
  $('#busyDetail').textContent = bits.join('　');
}
const isBusy = () => busyCount > 0 || document.querySelector('.overlay');

/* ---------------- モーダル ---------------- */
function modal({ title, body, buttons, wide = false, onOpen }) {
  return new Promise((resolve) => {
    const overlay = h('div', { class: 'overlay' });
    const m = h('div', { class: 'modal' + (wide ? ' wide' : ''), role: 'dialog', 'aria-modal': 'true' });
    const close = (v) => { document.removeEventListener('keydown', onKey, true); overlay.remove(); resolve(v); };
    const onKey = (e) => {
      if (e.key === 'Escape') { e.stopPropagation(); close(undefined); }
      else if (e.key === 'Enter' && !e.shiftKey && e.target.tagName !== 'TEXTAREA' && e.target.tagName !== 'BUTTON') {
        const primary = buttons.find((b) => b.kind === 'primary' || b.kind === 'danger-solid');
        if (primary) { e.preventDefault(); pressed(primary); }
      }
    };
    const pressed = (b) => {
      if (b.validate) { const msg = b.validate(); if (msg) { errBox.textContent = msg; errBox.hidden = false; return; } }
      close(b.value === undefined ? true : typeof b.value === 'function' ? b.value() : b.value);
    };
    const errBox = h('div', { class: 'danger-note', hidden: true });
    m.appendChild(h('header', {}, title));
    m.appendChild(h('div', { class: 'mbody' }, body, errBox));
    m.appendChild(h('footer', {}, buttons.map((b) => h('button', {
      class: 'btn' + (b.kind === 'primary' ? ' primary' : b.kind === 'danger-solid' ? ' danger solid' : b.kind === 'danger' ? ' danger' : ''),
      onclick: () => pressed(b),
    }, b.label))));
    overlay.appendChild(m);
    overlay.addEventListener('mousedown', (e) => { if (e.target === overlay) close(undefined); });
    document.addEventListener('keydown', onKey, true);
    document.body.appendChild(overlay);
    const first = m.querySelector('input:not([type=checkbox]), textarea, select');
    if (first) first.focus(); else { const pb = m.querySelector('.btn.primary, .btn.solid'); if (pb) pb.focus(); }
    if (onOpen) onOpen(m);
  });
}

async function confirmDialog({ title, message, okLabel = 'OK', danger = false, note }) {
  const body = h('div', {}, h('p', { style: { whiteSpace: 'pre-wrap', margin: '4px 0' } }, message), note ? h('div', { class: 'danger-note' }, note) : null);
  const r = await modal({ title, body, buttons: [{ label: 'キャンセル', value: false }, { label: okLabel, kind: danger ? 'danger-solid' : 'primary', value: true }] });
  return r === true;
}

/** fields: [{key,label,type:'text'|'textarea'|'select'|'checkbox'|'password',value,placeholder,help,required,options:[{value,label}]}] */
async function formDialog({ title, intro, fields, okLabel = 'OK', danger = false, wide = false }) {
  const inputs = {};
  const body = h('div', {}, intro ? h('p', { class: 'muted', style: { whiteSpace: 'pre-wrap', marginTop: 0 } }, intro) : null,
    fields.map((f) => {
      let input;
      if (f.type === 'textarea') input = h('textarea', { value: f.value || '', placeholder: f.placeholder || '', rows: f.rows || 4 });
      else if (f.type === 'select') input = h('select', {}, f.options.map((o) => h('option', { value: o.value, selected: o.value === f.value }, o.label)));
      else if (f.type === 'checkbox') input = h('input', { type: 'checkbox', checked: !!f.value });
      else input = h('input', { type: f.type || 'text', value: f.value || '', placeholder: f.placeholder || '', class: f.mono ? 'code-input' : '' });
      inputs[f.key] = input;
      if (f.type === 'checkbox') return h('label', { class: 'check field' }, input, h('div', {}, h('div', {}, f.label), f.help ? h('small', {}, f.help) : null));
      return h('label', { class: 'field' }, h('span', {}, f.label), input, f.help ? h('small', {}, f.help) : null);
    }));
  const collect = () => Object.fromEntries(fields.map((f) => [f.key, f.type === 'checkbox' ? inputs[f.key].checked : inputs[f.key].value]));
  return modal({
    title, body, wide,
    buttons: [
      { label: 'キャンセル', value: undefined },
      { label: okLabel, kind: danger ? 'danger-solid' : 'primary', value: collect,
        validate: () => { for (const f of fields) if (f.required && !String(inputs[f.key].value || '').trim()) return `「${f.label}」を入力してください。`; return null; } },
    ],
  });
}

async function promptDialog({ title, label, value = '', placeholder = '', help, okLabel = 'OK' }) {
  const r = await formDialog({ title, fields: [{ key: 'v', label, value, placeholder, help, required: true }], okLabel });
  return r ? r.v.trim() : null;
}

/** 本人が「キャンセル」「中止」した結果のエラーかどうか（この場合はポップアップを出さない） */
function isCancelError(e) {
  const m = String((e && e.message) || e || '');
  return !!(e && e.cancelled) || /ログインを中止しました|キャンセルされました|中止されました|\b(cancell?ed|canceled by user|aborted by user)\b/i.test(m);
}
async function showError(e) {
  if (isCancelError(e)) return;
  // ログイン切れ・SSH鍵のエラーは、エラーの箱の前に、その場で再ログインへ案内する（recovery.js）
  if (e && e.kind && !e.authHandled && typeof recoverAuth === 'function') {
    e.authHandled = true;
    const r = await recoverAuth(e);
    if (r === 'retry') { toast('ログインを直しました。もう一度、操作をお試しください。'); return; }
    if (r === 'declined') return;
  }
  const body = h('div', {}, h('p', { style: { whiteSpace: 'pre-wrap', marginTop: 0 } }, e.message || String(e)),
    e.detail ? h('details', {}, h('summary', { class: 'muted' }, 'くわしい内容（Gitからのメッセージ）'), h('pre', {}, e.detail)) : null);
  await modal({ title: '⚠ うまくいきませんでした', body, buttons: [{ label: '閉じる', kind: 'primary', value: true }] });
}

/** 処理を実行：処理中表示 → 失敗ならエラー表示。成功時は結果、失敗時は undefined を返す */
async function withBusy(text, fn) {
  busyOn(text);
  try { return await runRecoverable(text, fn); }
  catch (e) { busyOff(); await showError(e); busyOn(text); return undefined; }
  finally { busyOff(); }
}
/** 処理中表示のまま実行。ログイン切れなら、処理中表示をいったん外して再ログインへ案内し、直ったら1回だけやり直す。失敗は投げる */
async function withBusyThrow(text, fn) {
  busyOn(text);
  try { return await runRecoverable(text, fn); }
  finally { busyOff(); }
}
function runRecoverable(text, fn) {
  if (typeof withAuthRecovery !== 'function') return fn();
  return withAuthRecovery(fn, { onPause: busyOff, onResume: () => busyOn(text) });
}

/* ---------------- 差分の解析と描画 ---------------- */
function parseDiff(text) {
  const lines = text.split('\n');
  const headerLines = []; const hunks = []; let cur = null; let binary = false;
  for (const l of lines) {
    if (l.startsWith('@@')) { cur = { header: l, lines: [] }; hunks.push(cur); }
    else if (cur) cur.lines.push(l);
    else { headerLines.push(l); if (/^Binary files|^GIT binary patch/.test(l)) binary = true; }
  }
  if (cur) while (cur.lines.length && cur.lines[cur.lines.length - 1] === '') cur.lines.pop();
  return { headerLines, hunks, binary };
}

/** 差分表示。hunkActions: [{label, danger, run(patchText)}] を各かたまりに付ける */
function renderDiff(text, { hunkActions = [] } = {}) {
  const wrap = h('div', { class: 'diff' });
  if (!text || !text.trim()) return h('div', { class: 'diff-note' }, '表示できる変更内容がありません。');
  const d = parseDiff(text);
  if (d.binary) return h('div', { class: 'diff-note' }, '画像などのバイナリファイルのため、内容は表示できません。');
  if (!d.hunks.length) return h('div', { class: 'diff-note' }, d.headerLines.filter((x) => /^(new|deleted|old|rename|similarity)/.test(x)).join('\n') || '内容の変更はありません。（ファイルの名前や権限のみの変更）');
  const header = d.headerLines.join('\n') + '\n';
  for (const hk of d.hunks) {
    const m = hk.header.match(/^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@\s?(.*)$/);
    let o = m ? +m[1] : 0; let n = m ? +m[2] : 0;
    const acts = hunkActions.map((a) => h('button', { class: 'btn small' + (a.danger ? ' danger' : ''), onclick: () => a.run(header + hk.header + '\n' + hk.lines.join('\n') + '\n') }, a.label));
    wrap.appendChild(h('div', { class: 'hunk-head' }, h('span', { class: 'grow' }, m ? `${n}行目付近 ${m[3] || ''}` : hk.header), acts));
    for (const l of hk.lines) {
      const c = l[0];
      if (c === '\\') { wrap.appendChild(h('div', { class: 'ln meta' }, h('span', { class: 'no' }), h('span', { class: 'no' }), h('span', { class: 'tx' }, '（ファイルの末尾に改行がありません）'))); continue; }
      const kind = c === '+' ? 'add' : c === '-' ? 'del' : 'ctx';
      const no1 = kind === 'add' ? '' : o++; const no2 = kind === 'del' ? '' : n++;
      wrap.appendChild(h('div', { class: 'ln ' + kind }, h('span', { class: 'no' }, no1), h('span', { class: 'no' }, no2), h('span', { class: 'tx' }, l.slice(1) || ' ')));
    }
  }
  return wrap;
}

function splitPath(p) {
  const i = p.lastIndexOf('/');
  return i < 0 ? { dir: '', base: p } : { dir: p.slice(0, i + 1), base: p.slice(i + 1) };
}

/** 右クリックメニュー。items: [{ label, onclick, danger, disabled } | 'sep'] */
function contextMenu(e, items) {
  e.preventDefault(); e.stopPropagation();
  closeContextMenu();
  const menu = h('div', { class: 'ctx-menu', id: 'ctxMenu', role: 'menu' });
  items.forEach((it) => {
    if (it === 'sep') return menu.appendChild(h('div', { class: 'ctx-sep' }));
    menu.appendChild(h('button', { class: 'ctx-item' + (it.danger ? ' danger' : ''), disabled: !!it.disabled, role: 'menuitem',
      onclick: (ev) => { ev.stopPropagation(); closeContextMenu(); it.onclick && it.onclick(); } }, it.label));
  });
  document.body.appendChild(menu);
  const r = menu.getBoundingClientRect();
  menu.style.left = Math.max(4, Math.min(e.clientX, window.innerWidth - r.width - 4)) + 'px';
  menu.style.top = Math.max(4, Math.min(e.clientY, window.innerHeight - r.height - 4)) + 'px';
  setTimeout(() => {
    window.addEventListener('click', closeContextMenu, { once: true });
    window.addEventListener('blur', closeContextMenu, { once: true });
    window.addEventListener('keydown', (k) => { if (k.key === 'Escape') closeContextMenu(); }, { once: true });
    window.addEventListener('resize', closeContextMenu, { once: true });
  }, 0);
}
function closeContextMenu() { const m = document.getElementById('ctxMenu'); if (m) m.remove(); }
