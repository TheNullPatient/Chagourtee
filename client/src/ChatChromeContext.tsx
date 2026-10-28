import { createContext, useContext, useState, ReactNode } from 'react';

export type ChatLockAction = {
  /** Tooltip/title for the header lock button. */
  title: string;
  /** True while the lock request is in flight. */
  busy: boolean;
  onLock: () => void;
};

type ChatChromeContextValue = {
  lockAction: ChatLockAction | null;
  setLockAction: (action: ChatLockAction | null) => void;
};

const ChatChromeContext = createContext<ChatChromeContextValue | undefined>(undefined);

/**
 * Lets the chat page expose a lock button in the mobile/tablet header, which is
 * rendered by Layout rather than by the chat itself.
 */
export function ChatChromeProvider({ children }: { children: ReactNode }) {
  const [lockAction, setLockAction] = useState<ChatLockAction | null>(null);

  return (
    <ChatChromeContext.Provider value={{ lockAction, setLockAction }}>
      {children}
    </ChatChromeContext.Provider>
  );
}

export function useChatChrome(): ChatChromeContextValue {
  const ctx = useContext(ChatChromeContext);
  if (!ctx) {
    throw new Error('useChatChrome must be used within a ChatChromeProvider');
  }
  return ctx;
}
