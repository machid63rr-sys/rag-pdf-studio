import { describe, expect, it } from 'vitest';
import { SerialQueue } from './serialQueue.js';

const delay = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

describe('SerialQueue', () => {
  it('同時に投入しても、到着順に1つずつ実行する', async () => {
    const queue = new SerialQueue();
    const log: string[] = [];
    const task = (name: string, ms: number) => async (): Promise<string> => {
      log.push(`start:${name}`);
      await delay(ms);
      log.push(`end:${name}`);
      return name;
    };

    const results = await Promise.all([queue.run(task('a', 30)), queue.run(task('b', 5)), queue.run(task('c', 1))]);

    expect(results).toEqual(['a', 'b', 'c']);
    expect(log).toEqual(['start:a', 'end:a', 'start:b', 'end:b', 'start:c', 'end:c']);
  });

  it('先行する処理が失敗しても、後続は実行され、失敗は呼び出し元へ伝わる', async () => {
    const queue = new SerialQueue();
    const failing = queue.run(() => Promise.reject(new Error('失敗')));
    const following = queue.run(() => Promise.resolve('成功'));

    await expect(failing).rejects.toThrowError('失敗');
    await expect(following).resolves.toBe('成功');
  });
});
