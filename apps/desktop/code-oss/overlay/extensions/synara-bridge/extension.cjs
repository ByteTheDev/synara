'use strict';

const vscode = require('vscode');
const path = require('node:path');
const fs = require('node:fs/promises');

function contained(root, filename) {
  if (typeof filename !== 'string' || !filename || filename.length > 8192 || filename.includes('\0') || path.isAbsolute(filename)) {
    throw new Error('Expected a workspace-relative Git path.');
  }
  const absolute = path.resolve(root, filename);
  const relative = path.relative(root, absolute);
  if (!relative || relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    throw new Error('The Git path must remain inside its workspace.');
  }
  return absolute;
}

/** Registers no view, terminal, agent, task runner or application lifecycle. */
function activate(context) {
  context.subscriptions.push(vscode.commands.registerCommand('synara.native.git', async (request) => {
    if (!vscode.workspace.isTrusted) throw new Error('Trust this workspace before changing its Git index.');
    if (!request || !['stage', 'unstage'].includes(request.operation) ||
        typeof request.root !== 'string' || !path.isAbsolute(request.root) ||
        !Array.isArray(request.paths) || request.paths.length === 0 || request.paths.length > 1000) {
      throw new Error('Invalid Synara Git operation.');
    }
    const root = path.resolve(request.root);
    const workspaceRoot = vscode.workspace.workspaceFolders?.find((folder) => path.resolve(folder.uri.fsPath) === root);
    if (!workspaceRoot) throw new Error('The requested workspace is not open in Synara.');
    const rootReal = await fs.realpath(root);
    const paths = request.paths.map((filename) => contained(root, filename));
    for (const filename of paths) {
      // A symlink file itself is a valid Git index entry. Its parent may not
      // resolve outside the granted root, including through a directory link.
      let parent = path.dirname(filename);
      let actual;
      for (;;) {
        try { actual = await fs.realpath(parent); break; }
        catch (error) {
          if (error.code !== 'ENOENT' || parent === root) throw error;
          parent = path.dirname(parent);
        }
      }
      const relative = path.relative(rootReal, actual);
      if (relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
        throw new Error('A Git path resolves outside the selected workspace.');
      }
    }
    const extension = vscode.extensions.getExtension('vscode.git');
    if (!extension) throw new Error('The built-in Git extension is unavailable.');
    const git = (await extension.activate()).getAPI(1);
    const repository = git.getRepository(workspaceRoot.uri) ?? await git.openRepository(workspaceRoot.uri);
    if (!repository) throw new Error('The selected workspace is not a Git repository.');
    if (request.operation === 'stage') await repository.add(paths);
    else await repository.restore(paths, { staged: true });
    await repository.status();
    return null;
  }));
}

exports.activate = activate;
