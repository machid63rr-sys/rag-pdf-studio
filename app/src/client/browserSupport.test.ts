import { describe, expect, it } from 'vitest';
import { checkDirectoryPickerSupport } from './browserSupport';

describe('checkDirectoryPickerSupport', () => {
  it('セキュアコンテキストでshowDirectoryPickerがあれば対応', () => {
    expect(checkDirectoryPickerSupport({ isSecureContext: true, showDirectoryPicker: () => undefined })).toEqual({
      supported: true,
    });
  });

  it('セキュアコンテキストでなければ、localhostでのアクセスを案内する', () => {
    const result = checkDirectoryPickerSupport({ isSecureContext: false, showDirectoryPicker: () => undefined });
    expect(result.supported).toBe(false);
    expect(!result.supported && result.reason).toContain('localhost');
    expect(!result.supported && result.reason).toContain('フォルダへの直接出力');
  });

  it('showDirectoryPickerが無いブラウザ(Firefox/Safari)では、ChromeまたはEdgeを案内する', () => {
    const result = checkDirectoryPickerSupport({ isSecureContext: true });
    expect(result.supported).toBe(false);
    expect(!result.supported && result.reason).toContain('Chrome');
  });
});
