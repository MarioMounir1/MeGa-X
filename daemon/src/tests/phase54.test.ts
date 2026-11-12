import { describe, it } from 'node:test';
import * as assert from 'node:assert';
import {
  stripAnsi,
  escapeHtml,
  ansiToHtml,
  colorize,
} from '../relay/ansiHelper';
import { MobileRelayServer } from '../relay/mobileRelayServer';

describe('Phase 54: Embedded Web Steering Wheel ANSI Terminal Renderer (xterm & ANSI Streaming)', () => {
  it('strips ANSI color codes from terminal text cleanly', () => {
    const raw = '\x1b[32mPASSED\x1b[0m: \x1b[1m\x1b[34m34 tests\x1b[0m passed';
    const stripped = stripAnsi(raw);
    assert.strictEqual(stripped, 'PASSED: 34 tests passed');
  });

  it('sanitizes HTML entities and converts ANSI escape sequences into styled HTML spans', () => {
    const raw = '\x1b[31m<script>alert("xss")</script>\x1b[0m \x1b[32mOK\x1b[0m';
    const html = ansiToHtml(raw);

    // Verifies XSS prevention
    assert.strictEqual(html.includes('<script>'), false);
    assert.ok(html.includes('&lt;script&gt;'));

    // Verifies color spans
    assert.ok(html.includes('style="color:#f85149;"')); // Red for error
    assert.ok(html.includes('style="color:#3fb950;"')); // Green for OK
  });

  it('supports compound styling with bold and colors via colorize utility', () => {
    const coloredRed = colorize('FAIL', 'red');
    assert.strictEqual(coloredRed, '\x1b[31mFAIL\x1b[39m');

    const coloredGreen = colorize('PASS', 'green');
    assert.strictEqual(coloredGreen, '\x1b[32mPASS\x1b[39m');
  });

  it('renders Web Steering Wheel dashboard with embedded ANSI parser and stream toolbar', () => {
    const html = MobileRelayServer.renderWebSteeringWheelHtml();

    // Verifies HTML document structure
    assert.ok(html.includes('<!DOCTYPE html>'));
    assert.ok(html.includes('<title>MeGa X • Mobile Steering Wheel</title>'));

    // Verifies ANSI palette and rendering logic
    assert.ok(html.includes('ANSI_PALETTE'));
    assert.ok(html.includes('renderAnsiString'));
    assert.ok(html.includes('escapeHtmlText'));

    // Verifies terminal toolbar controls
    assert.ok(html.includes('setFilter(\'ALL\')'));
    assert.ok(html.includes('setFilter(\'stdout\')'));
    assert.ok(html.includes('setFilter(\'stderr\')'));
    assert.ok(html.includes('setFilter(\'system\')'));
    assert.ok(html.includes('clearTerminal()'));
    assert.ok(html.includes('autoscroll-chk'));
  });
});

