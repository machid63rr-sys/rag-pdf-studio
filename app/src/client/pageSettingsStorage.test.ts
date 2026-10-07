import { describe, expect, it } from 'vitest';
import { DEFAULT_PAGE_SETTINGS, type PageSettings } from '../shared/pageSettings';
import { loadPageSettings, savePageSettings, type SettingsStorage } from './pageSettingsStorage';

const memory = (initial: Record<string, string> = {}): SettingsStorage & { data: Record<string, string> } => {
  const data = { ...initial };
  return {
    data,
    getItem: (key) => data[key] ?? null,
    setItem: (key, value) => {
      data[key] = value;
    },
  };
};

const custom: PageSettings = { paper: 'B5', orientation: 'landscape', margin: 'wide', pageNumbers: false };

describe('ページ設定の保存', () => {
  it('保存した設定を、次に読み込める', () => {
    const storage = memory();
    savePageSettings(custom, storage);
    expect(loadPageSettings(storage)).toEqual(custom);
  });

  it('何も保存されていなければ、既定', () => {
    expect(loadPageSettings(memory())).toEqual(DEFAULT_PAGE_SETTINGS);
  });

  it.each([
    ['JSONでない', 'これはJSONではない'],
    ['項目が不正', JSON.stringify({ ...custom, paper: 'A9' })],
    ['項目が足りない', JSON.stringify({ paper: 'A4' })],
    ['オブジェクトでない', '"A4"'],
  ])('保存された内容が壊れている(%s)ときは、既定', (_label, raw) => {
    expect(loadPageSettings(memory({ 'md-pdf-editor:page-settings': raw }))).toEqual(DEFAULT_PAGE_SETTINGS);
  });

  it('保存できない(容量不足・無効化)ときも、例外にならない', () => {
    const failing: SettingsStorage = {
      getItem: () => {
        throw new Error('blocked');
      },
      setItem: () => {
        throw new Error('quota');
      },
    };
    expect(() => savePageSettings(custom, failing)).not.toThrow();
    expect(loadPageSettings(failing)).toEqual(DEFAULT_PAGE_SETTINGS);
  });

  it('ブラウザの保存先が無い(undefined)ときも、既定で、例外にならない', () => {
    expect(loadPageSettings(undefined)).toEqual(DEFAULT_PAGE_SETTINGS);
    expect(() => savePageSettings(custom, undefined)).not.toThrow();
  });
});
