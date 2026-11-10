import { describe, it } from 'node:test';
import * as assert from 'node:assert/strict';
import { withExponentialBackoff } from '../agents/liveProviders';

describe('Phase 20: LLM Exponential Backoff Resilience & Milestone Verification', () => {
  it('withExponentialBackoff recovers from transient rate-limit failures and returns result', async () => {
    let attempts = 0;

    const result = await withExponentialBackoff(
      async () => {
        attempts++;
        if (attempts < 3) {
          throw new Error('HTTP 429 Too Many Requests');
        }
        return 'LLM_SUCCESS_ON_ATTEMPT_3';
      },
      { maxRetries: 3, baseDelayMs: 10 }
    );

    assert.equal(result, 'LLM_SUCCESS_ON_ATTEMPT_3');
    assert.equal(attempts, 3);
  });

  it('withExponentialBackoff throws the last error when all retries are exhausted', async () => {
    let attempts = 0;

    await assert.rejects(
      () =>
        withExponentialBackoff(
          async () => {
            attempts++;
            throw new Error('Persistent 503 Service Unavailable');
          },
          { maxRetries: 2, baseDelayMs: 5 }
        ),
      /Persistent 503 Service Unavailable/
    );

    assert.equal(attempts, 3); // initial + 2 retries
  });
});

