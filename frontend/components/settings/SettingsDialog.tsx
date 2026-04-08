'use client';

import React, { memo, useState } from 'react';
import classNames from 'classnames';
import { IconSettings, IconBrain, IconBolt, IconActivity, IconDatabase } from '@tabler/icons-react';
import { Dialog, Button, Toggle } from '@/components/primitives';
import { useUISettingsStore } from '@/state';
import { useTheme } from '@/hooks/useTheme';

interface SettingsDialogProps {
  open: boolean;
  onClose: () => void;
}

type Tab = 'general' | 'agent' | 'performance' | 'data';

const TABS: { id: Tab; label: string; icon: React.ElementType }[] = [
  { id: 'general', label: 'General', icon: IconSettings },
  { id: 'agent', label: 'Agent', icon: IconBrain },
  { id: 'performance', label: 'Performance', icon: IconBolt },
  { id: 'data', label: 'Data', icon: IconDatabase },
];

export const SettingsDialog = memo(({ open, onClose }: SettingsDialogProps) => {
  const [activeTab, setActiveTab] = useState<Tab>('general');
  const { mode, toggle: toggleTheme } = useTheme();

  const autoScroll = useUISettingsStore((s) => s.autoScroll);
  const setAutoScroll = useUISettingsStore((s) => s.setAutoScroll);
  const chatHistory = useUISettingsStore((s) => s.chatHistory);
  const setChatHistory = useUISettingsStore((s) => s.setChatHistory);
  const enableIntermediateSteps = useUISettingsStore((s) => s.enableIntermediateSteps);
  const setEnableIntermediateSteps = useUISettingsStore((s) => s.setEnableIntermediateSteps);
  const expandIntermediateSteps = useUISettingsStore((s) => s.expandIntermediateSteps);
  const setExpandIntermediateSteps = useUISettingsStore((s) => s.setExpandIntermediateSteps);
  const intermediateStepsView = useUISettingsStore((s) => s.intermediateStepsView);
  const setIntermediateStepsView = useUISettingsStore((s) => s.setIntermediateStepsView);
  const enableBackgroundProcessing = useUISettingsStore((s) => s.enableBackgroundProcessing);
  const setEnableBackgroundProcessing = useUISettingsStore((s) => s.setEnableBackgroundProcessing);
  const energySavingMode = useUISettingsStore((s) => s.energySavingMode);
  const setEnergySavingMode = useUISettingsStore((s) => s.setEnergySavingMode);

  return (
    <Dialog open={open} onClose={onClose} title="Settings" size="lg">
      <div className="flex flex-col md:flex-row gap-4 md:gap-6">
        {/* Tabs - horizontal scroll on mobile, vertical on desktop */}
        <nav className="flex md:flex-col gap-1 overflow-x-auto md:overflow-visible md:w-40 flex-shrink-0 pb-2 md:pb-0 border-b md:border-b-0 border-white/[0.04]">
          {TABS.map(({ id, label, icon: Icon }) => (
            <button
              key={id}
              onClick={() => setActiveTab(id)}
              className={classNames(
                'flex items-center gap-2 px-3 py-2 rounded-lg text-sm transition-colors text-left whitespace-nowrap min-h-[44px]',
                activeTab === id
                  ? 'bg-nvidia-green/10 text-nvidia-green font-medium'
                  : 'text-dark-text-muted hover:text-dark-text-secondary hover:bg-white/[0.04]'
              )}
            >
              <Icon size={16} />
              {label}
            </button>
          ))}
        </nav>

        {/* Content */}
        <div className="flex-1 min-w-0 space-y-6">
          {activeTab === 'general' && (
            <>
              <SettingRow label="Theme" description="Switch between dark and light mode">
                <Button size="xs" variant="secondary" onClick={toggleTheme}>
                  {mode === 'dark' ? 'Switch to Light' : 'Switch to Dark'}
                </Button>
              </SettingRow>
              <SettingRow label="Auto-Scroll" description="Automatically scroll to new messages">
                <ToggleSwitch checked={autoScroll} onChange={setAutoScroll} />
              </SettingRow>
              <SettingRow label="Chat History" description="Save conversation history">
                <ToggleSwitch checked={chatHistory} onChange={setChatHistory} />
              </SettingRow>
            </>
          )}

          {activeTab === 'agent' && (
            <>
              <SettingRow label="Show Agent Steps" description="Display intermediate reasoning steps">
                <ToggleSwitch checked={enableIntermediateSteps} onChange={setEnableIntermediateSteps} />
              </SettingRow>
              <SettingRow label="Auto-Expand Steps" description="Expand step details by default">
                <ToggleSwitch checked={expandIntermediateSteps} onChange={setExpandIntermediateSteps} />
              </SettingRow>
              <SettingRow label="Steps View" description="Choose timeline or category view">
                <Toggle
                  options={[
                    { value: 'timeline', label: 'Timeline', icon: <IconActivity size={12} /> },
                    { value: 'category', label: 'Category', icon: <IconDatabase size={12} /> },
                  ]}
                  value={intermediateStepsView}
                  onChange={(v) => setIntermediateStepsView(v as 'timeline' | 'category')}
                  size="sm"
                  accentColors={['bg-nvidia-green', 'bg-nvidia-green']}
                />
              </SettingRow>
            </>
          )}

          {activeTab === 'performance' && (
            <>
              <SettingRow label="Background Processing" description="Continue processing when the app is backgrounded">
                <ToggleSwitch checked={enableBackgroundProcessing} onChange={setEnableBackgroundProcessing} />
              </SettingRow>
              <SettingRow label="Energy Saving Mode" description="Reduce animations and background activity">
                <ToggleSwitch checked={energySavingMode} onChange={setEnergySavingMode} />
              </SettingRow>
            </>
          )}

          {activeTab === 'data' && (
            <>
              <SettingRow label="Export Conversations" description="Download all conversations as JSON">
                <Button size="xs" variant="secondary" onClick={() => {
                  // Export logic from existing ImportExport
                }}>
                  Export
                </Button>
              </SettingRow>
              <SettingRow label="Import Conversations" description="Import conversations from a JSON file">
                <Button size="xs" variant="secondary" onClick={() => {
                  // Import logic from existing ImportExport
                }}>
                  Import
                </Button>
              </SettingRow>
            </>
          )}
        </div>
      </div>
    </Dialog>
  );
});

SettingsDialog.displayName = 'SettingsDialog';

const SettingRow = memo(({ label, description, children }: { label: string; description: string; children: React.ReactNode }) => (
  <div className="flex items-center justify-between gap-4 py-2">
    <div>
      <p className="text-sm font-medium text-dark-text-primary">{label}</p>
      <p className="text-xs text-dark-text-muted">{description}</p>
    </div>
    {children}
  </div>
));

SettingRow.displayName = 'SettingRow';

const ToggleSwitch = memo(({ checked, onChange }: { checked: boolean; onChange: (v: boolean) => void }) => (
  <button
    role="switch"
    aria-checked={checked}
    onClick={() => onChange(!checked)}
    className={classNames(
      'relative w-10 h-6 rounded-full transition-colors duration-200 flex-shrink-0',
      checked ? 'bg-nvidia-green' : 'bg-neutral-700'
    )}
  >
    <span
      className={classNames(
        'absolute top-1 w-4 h-4 rounded-full bg-white shadow transition-transform duration-200',
        checked ? 'translate-x-5' : 'translate-x-1'
      )}
    />
  </button>
));

ToggleSwitch.displayName = 'ToggleSwitch';
