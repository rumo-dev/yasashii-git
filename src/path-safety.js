'use strict';

const path = require('path');
const fs = require('fs');

/** Resolve a project-relative path and reject absolute paths or traversal. */
function safeProjectPath(repo, rel = '') {
  const root = path.resolve(repo);
  if (path.isAbsolute(String(rel || ''))) throw new Error('プロジェクトの外のファイルは開けません。');
  const abs = path.resolve(root, String(rel || ''));
  const relative = path.relative(root, abs);
  if (relative === '..' || relative.startsWith('..' + path.sep) || path.isAbsolute(relative)) {
    throw new Error('プロジェクトの外のファイルは開けません。');
  }
  // Lexical containment is not enough when a project contains a symlink that points out.
  try {
    const realRoot = fs.realpathSync(root);
    const realTarget = fs.realpathSync(abs);
    const realRelative = path.relative(realRoot, realTarget);
    if (realRelative === '..' || realRelative.startsWith('..' + path.sep) || path.isAbsolute(realRelative)) {
      throw new Error('プロジェクトの外のファイルは開けません。');
    }
  } catch (e) {
    if (e.message === 'プロジェクトの外のファイルは開けません。') throw e;
    // A missing target will be reported by the operation that opens it.
  }
  return abs;
}

module.exports = { safeProjectPath };
