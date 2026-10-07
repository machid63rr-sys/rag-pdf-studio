import { DRAFT_VERSION, type DraftContent } from './draft';
import type { DraftStorage } from './draftStorage';

/*
 * 下書きの自動保存。編集が止まってから、保存する(入力のたびに、保存しない)。
 *   - 編集のない文書(元の文書と同じ)は、保存しない(update(null))。すでに保存した下書きがあれば、消す(元に戻したため)
 *   - 保存できなかったときは、理由を持ったまま「未保存」にして、次の編集・保存で、もう一度試す
 */

export interface SaveState {
  // 保存していない編集がある(保存待ち・保存中・保存に失敗)
  readonly pending: boolean;
  // 最後の保存の失敗の理由(保存できていれば null)
  readonly error: string | null;
  // 最後に保存できた日時(まだ無ければ null)
  readonly savedAt: number | null;
}

export const SAVE_DELAY_MS = 1500;

export class DraftSaver {
  private timer: ReturnType<typeof setTimeout> | undefined;
  private latest: DraftContent | null = null;
  private dirty = false;
  private everSaved = false;
  private savedAt: number | null = null;
  private error: string | null = null;
  private chain: Promise<void> = Promise.resolve();

  constructor(
    private readonly storage: DraftStorage,
    private readonly onState: (state: SaveState) => void,
    private readonly delayMs: number = SAVE_DELAY_MS,
    private readonly now: () => number = Date.now,
  ) {}

  /** 保存する内容を更新する。null は、保存するものが無い(元の文書のまま) */
  update(content: DraftContent | null): void {
    this.clearTimer();
    this.latest = content;
    if (content === null) {
      this.dirty = false;
      this.error = null;
      if (this.everSaved) {
        this.everSaved = false;
        this.savedAt = null;
        void this.storage.clear();
      }
      this.emit();
      return;
    }
    this.dirty = true;
    this.emit();
    this.timer = setTimeout(() => void this.flush(), this.delayMs);
  }

  /** 待たずに、いますぐ保存する(タブを閉じる・隠すとき)。保存が済むまで待てる */
  flush(): Promise<void> {
    this.clearTimer();
    this.chain = this.chain.then(() => this.saveLatest());
    return this.chain;
  }

  /** 保存待ちを取りやめる(画面を閉じるとき。保存はしない) */
  dispose(): void {
    this.clearTimer();
  }

  private async saveLatest(): Promise<void> {
    const content = this.latest;
    if (content === null || !this.dirty) {
      return;
    }
    try {
      const savedAt = this.now();
      await this.storage.save({ ...content, version: DRAFT_VERSION, savedAt });
      this.everSaved = true;
      this.savedAt = savedAt;
      this.error = null;
      // 保存している間に、内容が変わっていれば、まだ「未保存」(変えた内容の保存が、予約されている)
      this.dirty = this.latest !== content;
    } catch (cause) {
      this.error = cause instanceof Error ? cause.message : String(cause);
    }
    this.emit();
  }

  private clearTimer(): void {
    if (this.timer !== undefined) {
      clearTimeout(this.timer);
      this.timer = undefined;
    }
  }

  private emit(): void {
    this.onState({ pending: this.dirty, error: this.error, savedAt: this.savedAt });
  }
}
