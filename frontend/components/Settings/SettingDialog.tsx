import { FC, useContext, useEffect, useRef, useState } from 'react';
import { useTranslation } from 'next-i18next';
import HomeContext from '@/pages/api/home/home.context';
import toast from 'react-hot-toast';
import { getUserSessionItem, setUserSessionItem } from '@/utils/app/storage';

interface Props {
  open: boolean;
  onClose: () => void;
}

export const SettingDialog: FC<Props> = ({ open, onClose }) => {
  const { t } = useTranslation('settings');
  const modalRef = useRef<HTMLDivElement>(null);
  const {
    state: { lightMode, chatCompletionURL, expandIntermediateSteps, intermediateStepOverride, enableIntermediateSteps, chatHistory },
    dispatch: homeDispatch,
  } = useContext(HomeContext);

  const [theme, setTheme] = useState(lightMode);
  // Use user-specific storage keys to prevent data leakage between users
  const [chatCompletionEndPoint, setChatCompletionEndPoint] = useState(getUserSessionItem('chatCompletionURL') || chatCompletionURL);
  const [isIntermediateStepsEnabled, setIsIntermediateStepsEnabled] = useState(getUserSessionItem('enableIntermediateSteps') ? getUserSessionItem('enableIntermediateSteps') === 'true' : enableIntermediateSteps);
  const [detailsToggle, setDetailsToggle] = useState( getUserSessionItem('expandIntermediateSteps') === 'true' ? true : expandIntermediateSteps);
  const [intermediateStepOverrideToggle, setIntermediateStepOverrideToggle] = useState( getUserSessionItem('intermediateStepOverride') === 'false' ? false : intermediateStepOverride);
  const [chatHistoryEnabled, setChatHistoryEnabled] = useState(getUserSessionItem('chatHistory') ? getUserSessionItem('chatHistory') === 'true' : chatHistory);

  useEffect(() => {
    const handleClickOutside = (e: MouseEvent) => {
      if (modalRef.current && !modalRef.current.contains(e.target as Node)) {
        onClose();
      }
    };
    if (open) {
      window.addEventListener('mousedown', handleClickOutside);
    }
    return () => {
      window.removeEventListener('mousedown', handleClickOutside);
    };
  }, [open, onClose]);

  const handleSave = () => {
    if(!chatCompletionEndPoint) {
      toast.error('Please fill all the fields to save settings');
      return;
    }

    homeDispatch({ field: 'lightMode', value: theme });
    homeDispatch({ field: 'chatCompletionURL', value: chatCompletionEndPoint });
    homeDispatch({ field: 'expandIntermediateSteps', value: detailsToggle });
    homeDispatch({ field: 'intermediateStepOverride', value: intermediateStepOverrideToggle });
    homeDispatch({ field: 'enableIntermediateSteps', value: isIntermediateStepsEnabled });
    homeDispatch({ field: 'chatHistory', value: chatHistoryEnabled });

    // Use user-specific storage keys to prevent data leakage between users
    setUserSessionItem('chatCompletionURL', chatCompletionEndPoint);
    setUserSessionItem('expandIntermediateSteps', String(detailsToggle));
    setUserSessionItem('intermediateStepOverride', String(intermediateStepOverrideToggle));
    setUserSessionItem('enableIntermediateSteps', String(isIntermediateStepsEnabled));
    setUserSessionItem('chatHistory', String(chatHistoryEnabled));

    toast.success('Settings saved successfully');
    onClose();
  };

  if (!open) return null;

  return (
    <div className="fixed inset-0 flex items-center justify-center bg-black bg-opacity-50 backdrop-blur-sm z-50 dark:bg-opacity-20">
      <div
        ref={modalRef}
        className="w-full max-w-md bg-white dark:bg-dark-bg-secondary rounded-2xl shadow-nvidia-lg p-6 transform transition-all relative"
      >
        <h2 className="text-xl font-medium text-gray-900 dark:text-white mb-4">{t('Settings')}</h2>

        <label className="block text-sm font-medium text-gray-700 dark:text-gray-300">{t('Theme')}</label>
        <select
          className="w-full mt-1 p-2 rounded-lg bg-gray-100 dark:bg-gray-800 text-gray-900 dark:text-white focus:outline-none"
          value={theme}
          onChange={(e) => setTheme(e.target.value as 'light' | 'dark')}
        >
          <option value="dark">{t('Dark mode')}</option>
          <option value="light">{t('Light mode')}</option>
        </select>

        <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mt-4">{t('HTTP URL for Chat Completion')}</label>
        <input
          type="text"
          value={chatCompletionEndPoint}
          onChange={(e) => setChatCompletionEndPoint(e.target.value)}
          className="w-full mt-1 p-2 rounded-lg bg-gray-100 dark:bg-gray-800 text-gray-900 dark:text-white focus:outline-none"
        />

        <div className="flex align-middle text-sm font-medium text-gray-700 dark:text-gray-300 mt-4">
          <input
            type="checkbox"
            id="enableIntermediateSteps"
            checked={isIntermediateStepsEnabled}
            onChange={ () => {
              setIsIntermediateStepsEnabled(!isIntermediateStepsEnabled)
            }}
            className="mr-2"
          />
          <label
            htmlFor="enableIntermediateSteps"
            className="text-sm font-medium text-gray-700 dark:text-gray-300"
          >
            Enable Intermediate Steps
          </label>
        </div>

        <div className="flex align-middle text-sm font-medium text-gray-700 dark:text-gray-300 mt-4">
          <input
            type="checkbox"
            id="detailsToggle"
            checked={detailsToggle}
            onChange={ () => {
              setDetailsToggle(!detailsToggle)
            }}
            disabled={!isIntermediateStepsEnabled}
            className="mr-2"
          />
          <label
            htmlFor="detailsToggle"
            className="text-sm font-medium text-gray-700 dark:text-gray-300"
          >
            Expand Intermediate Steps by default
          </label>
        </div>

        <div className="flex align-middle text-sm font-medium text-gray-700 dark:text-gray-300 mt-4">
          <input
            type="checkbox"
            id="intermediateStepOverrideToggle"
            checked={intermediateStepOverrideToggle}
            onChange={ () => {
              setIntermediateStepOverrideToggle(!intermediateStepOverrideToggle)
            }}
            disabled={!isIntermediateStepsEnabled}
            className="mr-2"
          />
          <label
            htmlFor="intermediateStepOverrideToggle"
            className="text-sm font-medium text-gray-700 dark:text-gray-300"
          >
            Override intermediate Steps with same Id
          </label>
        </div>

        <div className="flex align-middle text-sm font-medium text-gray-700 dark:text-gray-300 mt-4">
          <input
            type="checkbox"
            id="chatHistoryEnabled"
            checked={chatHistoryEnabled}
            onChange={ () => {
              setChatHistoryEnabled(!chatHistoryEnabled)
            }}
            className="mr-2"
          />
          <label
            htmlFor="chatHistoryEnabled"
            className="text-sm font-medium text-gray-700 dark:text-gray-300"
          >
            {t('Enable Chat History')} (Send full conversation context)
          </label>
        </div>

        <div className="mt-6 flex justify-end gap-2">
          <button
            className="px-4 py-2 bg-gray-300 dark:bg-gray-600 text-gray-900 dark:text-white rounded-md hover:bg-gray-400 dark:hover:bg-gray-500 focus:outline-none"
            onClick={onClose}
          >
            {t('Cancel')}
          </button>
          <button
            className="px-4 py-2 bg-nvidia-green text-white rounded-md hover:bg-nvidia-green-dark focus:outline-none smooth-transition"
            onClick={handleSave}
          >
            {t('Save')}
          </button>
        </div>
      </div>
    </div>
  );
};
