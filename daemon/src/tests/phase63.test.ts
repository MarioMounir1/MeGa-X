import { describe, it } from 'node:test';
import * as assert from 'node:assert';
import * as http from 'node:http';
import { bootstrapDaemon } from '../index';
import { MobileRelayServer } from '../relay/mobileRelayServer';

describe('Phase 63: Web Steering Wheel PWA Offline Manifest & Mobile Meta Tags', () => {
  it('serves valid PWA web app manifest via GET /manifest.json', async () => {
    const engine = bootstrapDaemon();
    const relay = new MobileRelayServer(engine, async () => {});
    const port = await relay.start(0, '127.0.0.1');

    try {
      const manifestJson = await new Promise<string>((resolve, reject) => {
        http
          .get(`http://127.0.0.1:${port}/manifest.json`, (res) => {
            assert.strictEqual(res.statusCode, 200);
            assert.ok(
              res.headers['content-type']?.includes('application/manifest+json')
            );
            let body = '';
            res.on('data', (c) => (body += c));
            res.on('end', () => resolve(body));
          })
          .on('error', reject);
      });

      const manifest = JSON.parse(manifestJson);
      assert.strictEqual(manifest.name, 'MeGa X Steering Wheel');
      assert.strictEqual(manifest.short_name, 'MeGa X');
      assert.strictEqual(manifest.start_url, '/');
      assert.strictEqual(manifest.display, 'standalone');
      assert.strictEqual(manifest.theme_color, '#0d1117');
      assert.ok(Array.isArray(manifest.icons) && manifest.icons.length > 0);
    } finally {
      await relay.stop();
    }
  });

  it('renders PWA manifest link and mobile web app meta tags in GET / HTML', async () => {
    const engine = bootstrapDaemon();
    const relay = new MobileRelayServer(engine, async () => {});
    const port = await relay.start(0, '127.0.0.1');

    try {
      const html = await new Promise<string>((resolve, reject) => {
        http
          .get(`http://127.0.0.1:${port}/`, (res) => {
            assert.strictEqual(res.statusCode, 200);
            let body = '';
            res.on('data', (c) => (body += c));
            res.on('end', () => resolve(body));
          })
          .on('error', reject);
      });

      assert.ok(html.includes('<link rel="manifest" href="/manifest.json" />'));
      assert.ok(html.includes('<meta name="theme-color" content="#0d1117" />'));
      assert.ok(
        html.includes(
          '<meta name="apple-mobile-web-app-capable" content="yes" />'
        )
      );
      assert.ok(
        html.includes(
          '<meta name="apple-mobile-web-app-title" content="MeGa X" />'
        )
      );
    } finally {
      await relay.stop();
    }
  });
});
