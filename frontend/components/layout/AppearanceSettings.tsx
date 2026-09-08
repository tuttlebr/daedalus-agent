import { IconDeviceDesktop, IconMoon, IconSun } from '@tabler/icons-react';

import { useUISettingsStore } from '@/state';

const choices = [
  { value: 'system', label: 'System', Icon: IconDeviceDesktop },
  { value: 'light', label: 'Light', Icon: IconSun },
  { value: 'dark', label: 'Dark', Icon: IconMoon },
] as const;

export function AppearanceSettings() {
  const mode = useUISettingsStore((s) => s.lightMode);
  const setMode = useUISettingsStore((s) => s.setLightMode);
  return (
    <fieldset className="min-w-0 px-3 py-2">
      <legend className="text-xs font-medium text-muted">Appearance</legend>
      <div className="flex flex-wrap rounded-xl bg-control p-1">
        {choices.map(({ value, label, Icon }) => (
          <label
            key={value}
            className="relative min-w-0 flex-[1_1_4rem] cursor-pointer"
          >
            <input
              className="peer absolute inset-0 z-10 h-full w-full cursor-pointer opacity-0"
              type="radio"
              name="appearance"
              value={value}
              checked={mode === value}
              onChange={() => setMode(value)}
            />
            <span className="flex min-h-11 flex-col items-center justify-center gap-1 rounded-lg px-1 py-2 text-xs text-secondary peer-checked:bg-panel peer-checked:text-primary peer-checked:shadow-sm peer-focus-visible:outline peer-focus-visible:outline-2 peer-focus-visible:outline-offset-2 peer-focus-visible:outline-accent">
              <Icon size={18} aria-hidden="true" />
              {label}
            </span>
          </label>
        ))}
      </div>
    </fieldset>
  );
}
