// yt-dlp for the YouTube plugin: downloads the standalone program into the plugin's data folder the first time,
// keeps it up to date (YouTube changes often) and runs it with Node as its JavaScript runtime.

import fs from 'node:fs';
import path from 'node:path';
import { execFile } from 'node:child_process';

const RELEASES = 'https://github.com/yt-dlp/yt-dlp/releases/latest/download/';

function assetName() {
  if (process.platform === 'win32') return 'yt-dlp.exe';
  if (process.platform === 'darwin') return 'yt-dlp_macos';
  return process.arch === 'arm64' ? 'yt-dlp_linux_aarch64' : 'yt-dlp_linux';
}

export function createYtdlp(api) {
  const bin = path.join(api.dataDir, process.platform === 'win32' ? 'yt-dlp.exe' : 'yt-dlp');
  let ready = null;
  let version = null;

  async function download() {
    api.log(`downloading yt-dlp (${assetName()})…`);
    const r = await fetch(RELEASES + assetName(), { signal: AbortSignal.timeout(180000) });
    if (!r.ok) throw new Error(`Could not download yt-dlp (${r.status})`);
    const tmp = `${bin}.part`;
    fs.mkdirSync(api.dataDir, { recursive: true });
    fs.writeFileSync(tmp, Buffer.from(await r.arrayBuffer()));
    fs.chmodSync(tmp, 0o755);
    fs.renameSync(tmp, bin);
  }

  /** yt-dlp is there (downloaded if needed). */
  function ensure() {
    ready ||= (fs.existsSync(bin) ? Promise.resolve() : download()).catch((e) => { ready = null; throw e; });
    return ready;
  }

  function exec(args, timeout) {
    return new Promise((resolve, reject) => {
      execFile(bin, args, { timeout, maxBuffer: 128 * 1024 * 1024, windowsHide: true }, (err, stdout, stderr) => {
        if (err) {
          const msg = String(stderr || err.message).split('\n').find((l) => l.startsWith('ERROR')) || String(stderr || err.message).trim().split('\n').pop();
          return reject(new Error(msg.replace(/^ERROR:\s*(\[[^\]]+\]\s*)?/, '').slice(0, 300) || 'yt-dlp failed'));
        }
        resolve(stdout);
      });
    });
  }

  /** Runs yt-dlp and returns its JSON output. */
  async function json(args, timeout = 60000) {
    await ensure();
    const out = await exec(['--no-warnings', '--ignore-config', '--js-runtimes', `node:${process.execPath}`, '-J', ...args], timeout);
    return JSON.parse(out);
  }

  /** Updates yt-dlp to the newest version (it updates itself). */
  async function update() {
    try {
      await ensure();
      const out = await exec(['-U'], 120000);
      const line = out.trim().split('\n').pop();
      version = (await exec(['--version'], 20000)).trim();
      api.log(`yt-dlp ${version}${/Updated/i.test(out) ? ' (updated)' : ''}${line && !/up to date|Updated/i.test(line) ? ` – ${line}` : ''}`);
    } catch (e) {
      api.log(`yt-dlp update: ${e.message}`);
    }
  }

  return { ensure, json, update, get version() { return version; } };
}
