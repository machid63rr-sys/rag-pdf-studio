import { describe, expect, it } from 'vitest';
import { collectDropped, fromDirectoryInput, isIgnoredName, MAX_FOLDER_FILES, type DirectoryEntryLike, type EntryLike, type FileEntryLike } from './readFolder';

const fakeFile = (name: string): File => ({ name }) as unknown as File;
const fileEntry = (name: string): FileEntryLike => ({ isFile: true, isDirectory: false, name, file: (success) => success(fakeFile(name)) });
// readEntriesを、batchSize件ずつ返す(実物のように、複数回に分けて返し、最後に空を返す)
const dirEntry = (name: string, children: EntryLike[], batchSize = 2): DirectoryEntryLike => ({
  isFile: false,
  isDirectory: true,
  name,
  createReader: () => {
    let offset = 0;
    return {
      readEntries: (success) => {
        const batch = children.slice(offset, offset + batchSize);
        offset += batchSize;
        success(batch);
      },
    };
  },
});
const paths = (files: { path: string }[]): string[] => files.map((file) => file.path).sort();

describe('isIgnoredName', () => {
  it.each([
    ['.git', true],
    ['.DS_Store', true],
    ['node_modules', true],
    ['images', false],
    ['a.png', false],
  ])('%s -> %s', (name, expected) => {
    expect(isIgnoredName(name)).toBe(expected);
  });
});

describe('collectDropped', () => {
  it('フォルダを1つドロップしたときは、そのフォルダをルートにして、下位のファイルを再帰的に集める(分割して返されても、すべて集める)', async () => {
    const dropped = dirEntry('site', [
      fileEntry('index.html'),
      dirEntry('css', [fileEntry('style.css'), fileEntry('print.css'), fileEntry('extra.css')]),
      dirEntry('images', [dirEntry('icons', [fileEntry('a.png')]), fileEntry('b.png')]),
    ]);
    const files = await collectDropped([dropped]);
    expect(paths(files)).toEqual(['css/extra.css', 'css/print.css', 'css/style.css', 'images/b.png', 'images/icons/a.png', 'index.html']);
    expect(files.find((file) => file.path === 'index.html')?.file.name).toBe('index.html');
  });

  it('隠しファイル・隠しフォルダ・node_modulesは、取り込まない', async () => {
    const dropped = dirEntry('site', [fileEntry('a.html'), fileEntry('.DS_Store'), dirEntry('.git', [fileEntry('HEAD')]), dirEntry('node_modules', [fileEntry('x.js')])]);
    expect(paths(await collectDropped([dropped]))).toEqual(['a.html']);
  });

  it('ファイルとフォルダを一緒にドロップしたときは、ドロップしたフォルダ名がパスの先頭に付く', async () => {
    const files = await collectDropped([fileEntry('index.html'), dirEntry('images', [fileEntry('a.png')])]);
    expect(paths(files)).toEqual(['images/a.png', 'index.html']);
  });

  it('ファイルだけのドロップは、そのまま', async () => {
    expect(paths(await collectDropped([fileEntry('a.md'), fileEntry('b.png')]))).toEqual(['a.md', 'b.png']);
  });

  it('ファイルが多すぎるフォルダは、理由つきで取り込まない', async () => {
    const many = Array.from({ length: MAX_FOLDER_FILES + 1 }, (_, index) => fileEntry(`f${index}.png`));
    await expect(collectDropped([dirEntry('big', many, 1000)])).rejects.toThrowError('ファイルが多すぎます');
  });
});

describe('fromDirectoryInput', () => {
  const picked = (relativePath: string): File => ({ name: relativePath.split('/').pop(), webkitRelativePath: relativePath }) as unknown as File;

  it('選んだフォルダ名を除いた、相対パスにする', () => {
    const files = fromDirectoryInput([picked('site/index.html'), picked('site/css/style.css'), picked('site/images/icons/a.png')]);
    expect(paths(files)).toEqual(['css/style.css', 'images/icons/a.png', 'index.html']);
  });

  it('隠しファイル・node_modulesは取り込まない(選んだフォルダ自体が「.」で始まっていても、取り込める)', () => {
    const files = fromDirectoryInput([picked('.site/a.html'), picked('.site/.git/HEAD'), picked('.site/node_modules/x.js'), picked('.site/.DS_Store')]);
    expect(paths(files)).toEqual(['a.html']);
  });

  it('webkitRelativePathが無い場合は、ファイル名をパスにする', () => {
    expect(paths(fromDirectoryInput([{ name: 'a.png', webkitRelativePath: '' } as unknown as File]))).toEqual(['a.png']);
  });

  it('ファイルが多すぎる場合は、理由つきで取り込まない', () => {
    const many = Array.from({ length: MAX_FOLDER_FILES + 1 }, (_, index) => picked(`d/f${index}.png`));
    expect(() => fromDirectoryInput(many)).toThrowError('ファイルが多すぎます');
  });
});
