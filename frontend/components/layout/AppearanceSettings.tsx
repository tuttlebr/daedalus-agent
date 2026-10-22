import { IconDeviceDesktop, IconMoon, IconSun } from '@tabler/icons-react';

import { useUISettingsStore } from '@/state';

const choices = [
  { value: 'system', label: 'System', Icon: IconDeviceDesktop },
  { value: 'light', label: 'Light', Icon: IconSun },
  { value: 'dark', label: 'Dark', Icon: IconMoon },
] as const;

/**
 * Appearance and material choices. The container sets the horizontal edges,
 * so the control lines up with the sidebar rows or the sign-in card.
 */
export function AppearanceSettings() {
  const mode = useUISettingsStore((s) => s.lightMode);
  const setMode = useUISettingsStore((s) => s.setLightMode);
  const reduceTransparency = useUISettingsStore((s) => s.reduceTransparency);
  const setReduceTransparency = useUISettingsStore(
    (s) => s.setReduceTransparency,
  );
  return (
    <div className="min-w-0 space-y-1">
      <fieldset className="min-w-0">
        <legend className="pb-1.5 text-xs font-medium text-muted">
          Appearance
        </legend>
        <div className="app-segmented flex w-full">
          {choices.map(({ value, label, Icon }) => (
            <label
              key={value}
              className="relative flex min-w-[4rem] flex-[1_1_0] cursor-pointer"
            >
              <input
                className="peer absolute inset-0 z-10 h-full w-full cursor-pointer opacity-0"
                type="radio"
                name="appearance"
                value={value}
                checked={mode === value}
                onChange={() => setMode(value)}
              />
              <span className="app-segment w-full px-2 text-xs peer-focus-visible:outline peer-focus-visible:outline-2 peer-focus-visible:outline-offset-2 peer-focus-visible:outline-focus">
                <Icon size={14} aria-hidden="true" className="flex-shrink-0" />
                {label}
              </span>
            </label>
          ))}
        </div>
      </fieldset>
      {/* WebKit does not report the system's Reduce Transparency setting to
          pages, so the app offers the same choice. */}
      <label className="app-setting-row flex min-h-8 cursor-pointer items-center justify-between gap-3 rounded-lg py-1.5 text-sm text-primary">
        <span>Reduce transparency</span>
        <input
          type="checkbox"
          role="switch"
          className="app-switch"
          checked={reduceTransparency}
          onChange={(event) => setReduceTransparency(event.target.checked)}
        />
      </label>
    </div>
  );
}
