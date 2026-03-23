import { Prompt } from '@/types/prompt';
import { setUserSessionItem } from './storage';

export const updatePrompt = (updatedPrompt: Prompt, allPrompts: Prompt[]) => {
  const updatedPrompts = allPrompts.map((c) => {
    if (c.id === updatedPrompt.id) {
      return updatedPrompt;
    }

    return c;
  });

  savePrompts(updatedPrompts);

  return {
    single: updatedPrompt,
    all: updatedPrompts,
  };
};

export const savePrompts = (prompts: Prompt[]) => {
  // Use user-specific storage key to prevent data leakage between users
  setUserSessionItem('prompts', JSON.stringify(prompts));
};
