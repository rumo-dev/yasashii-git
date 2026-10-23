'use strict';
/** コミット履歴の分岐図（レーン割り当て）。ブラウザ/Node 両対応 */
function layoutGraph(commits) {
  let lanes = [];
  const rows = [];
  let maxLanes = 1;
  for (const c of commits) {
    const before = lanes.slice();
    let idx = lanes.indexOf(c.hash);
    if (idx === -1) {
      idx = lanes.indexOf(null);
      if (idx === -1) { idx = lanes.length; lanes.push(null); }
    }
    const edges = [];
    before.forEach((h, j) => { if (h === c.hash) edges.push({ a: j, ay: 0, b: idx, by: 0.5, ownerHash: c.hash }); });
    const after = lanes.slice();
    for (let j = 0; j < after.length; j++) if (after[j] === c.hash) after[j] = null;
    const ps = c.parents || [];
    if (ps.length) {
      let k = after.indexOf(ps[0]);
      if (k === -1) { after[idx] = ps[0]; k = idx; }
      edges.push({ a: idx, ay: 0.5, b: k, by: 1, ownerHash: c.hash });
      for (const p of ps.slice(1)) {
        let m = after.indexOf(p);
        if (m === -1) { m = after.indexOf(null); if (m === -1) { m = after.length; after.push(null); } after[m] = p; }
        edges.push({ a: idx, ay: 0.5, b: m, by: 1, ownerHash: p, branch: true });
      }
    }
    before.forEach((h, j) => { if (h !== null && h !== c.hash && after[j] === h) edges.push({ a: j, ay: 0, b: j, by: 1, ownerHash: h }); });
    while (after.length && after[after.length - 1] === null) after.pop();
    const width = Math.max(before.length, after.length, idx + 1);
    maxLanes = Math.max(maxLanes, width);
    rows.push({ lane: idx, edges, merge: ps.length > 1, hash: c.hash });
    lanes = after;
  }
  return { rows, maxLanes };
}
if (typeof module !== 'undefined') module.exports = { layoutGraph };
