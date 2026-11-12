import type { Session } from '../../types';
import { audioExtension, exportFilename } from '../export/formats';

const GIS_URL = 'https://accounts.google.com/gsi/client';
const DRIVE_API = 'https://www.googleapis.com/drive/v3/files';
const DRIVE_UPLOAD = 'https://www.googleapis.com/upload/drive/v3/files';
const FILE_SCOPE = 'https://www.googleapis.com/auth/drive.file';
const READ_SCOPE = 'https://www.googleapis.com/auth/drive.readonly';
const CLIENT_KEY = 'coso.drive.clientId';
const BROWSE_KEY = 'coso.drive.browseAll';
const TOKEN_KEY = 'coso.drive.token';
export const DRIVE_FOLDER_NAME = 'Coso Audio';

export interface DriveFile {
  id: string;
  name: string;
  mimeType: string;
  size?: string;
  modifiedTime?: string;
}

export interface DriveToken {
  accessToken: string;
  expiresAt: number;
  browseAll: boolean;
}

export interface ConnectOptions {
  /** Also request read-only access to audio already in Drive. */
  browseAll?: boolean;
}

export interface UploadResult {
  id: string;
  name: string;
  size?: string;
}

export class DriveAuthError extends Error {
  constructor(message = 'Your Google Drive session expired. Connect again.') {
    super(message);
    this.name = 'DriveAuthError';
  }
}

interface GoogleTokenResponse {
  access_token?: string;
  expires_in?: number;
  error?: string;
  error_description?: string;
}

interface GoogleOAuth2 {
  initTokenClient(config: {
    client_id: string;
    scope: string;
    callback: (response: GoogleTokenResponse) => void;
    error_callback?: (error: { type?: string; message?: string }) => void;
  }): { requestAccessToken(options?: { prompt?: string }): void };
  revoke(token: string, done: () => void): void;
}

declare global {
  interface Window {
    google?: {
      accounts?: {
        oauth2?: GoogleOAuth2;
      };
    };
  }
}

let gisLoading: Promise<void> | null = null;

export function loadGoogleIdentity(): Promise<void> {
  if (typeof window === 'undefined') return Promise.reject(new Error('Google sign-in needs a browser.'));
  if (window.google?.accounts?.oauth2) return Promise.resolve();
  if (gisLoading) return gisLoading;

  gisLoading = new Promise((resolve, reject) => {
    const existing = document.querySelector<HTMLScriptElement>('script[data-coso-gis]');
    if (existing) {
      existing.addEventListener('load', () => resolve(), { once: true });
      existing.addEventListener('error', () => reject(new Error('Could not load Google sign-in.')), {
        once: true,
      });
      return;
    }

    const script = document.createElement('script');
    script.src = GIS_URL;
    script.async = true;
    script.defer = true;
    script.dataset.cosoGis = 'true';
    script.onload = () => resolve();
    script.onerror = () =>
      reject(new Error('Could not load Google sign-in. Check your connection and try again.'));
    document.head.appendChild(script);
  });

  return gisLoading;
}

export function storedGoogleClientId(): string {
  if (typeof localStorage === 'undefined') return '';
  const fromEnv = (import.meta.env.VITE_GOOGLE_CLIENT_ID as string | undefined)?.trim();
  return fromEnv || localStorage.getItem(CLIENT_KEY) || '';
}

/** True when the build (or the owner's setup) supplied a Google OAuth client. */
export function googleClientConfigured(): boolean {
  return storedGoogleClientId().length > 0;
}

export function saveGoogleClientId(clientId: string): void {
  localStorage.setItem(CLIENT_KEY, clientId.trim());
}

export function storedBrowseAll(): boolean {
  return typeof localStorage !== 'undefined' && localStorage.getItem(BROWSE_KEY) === 'true';
}

export function saveBrowseAll(browseAll: boolean): void {
  localStorage.setItem(BROWSE_KEY, String(browseAll));
}

function readToken(): DriveToken | null {
  if (typeof sessionStorage === 'undefined') return null;
  try {
    const parsed = JSON.parse(sessionStorage.getItem(TOKEN_KEY) ?? 'null') as DriveToken | null;
    if (!parsed?.accessToken || !parsed.expiresAt) return null;
    return parsed;
  } catch {
    return null;
  }
}

export function driveConnected(): boolean {
  const token = readToken();
  return Boolean(token && token.expiresAt > Date.now() + 10_000);
}

function requireToken(): DriveToken {
  const token = readToken();
  if (!token || token.expiresAt <= Date.now() + 10_000) {
    sessionStorage.removeItem(TOKEN_KEY);
    throw new DriveAuthError();
  }
  return token;
}

export async function connectGoogleDrive(clientId?: string): Promise<DriveToken> {
  const trimmed = (clientId ?? storedGoogleClientId()).trim();
  if (!trimmed) {
    throw new Error('Google sign-in is not configured. Add VITE_GOOGLE_CLIENT_ID at build time.');
  }
  await loadGoogleIdentity();
  const oauth2 = window.google?.accounts?.oauth2;
  if (!oauth2) throw new Error('Google sign-in is not available in this browser.');

  // One consent asks for the app folder plus read access to existing audio, so
  // the user never has to understand scopes or click a second permission box.
  const browseAll = true;
  const scope = `${FILE_SCOPE} ${READ_SCOPE}`;

  return new Promise<DriveToken>((resolve, reject) => {
    let settled = false;
    const finish = (action: () => void) => {
      if (settled) return;
      settled = true;
      action();
    };

    const client = oauth2.initTokenClient({
      client_id: trimmed,
      scope,
      callback: (response) => {
        if (!response.access_token) {
          finish(() =>
            reject(
              new Error(
                response.error_description || response.error || 'Google did not return an access token.',
              ),
            ),
          );
          return;
        }
        const token: DriveToken = {
          accessToken: response.access_token,
          expiresAt: Date.now() + Math.max(60, response.expires_in ?? 3600) * 1000,
          browseAll,
        };
        sessionStorage.setItem(TOKEN_KEY, JSON.stringify(token));
        saveGoogleClientId(trimmed);
        saveBrowseAll(browseAll);
        finish(() => resolve(token));
      },
      error_callback: (error) => {
        finish(() => reject(new Error(error.message || 'Google sign-in was cancelled.')));
      },
    });

    client.requestAccessToken({ prompt: 'consent' });
  });
}

export function disconnectGoogleDrive(): void {
  const token = readToken();
  if (token && typeof window !== 'undefined') {
    window.google?.accounts?.oauth2?.revoke(token.accessToken, () => undefined);
  }
  sessionStorage.removeItem(TOKEN_KEY);
}

async function apiError(response: Response): Promise<Error> {
  if (response.status === 401 || response.status === 403) return new DriveAuthError();
  try {
    const body = (await response.json()) as { error?: { message?: string } };
    return new Error(body.error?.message || `Google Drive returned ${response.status}.`);
  } catch {
    return new Error(`Google Drive returned ${response.status}.`);
  }
}

export function driveFolderQuery(): string {
  return `name='${DRIVE_FOLDER_NAME}' and mimeType='application/vnd.google-apps.folder' and trashed=false`;
}

export function driveAudioQuery(folderId: string | null): string {
  return folderId
    ? `'${folderId}' in parents and trashed=false and mimeType contains 'audio/'`
    : `trashed=false and mimeType contains 'audio/'`;
}

async function findOrCreateFolder(token: string): Promise<string> {
  const cacheKey = `coso.drive.folder.${token.slice(-12)}`;
  const cached = localStorage.getItem(cacheKey);
  if (cached) return cached;

  const query = encodeURIComponent(driveFolderQuery());
  const response = await fetch(
    `${DRIVE_API}?q=${query}&spaces=drive&pageSize=10&fields=files(id,name)`,
    { headers: { Authorization: `Bearer ${token}` } },
  );
  if (!response.ok) throw await apiError(response);
  const found = (await response.json()) as { files?: Array<{ id: string }> };
  const existing = found.files?.[0]?.id;
  if (existing) {
    localStorage.setItem(cacheKey, existing);
    return existing;
  }

  const created = await fetch(`${DRIVE_API}?fields=id`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json; charset=UTF-8',
    },
    body: JSON.stringify({
      name: DRIVE_FOLDER_NAME,
      mimeType: 'application/vnd.google-apps.folder',
    }),
  });
  if (!created.ok) throw await apiError(created);
  const folder = (await created.json()) as { id: string };
  localStorage.setItem(cacheKey, folder.id);
  return folder.id;
}

export async function listDriveAudio(browseAll = true): Promise<DriveFile[]> {
  const token = requireToken();
  const folderId = browseAll ? null : await findOrCreateFolder(token.accessToken);
  const query = encodeURIComponent(driveAudioQuery(folderId));
  const fields = encodeURIComponent('files(id,name,mimeType,size,modifiedTime)');
  const response = await fetch(
    `${DRIVE_API}?q=${query}&spaces=drive&orderBy=modifiedTime desc&pageSize=100&fields=${fields}`,
    { headers: { Authorization: `Bearer ${token.accessToken}` } },
  );
  if (!response.ok) throw await apiError(response);
  const body = (await response.json()) as { files?: DriveFile[] };
  return body.files ?? [];
}

export function driveFileName(session: Session): string {
  return exportFilename(session, audioExtension(session));
}

export async function uploadSessionAudio(
  session: Session,
  onProgress?: (loaded: number, total: number) => void,
  signal?: AbortSignal,
): Promise<UploadResult> {
  if (!session.audioBlob) throw new Error('This session has no saved recording.');
  const token = requireToken();
  const mimeType = session.audioMime || session.audioBlob.type || 'audio/webm';
  const folderId = await findOrCreateFolder(token.accessToken);

  const init = await fetch(`${DRIVE_UPLOAD}?uploadType=resumable&fields=id,name,size`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token.accessToken}`,
      'Content-Type': 'application/json; charset=UTF-8',
      'X-Upload-Content-Type': mimeType,
      'X-Upload-Content-Length': String(session.audioBlob.size),
    },
    body: JSON.stringify({
      name: driveFileName(session),
      parents: [folderId],
      mimeType,
    }),
  });
  if (!init.ok) throw await apiError(init);

  const location = init.headers.get('Location') ?? init.headers.get('location');
  if (!location) {
    throw new Error('Google Drive did not provide an upload session. Try again in a moment.');
  }

  return uploadBlob(location, session.audioBlob, token.accessToken, onProgress, signal);
}

function uploadBlob(
  location: string,
  blob: Blob,
  token: string,
  onProgress?: (loaded: number, total: number) => void,
  signal?: AbortSignal,
): Promise<UploadResult> {
  return new Promise<UploadResult>((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open('PUT', location);
    xhr.setRequestHeader('Authorization', `Bearer ${token}`);
    xhr.upload.onprogress = (event) => {
      if (event.lengthComputable) onProgress?.(event.loaded, event.total);
    };
    xhr.onload = () => {
      if (xhr.status >= 200 && xhr.status < 300) {
        try {
          resolve(JSON.parse(xhr.responseText) as UploadResult);
        } catch {
          reject(new Error('Google Drive returned an unreadable upload response.'));
        }
        return;
      }
      reject(
        xhr.status === 401 || xhr.status === 403
          ? new DriveAuthError()
          : new Error(`Google Drive upload failed (${xhr.status}).`),
      );
    };
    xhr.onerror = () => reject(new Error('The Google Drive upload was interrupted.'));
    xhr.onabort = () => reject(new DOMException('Upload cancelled.', 'AbortError'));

    const abort = () => xhr.abort();
    signal?.addEventListener('abort', abort, { once: true });
    xhr.onloadend = () => signal?.removeEventListener('abort', abort);
    xhr.send(blob);
  });
}

export function downloadDriveAudio(
  file: DriveFile,
  onProgress?: (loaded: number, total: number) => void,
  signal?: AbortSignal,
): Promise<File> {
  const token = requireToken();
  return new Promise<File>((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open('GET', `${DRIVE_API}/${encodeURIComponent(file.id)}?alt=media`);
    xhr.setRequestHeader('Authorization', `Bearer ${token.accessToken}`);
    xhr.responseType = 'blob';
    xhr.onprogress = (event) => {
      if (event.lengthComputable) onProgress?.(event.loaded, event.total);
    };
    xhr.onload = () => {
      if (xhr.status >= 200 && xhr.status < 300) {
        const blob = xhr.response as Blob;
        resolve(
          new File([blob], file.name, {
            type: file.mimeType || blob.type || 'application/octet-stream',
          }),
        );
        return;
      }
      reject(
        xhr.status === 401 || xhr.status === 403
          ? new DriveAuthError()
          : new Error(`Google Drive download failed (${xhr.status}).`),
      );
    };
    xhr.onerror = () => reject(new Error('The Google Drive download was interrupted.'));
    xhr.onabort = () => reject(new DOMException('Download cancelled.', 'AbortError'));

    const abort = () => xhr.abort();
    signal?.addEventListener('abort', abort, { once: true });
    xhr.onloadend = () => signal?.removeEventListener('abort', abort);
    xhr.send();
  });
}
