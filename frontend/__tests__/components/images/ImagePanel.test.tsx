import React from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { act } from 'react-dom/test-utils';

import { ImagePanel } from '@/components/images/ImagePanel';

import { useImagePanelStore } from '@/state/imagePanelStore';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  dock: {} as any,
  fetch: vi.fn(),
  invalidate: vi.fn(),
}));
vi.mock('@/hooks/useMediaQuery', () => ({ useIsDesktop: () => true }));
vi.mock('@/utils/app/queries', () => ({
  useImageHistory: () => ({}),
  useInvalidateImageHistory: () => mocks.invalidate,
}));
vi.mock('@/components/images/ImagesDock', () => ({
  ImagesDock: (props: any) => {
    mocks.dock = props;
    return null;
  },
}));
vi.mock('@/components/images/ImagesCanvas', () => ({
  ImagesCanvas: () => null,
}));
vi.mock('@/components/images/HistoryDrawer', () => ({
  HistoryDrawer: () => null,
  HistoryToggleButton: () => null,
}));
vi.mock('@/components/images/AttachmentsPopover', () => ({
  EditAssetsPanel: () => null,
}));
vi.mock('@/components/images/ImageSettingsPanel', () => ({
  ImageSettingsPanel: () => null,
}));
vi.mock('@/components/images/ModeSegmentedControl', () => ({
  ModeSegmentedControl: () => null,
}));
vi.mock('@/components/images/OutputActionSheet', () => ({
  OutputActionSheet: () => null,
}));
vi.mock('@/components/images/ImageDownloadAction', () => ({
  ImageDownloadAction: () => null,
}));
vi.mock('@/components/images/ImagePromptDetail', () => ({
  ImagePromptDetail: () => null,
}));

const response = (body: any, ok = true) =>
  ({ ok, json: async () => body } as Response);
const running = {
  jobId: 'job-1',
  status: 'running',
  partialImageIds: [],
  outputImageIds: [],
  createdAt: 1,
};

describe('Create Stop lifecycle', () => {
  let root: Root;
  beforeEach(async () => {
    (globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
    vi.clearAllMocks();
    localStorage.clear();
    useImagePanelStore.setState({
      loading: false,
      prompt: 'fixture',
      mode: 'generate',
      inputImages: [],
      gallery: [],
      partialGallery: [],
      error: null,
      params: {},
      generationStatus: 'idle',
    });
    mocks.fetch.mockResolvedValue(response({ jobs: [] }));
    vi.stubGlobal('fetch', mocks.fetch);
    const container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
    await act(async () => {
      root.render(<ImagePanel />);
    });
  });
  afterEach(() => {
    act(() => root.unmount());
    vi.unstubAllGlobals();
    document.body.innerHTML = '';
  });

  it('cancels a pending submission and ignores its late response while a newer request runs', async () => {
    const posts: Array<(value: Response) => void> = [];
    mocks.fetch.mockImplementation((_url, options) => {
      if (options?.method === 'DELETE')
        return Promise.resolve(response({ cancelled: true }));
      return new Promise((resolve) => posts.push(resolve));
    });
    let first!: Promise<void>;
    await act(async () => {
      first = mocks.dock.onSubmit();
    });
    const body = JSON.parse(mocks.fetch.mock.calls.at(-1)![1].body);
    await act(async () => {
      await mocks.dock.onStop();
    });
    expect(mocks.fetch.mock.calls.at(-1)![0]).toBe(
      `/api/images/jobs?submissionId=${body.submissionId}`,
    );
    expect(useImagePanelStore.getState().loading).toBe(false);
    let second!: Promise<void>;
    await act(async () => {
      second = mocks.dock.onSubmit();
    });
    await act(async () => {
      posts[0](response({ jobId: 'old' }));
      await first;
    });
    expect(useImagePanelStore.getState().loading).toBe(true);
    expect(useImagePanelStore.getState().gallery).toEqual([]);
    await act(async () => {
      await mocks.dock.onStop();
      posts[1](response({ jobId: 'new' }));
      await second;
    });
  });

  it('does not publish late completion from an outstanding poll after Stop', async () => {
    let finish!: (value: Response) => void;
    mocks.fetch.mockImplementation((_url, options) => {
      if (options?.method === 'POST')
        return Promise.resolve(response({ jobId: 'job-1' }));
      if (options?.method === 'DELETE')
        return Promise.resolve(response({ cancelled: true }));
      return new Promise((resolve) => {
        finish = resolve;
      });
    });
    let pending!: Promise<void>;
    await act(async () => {
      pending = mocks.dock.onSubmit();
    });
    await act(async () => {
      await mocks.dock.onStop();
    });
    await act(async () => {
      finish(
        response({ ...running, status: 'completed', outputImageIds: ['late'] }),
      );
      await pending;
    });
    expect(useImagePanelStore.getState().gallery).toEqual([]);
    expect(useImagePanelStore.getState().loading).toBe(false);
    expect(mocks.invalidate).not.toHaveBeenCalled();
  });

  it('keeps Stop available after cancellation fails and permits retry', async () => {
    let finish!: (value: Response) => void;
    let failed = false;
    mocks.fetch.mockImplementation((_url, options) => {
      if (options?.method === 'DELETE') {
        if (!failed) {
          failed = true;
          return Promise.resolve(response({}, false));
        }
        return Promise.resolve(response({ cancelled: true }));
      }
      return new Promise((resolve) => {
        finish = resolve;
      });
    });
    let pending!: Promise<void>;
    await act(async () => {
      pending = mocks.dock.onSubmit();
    });
    await act(async () => {
      await mocks.dock.onStop();
    });
    expect(useImagePanelStore.getState().loading).toBe(true);
    expect(useImagePanelStore.getState().error).toContain('try Stop again');
    await act(async () => {
      await mocks.dock.onStop();
      finish(response({ jobId: 'job-1' }));
      await pending;
    });
    expect(useImagePanelStore.getState().loading).toBe(false);
  });
});
