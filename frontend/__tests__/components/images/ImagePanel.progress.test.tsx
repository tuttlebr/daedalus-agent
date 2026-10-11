import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';

import { ImagePanel } from '@/components/images/ImagePanel';

import { useImagePanelStore } from '@/state/imagePanelStore';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  dock: {} as any,
  canvas: {} as any,
  fetch: vi.fn(),
  invalidate: vi.fn(),
}));
vi.mock('@/hooks/useMediaQuery', () => ({ useIsDesktop: () => true }));
vi.mock('@/components/images/ImagesDock', () => ({
  ImagesDock: (props: any) => {
    mocks.dock = props;
    return null;
  },
}));
vi.mock('@/components/images/ImagesCanvas', () => ({
  ImagesCanvas: (props: any) => {
    mocks.canvas = props;
    return null;
  },
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

// Keep the real history hooks: a stable mock hid the render/polling race.
const response = (body: unknown) =>
  ({ ok: true, json: async () => body } as Response);

describe('Create polling across renders', () => {
  let root: Root;
  let client: QueryClient;
  beforeEach(() => {
    (globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
    vi.useFakeTimers();
    vi.clearAllMocks();
    localStorage.clear();
    useImagePanelStore.setState({
      loading: false,
      prompt: 'render regression',
      mode: 'generate',
      inputImages: [],
      gallery: [],
      partialGallery: [],
      history: [],
      selectedImageId: null,
      error: null,
      params: {},
      generationStatus: 'idle',
      generationStartedAt: null,
    });
    const container = document.createElement('div');
    document.body.append(container);
    root = createRoot(container);
    client = new QueryClient({
      defaultOptions: { queries: { retry: false, gcTime: Infinity } },
    });
    vi.stubGlobal('fetch', mocks.fetch);
  });
  afterEach(() => {
    act(() => root.unmount());
    client.clear();
    vi.useRealTimers();
    vi.unstubAllGlobals();
    document.body.innerHTML = '';
  });

  it('applies partials and completion when status responses exceed the elapsed timer', async () => {
    let started = false;
    let completed = false;
    const job = () => ({
      jobId: 'slow-job',
      sessionId: 'generated',
      mode: 'generate',
      status: completed ? 'completed' : 'running',
      prompt: 'render regression',
      model: 'gpt-image-2.5-sunburst',
      params: { n: 1 },
      inputImages: [],
      maskImage: null,
      partialImageIds: ['preview-1', 'preview-2'],
      outputImageIds: completed ? ['final'] : [],
      createdAt: Date.now() - 1000,
    });
    mocks.fetch.mockImplementation((url: string, options?: RequestInit) => {
      if (url.includes('/history'))
        return Promise.resolve(response({ history: [] }));
      if (options?.method === 'POST') {
        started = true;
        return new Promise((resolve) =>
          setTimeout(() => resolve(response({ jobId: 'slow-job' })), 200),
        );
      }
      const body = url.includes('active=1')
        ? { jobs: started && !completed ? [job()] : [] }
        : job();
      return new Promise((resolve) =>
        setTimeout(() => resolve(response(body)), 750),
      );
    });
    await act(async () =>
      root.render(
        <QueryClientProvider client={client}>
          <ImagePanel />
        </QueryClientProvider>,
      ),
    );
    let pending!: Promise<void>;
    await act(async () => {
      pending = mocks.dock.onSubmit();
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(3000);
    });
    expect(useImagePanelStore.getState().loading).toBe(true);
    expect(mocks.canvas.images.map((image: any) => image.imageId)).toEqual([
      'preview-2',
    ]);
    completed = true;
    await act(async () => {
      await vi.advanceTimersByTimeAsync(4000);
      await pending;
    });
    expect(
      useImagePanelStore.getState().gallery.map((image) => image.imageId),
    ).toEqual(['final']);
    expect(useImagePanelStore.getState().loading).toBe(false);
    expect(useImagePanelStore.getState().generationStatus).toBe('idle');
    expect(
      mocks.fetch.mock.calls.filter(([url]) => url.includes('active=1')),
    ).toHaveLength(1);
    expect(
      mocks.fetch.mock.calls.filter(([url]) => url.includes('jobId=slow-job'))
        .length,
    ).toBeLessThanOrEqual(4);
  });
});
