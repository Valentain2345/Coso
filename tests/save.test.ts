// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { downloadBlob } from '../src/lib/export/formats';
import { saveBlob } from '../src/lib/export/save';
import { isTauri } from '../src/lib/tauri';

vi.mock('../src/lib/export/formats', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/lib/export/formats')>();
  return { ...actual, downloadBlob: vi.fn() };
});
vi.mock('@tauri-apps/plugin-dialog', () => ({ save: vi.fn() }));
vi.mock('@tauri-apps/plugin-fs', () => ({ writeFile: vi.fn() }));

const blob = () => new Blob(['transcript'], { type: 'text/plain' });

function setTauri(value: boolean) {
  const w = window as unknown as Record<string, unknown>;
  if (value) w.__TAURI_INTERNALS__ = {};
  else delete w.__TAURI_INTERNALS__;
}

describe('saveBlob', () => {
  beforeEach(() => setTauri(false));

  it('reports the browser as non-Tauri without the internals marker', () => {
    expect(isTauri()).toBe(false);
    setTauri(true);
    expect(isTauri()).toBe(true);
  });

  it('downloads in the browser, without touching the native dialog', async () => {
    const result = await saveBlob(blob(), 'lecture.txt');
    expect(downloadBlob).toHaveBeenCalledWith(expect.any(Blob), 'lecture.txt');
    expect(result).toBe('downloaded');
  });

  it('asks the native save dialog and writes the picked file inside Tauri', async () => {
    setTauri(true);
    const dialog = await import('@tauri-apps/plugin-dialog');
    const fs = await import('@tauri-apps/plugin-fs');
    vi.mocked(dialog.save).mockResolvedValue('C:/Users/me/Coso/lecture.txt');
    vi.mocked(fs.writeFile).mockResolvedValue(undefined);

    const result = await saveBlob(blob(), 'lecture.txt');

    expect(dialog.save).toHaveBeenCalledWith({ defaultPath: 'lecture.txt' });
    const [path, bytes] = vi.mocked(fs.writeFile).mock.calls[0];
    expect(path).toBe('C:/Users/me/Coso/lecture.txt');
    expect(Buffer.from(bytes as Uint8Array).toString()).toBe('transcript');
    expect(result).toBe('saved');
  });

  it('reports cancellation without writing anything', async () => {
    setTauri(true);
    const dialog = await import('@tauri-apps/plugin-dialog');
    const fs = await import('@tauri-apps/plugin-fs');
    vi.mocked(dialog.save).mockResolvedValue(null);

    const result = await saveBlob(blob(), 'lecture.txt');

    expect(fs.writeFile).not.toHaveBeenCalled();
    expect(result).toBe('cancelled');
  });
});
