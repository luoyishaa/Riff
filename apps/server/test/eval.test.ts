import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { contextRowsToCsv, evaluateContexts, tasksetSchema } from '../src/eval/contexts.js';
import { simulateConcurrency } from '../src/eval/concurrency.js';

describe('context evaluation', () => {
  it('runs the sample task set through the real context builder and runner', async () => {
    const tasks = tasksetSchema.parse(JSON.parse(readFileSync(new URL('../../../eval/taskset.json', import.meta.url), 'utf8')));
    let tick = 0;
    const rows = await evaluateContexts(tasks, () => tick++);
    expect(rows).toHaveLength(tasks.length * 3);
    expect(rows.every((row) => row.validity === 'valid')).toBe(true);
    expect(rows.filter((row) => row.task === 'retry-invalid-json').map((row) => row.retries)).toEqual([1, 1, 1]);
    expect(rows.find((row) => row.task === 'replace-unique' && row.strategy === 'selection')?.suggestionCount).toBe(1);
    expect(contextRowsToCsv(rows).split('\n')[0]).toBe('strategy,task,validity,retries,latency,inputChars,suggestionCount');
  });
});

describe('concurrency evaluation', () => {
  it('converges, and detects exactly the suggestions whose text was edited', () => {
    const report = simulateConcurrency({ clients: 4, steps: 400, seed: 7 });
    expect(report.converged).toBe(true);
    expect(report.events.suggestions).toBeGreaterThan(10);
    expect(report.stale.outdated).toBeGreaterThan(0);
    expect(report.stale.detected).toBe(report.stale.outdated);
    expect(report.stale.falseAlarms).toBe(0);
  });

  it('is reproducible for a seed', () => {
    expect(simulateConcurrency({ clients: 3, steps: 150, seed: 42 })).toEqual(simulateConcurrency({ clients: 3, steps: 150, seed: 42 }));
  });
});
