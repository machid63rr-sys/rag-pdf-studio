import { describe, expect, it } from 'vitest';
import {
  ensureReadWrite,
  writeOutputs,
  type DirectoryLike,
  type FileHandleLike,
  type PermissionLike,
  type WritableLike,
} from './writeOutputs';

const notFound = (): Error => Object.assign(new Error('not found'), { name: 'NotFoundError' });

// メモリ上のフォルダ。実物と同じく、close()されるまで内容は確定せず、abort()で破棄される
class MemoryDirectory implements DirectoryLike {
  readonly files = new Map<string, string>();
  readonly directories = new Map<string, MemoryDirectory>();
  readonly aborted: string[] = [];
  // 指定したファイル名への書き込み(write)を失敗させる
  failWrite = new Set<string>();
  // 指定したファイル名の存在確認を、NotFound以外のエラーにする
  failLookup = new Set<string>();
  // 指定したファイル名の削除(removeEntry)を失敗させる
  failRemove = new Set<string>();

  getDirectoryHandle(name: string, options?: { create?: boolean }): Promise<DirectoryLike> {
    let child = this.directories.get(name);
    if (child === undefined) {
      if (options?.create !== true) {
        return Promise.reject(notFound());
      }
      child = new MemoryDirectory();
      this.directories.set(name, child);
    }
    return Promise.resolve(child);
  }

  removeEntry(name: string): Promise<void> {
    if (this.failRemove.has(name)) {
      return Promise.reject(new Error('削除できません'));
    }
    this.files.delete(name);
    return Promise.resolve();
  }

  async getFileHandle(name: string, options?: { create?: boolean }): Promise<FileHandleLike> {
    if (this.failLookup.has(name)) {
      throw Object.assign(new Error('同名のフォルダがあります'), { name: 'TypeMismatchError' });
    }
    if (!this.files.has(name)) {
      if (options?.create !== true) {
        throw notFound();
      }
      this.files.set(name, '');
    }
    return { createWritable: () => Promise.resolve(this.writableFor(name)) };
  }

  private writableFor(name: string): WritableLike {
    const previous = this.files.get(name) ?? '';
    let pending = '';
    return {
      write: async (data) => {
        if (this.failWrite.has(name)) {
          throw new Error(`書き込み失敗: ${name}`);
        }
        pending += typeof data === 'string' ? data : await data.text();
      },
      close: () => {
        this.files.set(name, pending);
        return Promise.resolve();
      },
      abort: () => {
        this.aborted.push(name);
        this.files.set(name, previous);
        return Promise.resolve();
      },
    };
  }
}

const pdf = new Blob(['%PDF-1.7 dummy'], { type: 'application/pdf' });
const MD = { name: 'manual.md', data: '# 見出し' } as const;
const PDF = { name: 'manual.pdf', data: pdf } as const;
const CSS = { name: 'style.css', data: 'p { color: red; }' } as const;
const base = { files: [MD, PDF], confirmOverwrite: () => true };

describe('writeOutputs', () => {
  it('MDとPDFの両方を書き込む', async () => {
    const directory = new MemoryDirectory();
    const report = await writeOutputs({ ...base, directory });

    expect(report).toEqual({ cancelled: false, written: ['manual.md', 'manual.pdf'], failed: [] });
    expect(directory.files.get('manual.md')).toBe('# 見出し');
    expect(directory.files.get('manual.pdf')).toBe('%PDF-1.7 dummy');
  });

  describe('片方だけ保存', () => {
    it('MDだけ: PDFは書き込まない', async () => {
      const directory = new MemoryDirectory();
      const report = await writeOutputs({ ...base, directory, files: [MD] });

      expect(report).toEqual({ cancelled: false, written: ['manual.md'], failed: [] });
      expect([...directory.files.keys()]).toEqual(['manual.md']);
    });

    it('PDFだけ: MDは書き込まない', async () => {
      const directory = new MemoryDirectory();
      const report = await writeOutputs({ ...base, directory, files: [PDF] });

      expect(report).toEqual({ cancelled: false, written: ['manual.pdf'], failed: [] });
      expect([...directory.files.keys()]).toEqual(['manual.pdf']);
    });

    it('保存しないファイルが既にあっても、上書き確認の対象にせず、内容も変えない', async () => {
      const directory = new MemoryDirectory();
      directory.files.set('manual.md', '古い内容');
      let asked = false;

      const report = await writeOutputs({
        ...base,
        directory,
        files: [PDF],
        confirmOverwrite: () => {
          asked = true;
          return true;
        },
      });

      expect(asked).toBe(false);
      expect(report.written).toEqual(['manual.pdf']);
      expect(directory.files.get('manual.md')).toBe('古い内容');
    });

    it('保存するファイルが既にあれば、そのファイルだけを上書き確認する', async () => {
      const directory = new MemoryDirectory();
      directory.files.set('manual.pdf', '古い内容');
      directory.files.set('manual.md', '別の古い内容');
      let asked: readonly string[] = [];

      await writeOutputs({
        ...base,
        directory,
        files: [PDF],
        confirmOverwrite: (names) => {
          asked = names;
          return true;
        },
      });

      expect(asked).toEqual(['manual.pdf']);
    });

    it('MD・PDF以外(HTML・固定名のCSS)も、渡した名前のとおりに書き込み、上書き確認の対象にする', async () => {
      const directory = new MemoryDirectory();
      directory.files.set('style.css', '古いCSS');
      let asked: readonly string[] = [];

      const report = await writeOutputs({
        directory,
        files: [{ name: '案内.html', data: '<p>本文</p>' }, CSS, PDF],
        confirmOverwrite: (names) => {
          asked = names;
          return true;
        },
      });

      expect(asked).toEqual(['style.css']);
      expect(report.written).toEqual(['案内.html', 'style.css', 'manual.pdf']);
      expect(directory.files.get('style.css')).toBe('p { color: red; }');
      expect(directory.files.get('案内.html')).toBe('<p>本文</p>');
    });

    it('1つだけの保存が失敗したら、失敗として報告し、新規ファイルは残さない', async () => {
      const directory = new MemoryDirectory();
      directory.failWrite.add('manual.md');

      const report = await writeOutputs({ ...base, directory, files: [MD] });

      expect(report.written).toEqual([]);
      expect(report.failed).toEqual([{ name: 'manual.md', message: '書き込み失敗: manual.md' }]);
      expect(directory.files.size).toBe(0);
    });
  });

  describe('サブフォルダ', () => {
    it('サブフォルダつきの名前(css/style.css)は、サブフォルダを作って書き込む', async () => {
      const directory = new MemoryDirectory();
      const report = await writeOutputs({ ...base, directory, files: [MD, { name: 'css/sub/style.css', data: 'p{}' }] });

      expect(report.written).toEqual(['manual.md', 'css/sub/style.css']);
      expect(directory.directories.get('css')?.directories.get('sub')?.files.get('style.css')).toBe('p{}');
      expect(directory.files.has('style.css')).toBe(false);
    });

    it('サブフォルダの既存ファイルは、上書き確認の対象になる(サブフォルダが無ければ、確認しない)', async () => {
      const directory = new MemoryDirectory();
      let asked: readonly string[] | undefined;
      const confirmOverwrite = (names: readonly string[]): boolean => {
        asked = names;
        return true;
      };
      await writeOutputs({ ...base, directory, files: [{ name: 'css/style.css', data: 'a' }], confirmOverwrite });
      expect(asked).toBeUndefined();

      await writeOutputs({ ...base, directory, files: [{ name: 'css/style.css', data: 'b' }], confirmOverwrite });
      expect(asked).toEqual(['css/style.css']);
      expect(directory.directories.get('css')?.files.get('style.css')).toBe('b');
    });

    it('サブフォルダに書き込む途中で失敗した新規ファイルは、残さない', async () => {
      const directory = new MemoryDirectory();
      const sub = (await directory.getDirectoryHandle('css', { create: true })) as MemoryDirectory;
      sub.failWrite.add('style.css');

      const report = await writeOutputs({ ...base, directory, files: [{ name: 'css/style.css', data: 'p{}' }] });

      expect(report.failed).toEqual([{ name: 'css/style.css', message: '書き込み失敗: style.css' }]);
      expect(sub.files.has('style.css')).toBe(false);
    });

    it.each(['../outside.css', 'a/../../b.css', '/abs.css', 'a//b.css', './a.css', 'a\\b.css', 'c:evil.css', ''])(
      '保存先の外へ出る・不正な名前(%j)は、何も書かずに断る',
      async (name) => {
        const directory = new MemoryDirectory();
        await expect(writeOutputs({ ...base, directory, files: [MD, { name, data: 'x' }] })).rejects.toThrowError('名前が不正です');
        expect(directory.files.size).toBe(0);
        expect(directory.directories.size).toBe(0);
      },
    );
  });

  describe('既存ファイル', () => {
    it('存在するファイル名を渡して上書き確認し、承諾されれば上書きする', async () => {
      const directory = new MemoryDirectory();
      directory.files.set('manual.pdf', '古い内容');
      let asked: readonly string[] = [];

      const report = await writeOutputs({
        ...base,
        directory,
        confirmOverwrite: (names) => {
          asked = names;
          return true;
        },
      });

      expect(asked).toEqual(['manual.pdf']);
      expect(report.written).toEqual(['manual.md', 'manual.pdf']);
      expect(directory.files.get('manual.pdf')).toBe('%PDF-1.7 dummy');
    });

    it('断られたら、何も書かずに中止として報告する(既存の内容も変えない)', async () => {
      const directory = new MemoryDirectory();
      directory.files.set('manual.md', '古い内容');

      const report = await writeOutputs({ ...base, directory, confirmOverwrite: () => false });

      expect(report).toEqual({ cancelled: true, written: [], failed: [] });
      expect(directory.files.get('manual.md')).toBe('古い内容');
      expect(directory.files.has('manual.pdf')).toBe(false);
    });

    it('既存が無ければ、上書き確認は行わない', async () => {
      let asked = false;
      await writeOutputs({
        ...base,
        directory: new MemoryDirectory(),
        confirmOverwrite: () => {
          asked = true;
          return true;
        },
      });
      expect(asked).toBe(false);
    });

    it('存在確認がNotFound以外で失敗したら、書き込まずに例外にする', async () => {
      const directory = new MemoryDirectory();
      directory.failLookup.add('manual.md');

      await expect(writeOutputs({ ...base, directory })).rejects.toThrowError('同名のフォルダ');
      expect(directory.files.size).toBe(0);
    });
  });

  describe('書き込みの失敗', () => {
    it('MDは成功しPDFが失敗した場合、どちらが成功/失敗かを個別に報告し、失敗した新規ファイルは残さない', async () => {
      const directory = new MemoryDirectory();
      directory.failWrite.add('manual.pdf');

      const report = await writeOutputs({ ...base, directory });

      expect(report.cancelled).toBe(false);
      expect(report.written).toEqual(['manual.md']);
      expect(report.failed).toEqual([{ name: 'manual.pdf', message: '書き込み失敗: manual.pdf' }]);
      expect(directory.aborted).toEqual(['manual.pdf']);
      expect(directory.files.get('manual.md')).toBe('# 見出し');
      expect(directory.files.has('manual.pdf')).toBe(false);
    });

    it('失敗した新規ファイルを削除できなかった場合は、空のファイルが残る可能性を報告に含める', async () => {
      const directory = new MemoryDirectory();
      directory.failWrite.add('manual.pdf');
      directory.failRemove.add('manual.pdf');

      const report = await writeOutputs({ ...base, directory });

      expect(report.failed[0]?.message).toContain('書き込み失敗: manual.pdf');
      expect(report.failed[0]?.message).toContain('空のファイルが残っている可能性');
    });

    it('MDが失敗してもPDFは書く', async () => {
      const directory = new MemoryDirectory();
      directory.failWrite.add('manual.md');

      const report = await writeOutputs({ ...base, directory });

      expect(report.written).toEqual(['manual.pdf']);
      expect(report.failed.map((failure) => failure.name)).toEqual(['manual.md']);
    });

    it('上書き中に失敗した場合、元の内容に戻り、既存ファイルは削除しない', async () => {
      const directory = new MemoryDirectory();
      directory.files.set('manual.md', '古い内容');
      directory.failWrite.add('manual.md');

      await writeOutputs({ ...base, directory });

      expect(directory.files.get('manual.md')).toBe('古い内容');
    });
  });
});

describe('ensureReadWrite', () => {
  const handle = (query: PermissionState, request?: PermissionState): PermissionLike & { requested: number } => {
    const result = {
      requested: 0,
      queryPermission: () => Promise.resolve(query),
      requestPermission: () => {
        result.requested += 1;
        return Promise.resolve(request ?? 'denied');
      },
    };
    return result;
  };

  it('すでに許可されていれば、再要求しない', async () => {
    const target = handle('granted');
    await ensureReadWrite(target);
    expect(target.requested).toBe(0);
  });

  it('未許可なら再要求し、許可されれば続行する', async () => {
    const target = handle('prompt', 'granted');
    await ensureReadWrite(target);
    expect(target.requested).toBe(1);
  });

  it('再要求も拒否されたら、例外にする', async () => {
    await expect(ensureReadWrite(handle('prompt', 'denied'))).rejects.toThrowError('許可されませんでした');
    await expect(ensureReadWrite(handle('denied'))).rejects.toThrowError('許可されませんでした');
  });

  it('権限を確認する手段が無い環境では、何もしない', async () => {
    await expect(ensureReadWrite({})).resolves.toBeUndefined();
  });
});
