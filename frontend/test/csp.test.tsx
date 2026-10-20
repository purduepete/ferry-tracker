import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const source = path.resolve(process.cwd(), 'frontend');
const built = path.join(source, 'dist');

describe('CSP-compatible pre-paint theme script', () => {
  it('loads a same-origin blocking script before the app without requiring an inline hash', () => {
    const html = readFileSync(path.join(source, 'index.html'), 'utf8');
    expect(html).toContain('<script src="/theme-init.js"></script>');
    expect(html).not.toMatch(/<script>/);
    expect(html.indexOf('/theme-init.js')).toBeLessThan(html.indexOf('/src/main.tsx'));
    expect(html).not.toMatch(/<script[^>]*(?:async|defer)[^>]*theme-init/);
  });

  it.skipIf(!existsSync(path.join(built, 'index.html')))('copies the script byte-for-byte into the production build', () => {
    expect(readFileSync(path.join(built, 'index.html'), 'utf8')).toContain('<script src="/theme-init.js"></script>');
    expect(readFileSync(path.join(built, 'theme-init.js'), 'utf8'))
      .toBe(readFileSync(path.join(source, 'public', 'theme-init.js'), 'utf8'));
  });
});
