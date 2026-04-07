import { saveFolders } from '@/utils/app/folders'; // Adjust according to your utility functions' locations
import { v4 as uuidv4 } from 'uuid';
import { FolderInterface, FolderType } from '@/types/folder';
import { ActionType } from '@/hooks/useCreateReducer';
import { HomeInitialState } from '@/pages/api/home/home.state';

interface UseFolderOperationsParams {
  folders: FolderInterface[];
  dispatch: React.Dispatch<ActionType<HomeInitialState>>;
}

export const useFolderOperations = ({folders, dispatch}: UseFolderOperationsParams) => {

  const handleCreateFolder = (name: string, type: FolderType) => {
    const newFolder = {
      id: uuidv4(), // Ensure you have uuid imported or an alternative way to generate unique ids
      name,
      type,
    };

    const updatedFolders = [...folders, newFolder];
    dispatch({ field: 'folders', value: updatedFolders });
    saveFolders(updatedFolders); // Assuming you have a utility function to persist folders change
  };

  const handleDeleteFolder = (folderId: string) => {
    const updatedFolders = folders.filter(folder => folder.id !== folderId);
    dispatch({ field: 'folders', value: updatedFolders });
    saveFolders(updatedFolders); // Persist the updated list after deletion
  };

  const handleUpdateFolder = (folderId: string, name: string) => {
    const updatedFolders = folders.map(folder =>
      folder.id === folderId ? { ...folder, name } : folder
    );
    dispatch({ field: 'folders', value: updatedFolders });
    saveFolders(updatedFolders); // Persist the updated list
  };

  return { handleCreateFolder, handleDeleteFolder, handleUpdateFolder };
};
