import { IconFileExport, IconSettings, IconLogout, IconHelp } from '@tabler/icons-react';
import { useContext, useState } from 'react';

import { useTranslation } from 'next-i18next';

import HomeContext from '@/pages/api/home/home.context';

import { SettingDialog } from '@/components/Settings/SettingDialog';
import { HelpDialog } from '@/components/Help/HelpDialog';
import { useAuth } from '@/components/Auth/AuthProvider';

import { SidebarButton } from '../../Sidebar/SidebarButton';
import ChatbarContext from '../Chatbar.context';
import { ClearConversations } from './ClearConversations';

export const ChatbarSettings = () => {
  const { t } = useTranslation('sidebar');
  const [isSettingDialogOpen, setIsSettingDialog] = useState<boolean>(false);
  const [isHelpDialogOpen, setIsHelpDialogOpen] = useState<boolean>(false);
  const { logout, user } = useAuth();

  const {
    state: {
      lightMode,
      conversations,
    },
    dispatch: homeDispatch,
  } = useContext(HomeContext);

  const {
    handleClearConversations,
    handleExportData,
  } = useContext(ChatbarContext);

  return (
    <div className="flex flex-col items-center space-y-1 border-t border-white/10 pt-1 text-sm">
      {conversations.length > 0 ? (
        <ClearConversations onClearConversations={handleClearConversations} />
      ) : null}

      <SidebarButton
        text={t('Export data')}
        icon={<IconFileExport size={18} />}
        onClick={() => handleExportData()}
      />

      <SidebarButton
        text={t('Settings')}
        icon={<IconSettings size={18} />}
        onClick={() => setIsSettingDialog(true)}
      />

      <SidebarButton
        text={t('Help')}
        icon={<IconHelp size={18} />}
        onClick={() => setIsHelpDialogOpen(true)}
      />

      {user && (
        <>
          <div className="w-full border-t border-white/10 pt-1">
            <div className="px-3 py-2 text-xs text-white/40">
              Logged in as: <span className="text-white/80 font-medium">{user.name}</span>
            </div>
          </div>
          <SidebarButton
            text={t('Logout')}
            icon={<IconLogout size={18} />}
            onClick={logout}
          />
        </>
      )}

      <SettingDialog
        open={isSettingDialogOpen}
        onClose={() => {
          setIsSettingDialog(false);
        }}
      />

      <HelpDialog
        open={isHelpDialogOpen}
        onClose={() => {
          setIsHelpDialogOpen(false);
        }}
      />
    </div>
  );
};
