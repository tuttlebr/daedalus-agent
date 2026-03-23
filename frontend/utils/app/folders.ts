import { FolderInterface } from '@/types/folder';
import { setUserSessionItem } from './storage';

export const saveFolders = (folders: FolderInterface[]) => {
  // Use user-specific storage key to prevent data leakage between users
  setUserSessionItem('folders', JSON.stringify(folders));
};
