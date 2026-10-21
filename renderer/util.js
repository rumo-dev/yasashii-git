'use strict';
/* 画面側の補助関数（ブラウザでもNode.jsでも読み込める） */
(function (root) {
  /** git の差分テキストを、ファイル → 塊(ハンク) → 行 に分解する */
  function parseDiff(text) {
    const files = [];
    if (!text) return files;
    const all = text.split('\n');
    if (all[all.length - 1] === '') all.pop();
    let f = null;
    let h = null;
    for (const line of all) {
      if (line.startsWith('diff --git ') || line.startsWith('diff --cc ') || line.startsWith('diff --combined ')) {
        f = { header: [line], hunks: [], binary: false, title: '' };
        const m = line.match(/^diff --git a\/.* b\/(.*)$/);
        f.title = m ? m[1] : line.replace(/^diff --\w+ /, '');
        files.push(f);
        h = null;
      } else if (!f) {
        continue;
      } else if (line.startsWith('@@')) {
        const m = line.match(/^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/);
        h = { head: line, lines: [], oldStart: m ? +m[1] : 0, newStart: m ? +m[2] : 0 };
        f.hunks.push(h);
      } else if (h) {
        h.lines.push(line);
      } else {
        f.header.push(line);
        if (/^Binary files /.test(line) || /^GIT binary patch/.test(line)) f.binary = true;
      }
    }
    return files;
  }

  /** 1つの塊だけを適用するためのパッチ文字列を作る */
  function buildPatch(file, hunk) {
    return file.header.join('\n') + '\n' + hunk.head + '\n' + hunk.lines.join('\n') + '\n';
  }

  /** 履歴グラフの線の配置を計算する */
  function layoutGraph(commits) {
    let lanes = [];
    const rows = [];
    let max = 1;
    for (const c of commits) {
      let idx = lanes.indexOf(c.hash);
      const isNew = idx === -1;
      if (isNew) {
        idx = lanes.indexOf(null);
        if (idx === -1) { idx = lanes.length; lanes.push(c.hash); } else lanes[idx] = c.hash;
      }
      const before = lanes.slice();
      const incoming = [];
      const through = [];
      before.forEach((hh, i) => {
        if (hh === null || hh === undefined) return;
        if (hh === c.hash) { if (!(isNew && i === idx)) incoming.push(i); }
        else through.push(i);
      });
      for (let i = 0; i < lanes.length; i++) if (lanes[i] === c.hash) lanes[i] = null;
      const outgoing = [];
      c.parents.forEach((p, k) => {
        let j = lanes.indexOf(p);
        if (j === -1) {
          if (k === 0 && lanes[idx] === null) j = idx;
          else { j = lanes.indexOf(null); if (j === -1) j = lanes.length; }
          lanes[j] = p;
        }
        outgoing.push(j);
      });
      while (lanes.length && lanes[lanes.length - 1] === null) lanes.pop();
      const count = Math.max(before.length, lanes.length, idx + 1);
      max = Math.max(max, count);
      rows.push({ idx, incoming, through, outgoing, merge: c.parents.length > 1, count });
    }
    return { rows, width: max };
  }

  function relTime(iso) {
    const t = new Date(iso).getTime();
    if (isNaN(t)) return '';
    const s = Math.floor((Date.now() - t) / 1000);
    if (s < 60) return 'たった今';
    if (s < 3600) return Math.floor(s / 60) + '分前';
    if (s < 86400) return Math.floor(s / 3600) + '時間前';
    if (s < 86400 * 30) return Math.floor(s / 86400) + '日前';
    const d = new Date(t);
    return `${d.getFullYear()}年${d.getMonth() + 1}月${d.getDate()}日`;
  }

  function fullTime(iso) {
    const d = new Date(iso);
    if (isNaN(d)) return '';
    const p = (n) => String(n).padStart(2, '0');
    return `${d.getFullYear()}年${d.getMonth() + 1}月${d.getDate()}日 ${p(d.getHours())}:${p(d.getMinutes())}`;
  }

  function splitPath(p) {
    const i = p.lastIndexOf('/');
    return i < 0 ? { dir: '', name: p } : { dir: p.slice(0, i + 1), name: p.slice(i + 1) };
  }

  /** URLから保存先フォルダ名の候補を作る */
  function repoNameFromUrl(url) {
    const m = (url || '').trim().replace(/\/+$/, '').match(/([^/:]+?)(?:\.git)?$/);
    return m ? m[1] : '';
  }

  /**
   * 変更されたファイルから「記録のメモ」の下書きを作る。
   * 「記録に含めるファイル」があればそれだけ、無ければ（ぶつかり以外の）すべての変更が対象。
   * 例：「index.html と style.css を変更」「logo.png を追加」「a.txt を変更、b.css を追加」
   */
  function suggestMemo(files) {
    const list = (files || []).filter((f) => !f.conflict);
    const staged = list.filter((f) => f.staged);
    const target = staged.length ? staged : list;
    if (!target.length) return '';
    const useIndex = staged.length > 0;
    const kindOf = (f) => {
      const c = f.untracked ? '?' : (useIndex ? f.x : f.y);
      if (f.orig || c === 'R') return 'ren';
      if (c === '?' || c === 'A' || c === 'C') return 'add';
      if (c === 'D') return 'del';
      return 'mod';
    };
    // 同じ名前のファイルが別の場所にもある場合だけ、フォルダ付きで表示する
    const base = (p) => splitPath(p).name;
    const counts = {};
    target.forEach((f) => { const b = base(f.path); counts[b] = (counts[b] || 0) + 1; });
    const nm = (f) => (counts[base(f.path)] > 1 ? f.path : base(f.path));
    const groups = { mod: [], add: [], del: [], ren: [] };
    target.forEach((f) => groups[kindOf(f)].push(f.orig ? `${base(f.orig)} → ${nm(f)}` : nm(f)));
    const names = (a) => (a.length === 1 ? a[0] : a.length === 2 ? `${a[0]} と ${a[1]}` : a.length === 3 ? a.join('、') : `${a[0]}、${a[1]} ほか${a.length - 2}個のファイル`);
    const verb = { mod: 'を変更', add: 'を追加', del: 'を削除', ren: 'の名前を変更' };
    const parts = ['mod', 'add', 'del', 'ren'].filter((k) => groups[k].length).map((k) => { const n = names(groups[k]); return n + (/ファイル$/.test(n) ? '' : ' ') + verb[k]; });
    const text = parts.join('、');
    if (text.length <= 50 && parts.length <= 3) return text;
    const label = { mod: '変更', add: '追加', del: '削除', ren: '名前変更' };
    const detail = ['mod', 'add', 'del', 'ren'].filter((k) => groups[k].length).map((k) => `${label[k]}${groups[k].length}`).join('・');
    return `${target.length}個のファイルを更新（${detail}）`;
  }

  const api = { suggestMemo, parseDiff, buildPatch, layoutGraph, relTime, fullTime, splitPath, repoNameFromUrl };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.Util = api;
})(typeof window !== 'undefined' ? window : globalThis);
