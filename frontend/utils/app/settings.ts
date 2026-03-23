import { Settings } from '@/types/settings';
import { getUserSessionItem, setUserSessionItem } from './storage';

const STORAGE_KEY = 'settings';

export const getSettings = (): Settings => {
  let settings: Settings = {
    theme: 'dark',
  };
  // Use user-specific storage key to prevent data leakage between users
  const settingsJson = getUserSessionItem(STORAGE_KEY);
  if (settingsJson) {
    try {
      let savedSettings = JSON.parse(settingsJson) as Settings;
      settings = Object.assign(settings, savedSettings);
    } catch (e) {
      console.error(e);
    }
  }
  return settings;
};

export const saveSettings = (settings: Settings) => {
  // Use user-specific storage key to prevent data leakage between users
  setUserSessionItem(STORAGE_KEY, JSON.stringify(settings));
};
