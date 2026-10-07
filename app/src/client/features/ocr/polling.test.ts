import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { startPolling, type PollDecision } from './polling';

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

// 非同期の取得が、タイマーを進めた後に完了するのを待つ
const flush = async (): Promise<void> => {
  await vi.advanceTimersByTimeAsync(0);
};

describe('startPolling', () => {
  it('すぐに1回取得し、その後は間隔をあけて、止まるまで取得し続ける', async () => {
    const values: number[] = [];
    let count = 0;
    startPolling({
      intervalMs: 1000,
      fetch: () => Promise.resolve(++count),
      onValue: (value): PollDecision => {
        values.push(value);
        return value >= 3 ? 'stop' : 'continue';
      },
      onError: () => 'stop',
    });

    await flush();
    expect(values).toEqual([1]);
    await vi.advanceTimersByTimeAsync(999);
    expect(values).toEqual([1]);
    await vi.advanceTimersByTimeAsync(1);
    expect(values).toEqual([1, 2]);
    await vi.advanceTimersByTimeAsync(1000);
    expect(values).toEqual([1, 2, 3]);
    await vi.advanceTimersByTimeAsync(10_000);
    expect(values).toEqual([1, 2, 3]); // 'stop' の後は取得しない
  });

  it('取得の失敗を通知し、続ける指示なら、次の間隔でもう一度取得する', async () => {
    const errors: unknown[] = [];
    const values: string[] = [];
    let count = 0;
    startPolling({
      intervalMs: 500,
      fetch: () => (++count === 1 ? Promise.reject(new Error('一時的な失敗')) : Promise.resolve('ok')),
      onValue: (value): PollDecision => {
        values.push(value);
        return 'stop';
      },
      onError: (error): PollDecision => {
        errors.push(error);
        return 'continue';
      },
    });

    await flush();
    expect(errors).toHaveLength(1);
    expect(values).toEqual([]);
    await vi.advanceTimersByTimeAsync(500);
    expect(values).toEqual(['ok']);
  });

  it('onErrorが止める指示(404など)なら、それ以上取得しない', async () => {
    let count = 0;
    startPolling({
      intervalMs: 100,
      fetch: () => {
        count += 1;
        return Promise.reject(new Error('見つかりません'));
      },
      onValue: () => 'continue',
      onError: () => 'stop',
    });

    await vi.advanceTimersByTimeAsync(5000);

    expect(count).toBe(1);
  });

  it('止めると、取得中のリクエストを中断し、以降は取得も通知もしない', async () => {
    let signal: AbortSignal | undefined;
    const onValue = vi.fn((): PollDecision => 'continue');
    const onError = vi.fn((): PollDecision => 'continue');
    let resolveFetch: (value: string) => void = () => undefined;
    const stop = startPolling({
      intervalMs: 100,
      fetch: (s) => {
        signal = s;
        return new Promise<string>((resolve) => {
          resolveFetch = resolve;
        });
      },
      onValue,
      onError,
    });

    stop();
    expect(signal?.aborted).toBe(true);
    resolveFetch('遅れて届いた値'); // 止めた後に届いた結果は、捨てる
    await vi.advanceTimersByTimeAsync(5000);

    expect(onValue).not.toHaveBeenCalled();
    expect(onError).not.toHaveBeenCalled();
  });

  it('中断によるエラー(AbortError)は、通知しない', async () => {
    const onError = vi.fn((): PollDecision => 'continue');
    const stop = startPolling({
      intervalMs: 100,
      fetch: (signal) =>
        new Promise<string>((_resolve, reject) => {
          signal.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')));
        }),
      onValue: () => 'continue',
      onError,
    });

    stop();
    await vi.advanceTimersByTimeAsync(1000);

    expect(onError).not.toHaveBeenCalled();
  });

  it('待ち時間の途中で止めると、次の取得はしない', async () => {
    let count = 0;
    const stop = startPolling({
      intervalMs: 1000,
      fetch: () => Promise.resolve(++count),
      onValue: () => 'continue',
      onError: () => 'continue',
    });

    await flush();
    stop();
    await vi.advanceTimersByTimeAsync(10_000);

    expect(count).toBe(1);
  });
});
