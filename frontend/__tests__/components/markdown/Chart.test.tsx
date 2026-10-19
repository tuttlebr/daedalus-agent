import { act } from 'react';
import { createRoot } from 'react-dom/client';

import Chart from '@/components/markdown/Chart';

import { afterEach, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ toBlob: vi.fn(), saveFile: vi.fn() }));
vi.mock('html-to-image', () => ({ toBlob: mocks.toBlob }));
vi.mock('@/hooks/useFileSave', () => ({
  useFileSave: () => ({ saveFile: mocks.saveFile, fileSaveDialog: null }),
}));

afterEach(() => {
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

it.each(['Repeated title', ''])(
  'exports the selected chart with label %j',
  async (label) => {
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
    vi.stubGlobal(
      'ResizeObserver',
      class {
        observe() {}
        unobserve() {}
        disconnect() {}
      },
    );
    const blob = new Blob(['image'], { type: 'image/png' });
    mocks.toBlob.mockResolvedValue(blob);
    const container = document.createElement('div');
    document.body.append(container);
    const root = createRoot(container);
    try {
      act(() =>
        root.render(
          <>
            {[10, 20].map((value) => (
              <section key={value}>
                <Chart
                  payload={{
                    Label: label,
                    ChartType: 'BarChart',
                    Data: [{ x: 'A', y: value }],
                    XAxisKey: 'x',
                    YAxisKey: 'y',
                  }}
                />
              </section>
            ))}
          </>,
        ),
      );
      const sections = container.querySelectorAll('section');
      await act(async () => {
        sections[1]
          .querySelector<HTMLButtonElement>('[aria-label="Download chart"]')!
          .click();
      });
      expect(mocks.toBlob).toHaveBeenCalledTimes(1);
      expect(sections[1].contains(mocks.toBlob.mock.calls[0][0])).toBe(true);
      expect(sections[0].contains(mocks.toBlob.mock.calls[0][0])).toBe(false);
      expect(mocks.saveFile).toHaveBeenCalledWith(
        blob,
        `${label}-BarChart.png`,
      );
    } finally {
      act(() => root.unmount());
      container.remove();
    }
  },
);
