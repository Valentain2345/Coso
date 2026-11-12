import { downloadBlob } from './formats';
import { isTauri } from '../tauri';

/**
 * Save an exported file.
 *
 * In the browser the blob is downloaded. Inside Tauri (desktop and Android) the
 * native save dialog opens: the user picks the destination folder — on Android
 * this is the system file picker, which grants write permission to the chosen
 * location — and the file is written there.
 */
export type SaveResult = 'downloaded' | 'saved' | 'cancelled';

export async function saveBlob(blob: Blob, filename: string): Promise<SaveResult> {
  if (!isTauri()) {
    downloadBlob(blob, filename);
    return 'downloaded';
  }

  const { save } = await import('@tauri-apps/plugin-dialog');
  const { writeFile } = await import('@tauri-apps/plugin-fs');
  const path = await save({ defaultPath: filename });
  if (!path) return 'cancelled';
  const bytes = new Uint8Array(await blob.arrayBuffer());
  await writeFile(path, bytes);
  return 'saved';
}
