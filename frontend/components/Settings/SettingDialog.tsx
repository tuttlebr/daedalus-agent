import { FC, useContext, useEffect, useRef, useState } from 'react';
import { useTranslation } from 'next-i18next';
import { IconX, IconMoon, IconSun, IconBolt, IconHistory, IconEye, IconReplace, IconServer } from '@tabler/icons-react';
import HomeContext from '@/pages/api/home/home.context';
import toast from 'react-hot-toast';
import { getUserSessionItem, setUserSessionItem } from '@/utils/app/storage';

interface Props {
  open: boolean;
  onClose: () => void;
}

// Toggle Switch Component
interface ToggleSwitchProps {
  id: string;
  checked: boolean;
  onChange: () => void;
  disabled?: boolean;
}

const ToggleSwitch: FC<ToggleSwitchProps> = ({ id, checked, onChange, disabled }) => (
  <button
    id={id}
    role="switch"
    aria-checked={checked}
    onClick={onChange}
    disabled={disabled}
    className={`
      relative inline-flex h-6 w-11 flex-shrink-0 cursor-pointer rounded-full
      border-2 border-transparent transition-colors duration-200 ease-in-out
      focus:outline-none focus-visible:ring-2 focus-visible:ring-nvidia-green focus-visible:ring-offset-2
      ${disabled ? 'opacity-50 cursor-not-allowed' : ''}
      ${checked ? 'bg-nvidia-green' : 'bg-white/20'}
    `}
  >
    <span
      className={`
        pointer-events-none inline-block h-5 w-5 transform rounded-full
        bg-white shadow-lg ring-0 transition duration-200 ease-in-out
        ${checked ? 'translate-x-5' : 'translate-x-0'}
      `}
    />
  </button>
);

// Setting Row Component
interface SettingRowProps {
  icon: React.ReactNode;
  label: string;
  description?: string;
  children: React.ReactNode;
}

const SettingRow: FC<SettingRowProps> = ({ icon, label, description, children }) => (
  <div className="flex items-center justify-between gap-4 py-3">
    <div className="flex items-start gap-3 min-w-0 flex-1">
      <div className="flex-shrink-0 w-8 h-8 rounded-lg bg-white/5 flex items-center justify-center text-white/60">
        {icon}
      </div>
      <div className="min-w-0 flex-1">
        <p className="text-sm font-medium text-white">{label}</p>
        {description && (
          <p className="text-xs text-white/50 mt-0.5 leading-relaxed">{description}</p>
        )}
      </div>
    </div>
    <div className="flex-shrink-0">
      {children}
    </div>
  </div>
);

// Section Header Component
const SectionHeader: FC<{ title: string }> = ({ title }) => (
  <div className="pt-4 pb-2 first:pt-0">
    <h3 className="text-xs font-semibold uppercase tracking-wider text-white/40">{title}</h3>
  </div>
);

export const SettingDialog: FC<Props> = ({ open, onClose }) => {
  const { t } = useTranslation('settings');
  const modalRef = useRef<HTMLDivElement>(null);
  const {
    state: { lightMode, chatCompletionURL, expandIntermediateSteps, intermediateStepOverride, enableIntermediateSteps, chatHistory, enableBackgroundProcessing },
    dispatch: homeDispatch,
  } = useContext(HomeContext);

  const [theme, setTheme] = useState(lightMode);
  const [chatCompletionEndPoint, setChatCompletionEndPoint] = useState(getUserSessionItem('chatCompletionURL') || chatCompletionURL);
  const [isIntermediateStepsEnabled, setIsIntermediateStepsEnabled] = useState<boolean>(getUserSessionItem('enableIntermediateSteps') ? getUserSessionItem('enableIntermediateSteps') === 'true' : (enableIntermediateSteps ?? false));
  const [detailsToggle, setDetailsToggle] = useState<boolean>(getUserSessionItem('expandIntermediateSteps') === 'true' ? true : (expandIntermediateSteps ?? false));
  const [intermediateStepOverrideToggle, setIntermediateStepOverrideToggle] = useState<boolean>(getUserSessionItem('intermediateStepOverride') === 'false' ? false : (intermediateStepOverride ?? true));
  const [chatHistoryEnabled, setChatHistoryEnabled] = useState<boolean>(getUserSessionItem('chatHistory') ? getUserSessionItem('chatHistory') === 'true' : (chatHistory ?? true));
  const [backgroundProcessingEnabled, setBackgroundProcessingEnabled] = useState<boolean>(getUserSessionItem('enableBackgroundProcessing') ? getUserSessionItem('enableBackgroundProcessing') === 'true' : (enableBackgroundProcessing ?? true));

  useEffect(() => {
    const handleClickOutside = (e: MouseEvent) => {
      if (modalRef.current && !modalRef.current.contains(e.target as Node)) {
        onClose();
      }
    };

    const handleEscape = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        onClose();
      }
    };

    if (open) {
      window.addEventListener('mousedown', handleClickOutside);
      window.addEventListener('keydown', handleEscape);
      // Prevent body scroll when modal is open
      document.body.style.overflow = 'hidden';
    }

    return () => {
      window.removeEventListener('mousedown', handleClickOutside);
      window.removeEventListener('keydown', handleEscape);
      document.body.style.overflow = '';
    };
  }, [open, onClose]);

  const handleSave = () => {
    if (!chatCompletionEndPoint) {
      toast.error('Please enter a chat completion URL');
      return;
    }

    homeDispatch({ field: 'lightMode', value: theme });
    homeDispatch({ field: 'chatCompletionURL', value: chatCompletionEndPoint });
    homeDispatch({ field: 'expandIntermediateSteps', value: detailsToggle });
    homeDispatch({ field: 'intermediateStepOverride', value: intermediateStepOverrideToggle });
    homeDispatch({ field: 'enableIntermediateSteps', value: isIntermediateStepsEnabled });
    homeDispatch({ field: 'chatHistory', value: chatHistoryEnabled });
    homeDispatch({ field: 'enableBackgroundProcessing', value: backgroundProcessingEnabled });

    setUserSessionItem('chatCompletionURL', chatCompletionEndPoint);
    setUserSessionItem('expandIntermediateSteps', String(detailsToggle));
    setUserSessionItem('intermediateStepOverride', String(intermediateStepOverrideToggle));
    setUserSessionItem('enableIntermediateSteps', String(isIntermediateStepsEnabled));
    setUserSessionItem('chatHistory', String(chatHistoryEnabled));
    setUserSessionItem('enableBackgroundProcessing', String(backgroundProcessingEnabled));

    toast.success('Settings saved');
    onClose();
  };

  if (!open) return null;

  return (
    <div className="fixed inset-0 z-[9999] flex items-end sm:items-center justify-center p-0 sm:p-4 bg-black/60 backdrop-blur-sm animate-fade-in">
      <div
        ref={modalRef}
        className="w-full sm:max-w-lg max-h-[90vh] sm:max-h-[85vh] liquid-glass-overlay rounded-t-3xl sm:rounded-2xl overflow-hidden animate-morph-in flex flex-col"
        style={{
          paddingBottom: 'env(safe-area-inset-bottom, 0px)',
        }}
      >
        {/* Header */}
        <div className="flex items-center justify-between p-4 sm:p-5 border-b border-white/10 flex-shrink-0">
          <h2 className="text-lg font-semibold text-white">{t('Settings')}</h2>
          <button
            onClick={onClose}
            className="p-2 rounded-full hover:bg-white/10 transition-colors"
            aria-label="Close settings"
          >
            <IconX size={20} className="text-white/60" />
          </button>
        </div>

        {/* Content - Scrollable */}
        <div className="flex-1 overflow-y-auto p-4 sm:p-5 space-y-1">
          {/* Appearance Section */}
          <SectionHeader title="Appearance" />

          <SettingRow
            icon={theme === 'dark' ? <IconMoon size={18} /> : <IconSun size={18} />}
            label={t('Theme')}
            description="Choose your preferred color scheme"
          >
            <select
              value={theme}
              onChange={(e) => setTheme(e.target.value as 'light' | 'dark')}
              className="px-3 py-2 rounded-xl bg-white/10 border border-white/10 text-white text-sm focus:outline-none focus:border-nvidia-green/50 transition-colors cursor-pointer"
            >
              <option value="dark" className="bg-dark-bg-secondary">{t('Dark mode')}</option>
              <option value="light" className="bg-dark-bg-secondary">{t('Light mode')}</option>
            </select>
          </SettingRow>

          {/* Connection Section */}
          <SectionHeader title="Connection" />

          <div className="py-3">
            <div className="flex items-start gap-3 mb-2">
              <div className="flex-shrink-0 w-8 h-8 rounded-lg bg-white/5 flex items-center justify-center text-white/60">
                <IconServer size={18} />
              </div>
              <div className="flex-1 min-w-0">
                <p className="text-sm font-medium text-white">{t('Chat Completion URL')}</p>
                <p className="text-xs text-white/50 mt-0.5">Backend endpoint for AI responses</p>
              </div>
            </div>
            <input
              type="text"
              value={chatCompletionEndPoint}
              onChange={(e) => setChatCompletionEndPoint(e.target.value)}
              placeholder="https://api.example.com/chat"
              className="w-full mt-2 px-4 py-3 rounded-xl bg-white/5 border border-white/10 text-white text-sm placeholder:text-white/30 focus:outline-none focus:border-nvidia-green/50 focus:bg-white/10 transition-all"
            />
          </div>

          {/* Conversation Section */}
          <SectionHeader title="Conversation" />

          <SettingRow
            icon={<IconHistory size={18} />}
            label={t('Chat History')}
            description="Send full conversation context with each message"
          >
            <ToggleSwitch
              id="chatHistoryEnabled"
              checked={chatHistoryEnabled}
              onChange={() => setChatHistoryEnabled(!chatHistoryEnabled)}
            />
          </SettingRow>

          <SettingRow
            icon={<IconBolt size={18} />}
            label="Background Processing"
            description="Continue processing when screen is locked (PWA only)"
          >
            <ToggleSwitch
              id="backgroundProcessingEnabled"
              checked={backgroundProcessingEnabled}
              onChange={() => setBackgroundProcessingEnabled(!backgroundProcessingEnabled)}
            />
          </SettingRow>

          {/* Developer Section */}
          <SectionHeader title="Developer Options" />

          <SettingRow
            icon={<IconEye size={18} />}
            label="Intermediate Steps"
            description="Show AI reasoning and tool calls"
          >
            <ToggleSwitch
              id="enableIntermediateSteps"
              checked={isIntermediateStepsEnabled}
              onChange={() => setIsIntermediateStepsEnabled(!isIntermediateStepsEnabled)}
            />
          </SettingRow>

          <div className={`pl-11 space-y-1 transition-all duration-200 ${isIntermediateStepsEnabled ? 'opacity-100' : 'opacity-40 pointer-events-none'}`}>
            <SettingRow
              icon={<span className="w-1.5 h-1.5 rounded-full bg-white/40" />}
              label="Auto-expand Steps"
              description="Show step details by default"
            >
              <ToggleSwitch
                id="detailsToggle"
                checked={detailsToggle}
                onChange={() => setDetailsToggle(!detailsToggle)}
                disabled={!isIntermediateStepsEnabled}
              />
            </SettingRow>

            <SettingRow
              icon={<IconReplace size={16} />}
              label="Override Duplicate Steps"
              description="Replace steps with matching IDs"
            >
              <ToggleSwitch
                id="intermediateStepOverrideToggle"
                checked={intermediateStepOverrideToggle}
                onChange={() => setIntermediateStepOverrideToggle(!intermediateStepOverrideToggle)}
                disabled={!isIntermediateStepsEnabled}
              />
            </SettingRow>
          </div>
        </div>

        {/* Footer */}
        <div className="flex gap-3 p-4 sm:p-5 border-t border-white/10 flex-shrink-0">
          <button
            className="flex-1 py-3 px-4 rounded-xl bg-white/10 text-white hover:bg-white/20 transition-all text-sm font-medium"
            onClick={onClose}
          >
            {t('Cancel')}
          </button>
          <button
            className="flex-1 py-3 px-4 rounded-xl bg-nvidia-green text-white hover:bg-nvidia-green-dark transition-all text-sm font-medium shadow-[0_0_20px_rgba(118,185,0,0.3)] hover:shadow-[0_0_30px_rgba(118,185,0,0.5)]"
            onClick={handleSave}
          >
            {t('Save')}
          </button>
        </div>
      </div>
    </div>
  );
};
