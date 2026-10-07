/*
 * 一定の間隔で状態を取得し続ける仕組み。OCRの進捗・履歴の更新に使う。
 * 画面を離れる・状態が確定したときに止められる(取得中のリクエストも中断する)。
 * 取得に失敗しても、止めずに続ける(一時的なネットワークの不調で、進捗が見えなくなったままにしないため)。
 */

export type PollDecision = 'continue' | 'stop';

export interface PollingOptions<T> {
  readonly intervalMs: number;
  // 状態を取得する。signalは、止められたときに中断される
  readonly fetch: (signal: AbortSignal) => Promise<T>;
  // 取得できた値を受け取り、続けるかどうかを返す
  readonly onValue: (value: T) => PollDecision;
  // 取得に失敗したときに呼ばれ、続けるかどうかを返す(404のように、続けても無意味な場合は 'stop')
  readonly onError: (error: unknown) => PollDecision;
}

/** すぐに1回取得し、その後は、取得が終わってから intervalMs 後に取得する。戻り値の関数で止める */
export function startPolling<T>(options: PollingOptions<T>): () => void {
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;

  const tick = async (): Promise<void> => {
    let decision: PollDecision;
    try {
      const value = await options.fetch(controller.signal);
      if (controller.signal.aborted) {
        return;
      }
      decision = options.onValue(value);
    } catch (error) {
      // 止められた後の失敗(中断によるもの)は、通知しない
      if (controller.signal.aborted) {
        return;
      }
      decision = options.onError(error);
    }
    if (decision === 'continue' && !controller.signal.aborted) {
      timer = setTimeout(() => void tick(), options.intervalMs);
    }
  };

  void tick();
  return () => {
    controller.abort();
    if (timer !== undefined) {
      clearTimeout(timer);
    }
  };
}
