// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  connectGoogleDrive,
  disconnectGoogleDrive,
  downloadDriveAudio,
  driveConnected,
  driveAudioQuery,
  driveFileName,
  DriveAuthError,
  googleClientConfigured,
  listDriveAudio,
  saveGoogleClientId,
  uploadSessionAudio,
} from '../src/lib/drive/client';
import type { Session } from '../src/types';

/* ------------------------------------------------------------------- fakes */

class FakeXhr {
  static instances: FakeXhr[] = [];
  status = 0;
  responseText = '';
  response: Blob | null = null;
  onload: (() => void) | null = null;
  onerror: (() => void) | null = null;
  onabort: (() => void) | null = null;
  onloadend: (() => void) | null = null;
  upload = { onprogress: null as ((event: { lengthComputable: boolean; loaded: number; total: number }) => void) | null };
  onprogress: ((event: { lengthComputable: boolean; loaded: number; total: number }) => void) | null = null;
  method = '';
  url = '';
  sent: unknown = null;

  constructor() {
    FakeXhr.instances.push(this);
  }

  open(method: string, url: string) {
    this.method = method;
    this.url = url;
  }

  setRequestHeader() {}

  send(body: unknown) {
    this.sent = body;
  }

  abort() {
    this.onabort?.();
    this.onloadend?.();
  }

  /** Test helper: finish the request the way the fake server decides. */
  respond(status: number, body?: unknown, blobType = 'audio/webm') {
    this.status = status;
    if (body instanceof Blob) {
      this.response = body;
    } else {
      this.responseText = body === undefined ? '' : JSON.stringify(body);
    }
    this.onload?.();
    this.onloadend?.();
  }
}

function installFetch(routes: Array<(url: string, init: RequestInit | undefined) => Response | Promise<Response>>) {
  const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    for (const route of routes) {
      const response = await route(url, init);
      if (response) return response;
    }
    throw new Error(`unexpected fetch ${url}`);
  });
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });

function session(): Session {
  return {
    id: 's1',
    title: 'Lecture 1',
    createdAt: Date.now(),
    updatedAt: Date.now(),
    duration: 10,
    language: 'en',
    model: 'whisper-base',
    speakerCount: 1,
    wordCount: 5,
    sourceName: null,
    segments: [],
    audioBlob: new Blob(['audio-bytes'], { type: 'audio/webm' }),
    audioMime: 'audio/webm',
  };
}

/* ------------------------------------------------------------------- tests */

describe('drive client', () => {
  beforeEach(() => {
    FakeXhr.instances = [];
    vi.stubGlobal('XMLHttpRequest', FakeXhr as unknown as typeof XMLHttpRequest);
    localStorage.clear();
    sessionStorage.clear();
    (window as { google?: unknown }).google = {
      accounts: {
        oauth2: {
          initTokenClient: (config: { callback: (r: { access_token?: string; expires_in?: number }) => void }) => ({
            requestAccessToken: () => config.callback({ access_token: 'tok-1', expires_in: 3600 }),
          }),
          revoke: () => undefined,
        },
      },
    };
    return () => {
      vi.unstubAllGlobals();
      disconnectGoogleDrive();
    };
  });

  it('knows when no OAuth client is configured and stores one', () => {
    expect(googleClientConfigured()).toBe(false);
    saveGoogleClientId('abc-123.apps.googleusercontent.com');
    expect(googleClientConfigured()).toBe(true);
    expect(localStorage.getItem('coso.drive.clientId')).toBe('abc-123.apps.googleusercontent.com');
  });

  it('connects through GIS, stores the token and reports connected', async () => {
    const token = await connectGoogleDrive('abc.apps.googleusercontent.com');
    expect(token.accessToken).toBe('tok-1');
    expect(driveConnected()).toBe(true);
    expect(JSON.parse(sessionStorage.getItem('coso.drive.token') ?? '{}').accessToken).toBe('tok-1');
  });

  it('refuses to connect without a client id', async () => {
    await expect(connectGoogleDrive()).rejects.toThrow(/not configured/);
    expect(driveConnected()).toBe(false);
  });

  it('lists audio files with the folder query and bearer token', async () => {
    sessionStorage.setItem(
      'coso.drive.token',
      JSON.stringify({ accessToken: 'tok-9', expiresAt: Date.now() + 3600_000, browseAll: true }),
    );
    const fetchMock = installFetch([
      (url) => {
        expect(url).toContain('googleapis.com/drive/v3/files');
        return json({ files: [{ id: 'f1', name: 'class.webm', mimeType: 'audio/webm' }] });
      },
    ]);
    const files = await listDriveAudio(true);
    expect(files).toHaveLength(1);
    expect(files[0]).toMatchObject({ id: 'f1', name: 'class.webm' });
    expect(fetchMock).toHaveBeenCalledOnce();
    const headers = new Headers((fetchMock.mock.calls[0][1] as RequestInit).headers);
    expect(headers.get('Authorization')).toBe('Bearer tok-9');
  });

  it('throws DriveAuthError when the API returns 401', async () => {
    sessionStorage.setItem(
      'coso.drive.token',
      JSON.stringify({ accessToken: 'tok', expiresAt: Date.now() + 3600_000, browseAll: true }),
    );
    installFetch([() => new Response('{}', { status: 401 })]);
    await expect(listDriveAudio(true)).rejects.toBeInstanceOf(DriveAuthError);
  });

  it('creates the Coso Audio folder and uploads the session audio through a resumable session', async () => {
    sessionStorage.setItem(
      'coso.drive.token',
      JSON.stringify({ accessToken: 'tok-up', expiresAt: Date.now() + 3600_000, browseAll: true }),
    );
    installFetch([
      (url) => {
        if (url.includes('q=name%3D')) return json({ files: [] });
        if (url.includes('?fields=id')) return json({ id: 'folder-7' });
        expect(url).toContain('upload/drive/v3/files');
        return new Response('{}', { status: 200, headers: { Location: 'https://upload.example/session-1' } });
      },
    ]);

    const progress: Array<[number, number]> = [];
    const upload = uploadSessionAudio(session(), (loaded, total) => progress.push([loaded, total]));
    await vi.waitFor(() => expect(FakeXhr.instances.length).toBe(1));
    const xhr = FakeXhr.instances[0];
    expect(xhr.url).toBe('https://upload.example/session-1');
    expect(xhr.method).toBe('PUT');
    xhr.upload.onprogress?.({ lengthComputable: true, loaded: 6, total: 11 });
    xhr.respond(200, { id: 'file-1', name: 'lecture-1.webm' });
    await expect(upload).resolves.toMatchObject({ id: 'file-1' });
    expect(progress).toContainEqual([6, 11]);
  });

  it('downloads a Drive file as a File with its original name', async () => {
    sessionStorage.setItem(
      'coso.drive.token',
      JSON.stringify({ accessToken: 'tok-dl', expiresAt: Date.now() + 3600_000, browseAll: true }),
    );
    const pending = downloadDriveAudio({ id: 'file-2', name: 'talk.mp3', mimeType: 'audio/mpeg' });
    await vi.waitFor(() => expect(FakeXhr.instances.length).toBe(1));
    const xhr = FakeXhr.instances[0];
    expect(xhr.url).toContain('/drive/v3/files/file-2?alt=media');
    xhr.respond(200, new Blob(['mp3-bytes'], { type: 'audio/mpeg' }));
    const file = await pending;
    expect(file.name).toBe('talk.mp3');
    expect(file.type).toBe('audio/mpeg');
    expect(file.size).toBe(9);
  });

  it('disconnect clears the stored token', async () => {
    sessionStorage.setItem(
      'coso.drive.token',
      JSON.stringify({ accessToken: 'tok', expiresAt: Date.now() + 3600_000, browseAll: true }),
    );
    expect(driveConnected()).toBe(true);
    disconnectGoogleDrive();
    expect(driveConnected()).toBe(false);
  });

  it('builds the Drive query strings used for listing', () => {
    expect(driveAudioQuery(null)).toContain("mimeType contains 'audio/'");
    expect(driveAudioQuery('folder-7')).toContain("'folder-7' in parents");
  });

  it('names uploads after the session title and extension', () => {
    expect(driveFileName(session())).toMatch(/^lecture-1-.*\.webm$/);
  });
});
