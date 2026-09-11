import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

// Mirrors script-src in the Cloudflare Transform Rule. The browser hashes the exact bytes it is
// served, so this value must never be normalized and must be updated in Cloudflare in lockstep.
// .gitattributes pins index.html to LF so the bytes do not depend on the OS that checked it out.
const EXPECTED_THEME_SCRIPT_HASH = 'sha256-zmWzz+eVIE4YDlhZ1idw65PsmpiOGcNg1ZceiykhvJk=';

const sourceHtml = path.resolve(process.cwd(), 'frontend/index.html');
const builtHtml = path.resolve(process.cwd(), 'frontend/dist/index.html');

function inlineScript(file: string): string {
  const match = /<script>([\s\S]*?)<\/script>/.exec(readFileSync(file, 'utf8'));
  if (!match) throw new Error(`No inline <script> found in ${file}`);
  return match[1];
}

function cspHash(script: string): string {
  return `sha256-${createHash('sha256').update(script, 'utf8').digest('base64')}`;
}

describe('CSP hash for the inline theme script', () => {
  it('matches the hash configured in the Cloudflare Transform Rule', () => {
    const actual = cspHash(inlineScript(sourceHtml));
    expect(
      actual,
      `The inline theme script changed. Update script-src in the Cloudflare Transform Rule to '${actual}' and put the same value here, or the theme silently breaks on the public hostname only.`,
    ).toBe(EXPECTED_THEME_SCRIPT_HASH);
  });

  it.skipIf(!existsSync(builtHtml))('emits the inline script into the build byte-for-byte', () => {
    // A line-ending difference between source and dist would invalidate the hash in the browser.
    expect(inlineScript(builtHtml)).toBe(inlineScript(sourceHtml));
  });
});
