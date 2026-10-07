/**
 * 渡された処理を、到着順に1つずつ実行する。
 * PDF生成はChromiumを都度起動するため、同時に複数走ってメモリを使い切らないよう直列化する。
 * 先行する処理が失敗しても、後続の処理は実行される。
 */
export class SerialQueue {
  private tail: Promise<unknown> = Promise.resolve();

  run<T>(task: () => Promise<T>): Promise<T> {
    const result = this.tail.then(task);
    this.tail = result.catch(() => undefined);
    return result;
  }
}
