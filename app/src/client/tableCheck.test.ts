import { describe, expect, it } from 'vitest';
import { findBrokenTables } from './tableCheck';

const VALID_TABLE = '| 表示 | 名称 |\n| --- | --- |\n| E001 | 高圧異常 |';

describe('findBrokenTables', () => {
  it('表として成立している表と、表を含まない本文は検出しない', () => {
    expect(findBrokenTables(`## 見出し\n\n${VALID_TABLE}\n\n本文です。 | と | が混ざる文`)).toEqual([]);
    expect(findBrokenTables('')).toEqual([]);
  });

  it('整列指定(:---:)つきの区切り行や、エスケープされたパイプを含む表は正常とみなす', () => {
    expect(findBrokenTables('| 原因 | 対策 |\n|---|:---:|\n| a | b |')).toEqual([]);
    expect(findBrokenTables('| 式 \\| 値 | 説明 |\n| --- | --- |\n| a | b |')).toEqual([]);
  });

  it('見出し行の列数が区切り行より多い表を、先頭行の行番号つきで検出する', () => {
    const text = [
      '## 見出し',
      '',
      '| 表示 | エラー名称 | 表示 | エラー名称 | :--- | :--- | : |',
      '| --- | --- | --- | --- |',
      '| E001 | 圧縮機高圧異常 | E018 | 還気温度センサ異常 |',
    ].join('\n');
    const result = findBrokenTables(text);
    expect(result).toHaveLength(1);
    expect(result[0]?.line).toBe(3);
    expect(result[0]?.excerpt.startsWith('| 表示 | エラー名称')).toBe(true);
  });

  it('長い先頭行の抜粋は40文字で省略する', () => {
    const longRow = `| ${'あ'.repeat(60)} | b | c |\n| --- | --- |`;
    expect(findBrokenTables(longRow)[0]?.excerpt).toBe(`${(longRow.split('\n')[0] ?? '').slice(0, 40)}…`);
  });

  it('見出し行と区切り行の間に別の行が割り込んだ表を検出する', () => {
    const text = '| a | b |\n注記です。 |\n| --- | --- |\n| c | d |';
    expect(findBrokenTables(text).map((b) => b.line)).toEqual([1, 3]);
  });

  it('区切り行が無い表形式の行を検出する', () => {
    expect(findBrokenTables('| a | b |\n| c | d |').map((b) => b.line)).toEqual([1]);
  });

  it('区切り行の列が空などで文法上成立しない場合も検出する', () => {
    const text = '| 症状 | 調べるところ | 運転再開するとき |\n| :--- | :--- | |\n| 運転しない | 確認 | 電源を入れる |';
    expect(findBrokenTables(text).map((b) => b.line)).toEqual([1]);
  });

  it('コードフェンス内は対象外にする', () => {
    expect(findBrokenTables('```\n| a | b | c |\n| --- | --- |\n```')).toEqual([]);
  });

  it('複数の崩れた表は、それぞれ先頭行を報告する', () => {
    const text = `| a | b | c |\n| --- | --- |\n\n${VALID_TABLE}\n\n| x | y | z |\n| --- | --- |`;
    expect(findBrokenTables(text).map((b) => b.line)).toEqual([1, 8]);
  });

  it('セルが1つだけの単独の行は表の崩れとみなさない', () => {
    expect(findBrokenTables('| 注記 |')).toEqual([]);
  });
});
