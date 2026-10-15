// Temporary, checksum-bound source transfer. Creates blobs only; never refs, commits, PRs or releases.
import { readFileSync, writeFileSync, readdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { brotliDecompressSync } from 'node:zlib';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';

const repo = 'Emanuele-web04/synara';
const base = 'a21eb2b43dc16dcc33c55271070d3bdb4a3c1cfb';
const digest = 'b247eeec831b72069b3d81d45ce258017dc8a83e6a6d25b509356c36a2ba43bf';
if (process.env.GITHUB_REPOSITORY !== repo || process.env.GITHUB_REF !== 'refs/heads/feat/synara-editor-intelligence' || process.env.GITHUB_EVENT_NAME !== 'push') throw new Error('Unexpected execution scope.');
const cwd = resolve('candidate');
const git = (...args) => execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();
if (git('rev-parse', 'HEAD') !== base || git('status', '--porcelain')) throw new Error('Candidate is not the clean pinned baseline.');
const partDir = resolve('.integration-transfer');
const parts = readdirSync(partDir).filter((name) => /^part-\d\d\.br$/.test(name)).sort();
if (parts.length !== 7) throw new Error('Incomplete transfer.');
const patch = brotliDecompressSync(Buffer.concat(parts.map((name) => readFileSync(resolve(partDir, name)))), { maxOutputLength: 1_000_000 });
if (createHash('sha256').update(patch).digest('hex') !== digest) throw new Error('Patch checksum mismatch.');
execFileSync('git', ['apply', '--index', '--whitespace=error', '-'], { cwd, input: patch, stdio: ['pipe', 'inherit', 'inherit'] });
const paths = git('diff', '--cached', '--name-only', '-z').split('\0').filter(Boolean);
if (paths.length !== 44 || paths.some((p) => !/^(apps\/(server|web)\/|packages\/contracts\/src\/|docs\/editor\/|bun\.lock$|\.github\/workflows\/editor-integration-check\.yml$)/.test(p))) throw new Error('Unexpected changed paths.');
const files = [];
for (const path of paths) {
  const [mode, sha] = git('ls-files', '--stage', '--', path).split(/\s+/);
  if (mode !== '100644') throw new Error('Unexpected file mode.');
  const bytes = readFileSync(resolve(cwd, path));
  const contentHash = createHash('sha1').update(`blob ${bytes.length}\0`).update(bytes).digest('hex');
  if (contentHash !== sha) throw new Error('Index/worktree mismatch.');
  files.push({ path, mode, type: 'blob', sha, bytes: bytes.length });
}
const manifest = { base, patchSha256: digest, candidateTree: git('write-tree'), files };
writeFileSync(resolve(process.env.RUNNER_TEMP, 'editor-candidate-manifest.json'), JSON.stringify(manifest, null, 2));
execFileSync('git', ['archive', '--format=tar.gz', `--output=${resolve(process.env.RUNNER_TEMP, 'editor-candidate-source.tar.gz')}`, manifest.candidateTree], { cwd });
// Ingress only. The interactive GitHub connector performs the final reviewed tree,
// commit and fast-forward ref update. No publication endpoint is called here.
const token = process.env.SOURCE_BLOB_TOKEN;
if (!token) throw new Error('Missing blob-ingress credential.');
for (const file of files) {
  const response = await fetch(`https://api.github.com/repos/${repo}/git/blobs`, {
    method: 'POST', signal: AbortSignal.timeout(30_000),
    headers: { Authorization: `Bearer ${token}`, Accept: 'application/vnd.github+json', 'Content-Type': 'application/json', 'X-GitHub-Api-Version': '2022-11-28' },
    body: JSON.stringify({ content: readFileSync(resolve(cwd, file.path)).toString('base64'), encoding: 'base64' }),
  });
  if (!response.ok) throw new Error(`Blob ingress failed with HTTP ${response.status} for ${file.path}`);
  const result = await response.json();
  if (result.sha !== file.sha) throw new Error(`GitHub blob mismatch for ${file.path}`);
}
writeFileSync(resolve(process.env.RUNNER_TEMP, 'editor-blobs-ready.json'), JSON.stringify(manifest, null, 2));
console.log(`Verified and stored ${files.length} source blobs for ${manifest.candidateTree}; no refs modified.`);
