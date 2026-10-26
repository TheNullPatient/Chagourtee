import { useCallback } from 'react';

interface MessageInputProps {
  sendText: string;
  setSendText: (text: string) => void;
  handleSend: (e: React.FormEvent) => void;
  saveEditedMessage?: () => void;
  isEditing?: boolean;
  editingText?: string;
  setEditingText?: (text: string) => void;
}

export const useMessageInputBehavior = ({ 
  sendText, 
  setSendText, 
  handleSend,
  saveEditedMessage,
  isEditing,
  editingText,
  setEditingText,
}: MessageInputProps) => {
  // Function to detect if the user is on a mobile device
  const isMobileDevice = useCallback((): boolean => {
    return 'ontouchstart' in window || 
           navigator.maxTouchPoints > 0 || 
           window.matchMedia('(pointer: coarse)').matches;
  }, []);

  // Handle key down events for the message input
  const handleKeyDown = useCallback((e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    const isMobile = isMobileDevice();
    
    if (e.key === 'Enter' && (e.shiftKey || e.ctrlKey || e.altKey || isMobile)) {
      e.preventDefault();
      const target = e.target as HTMLTextAreaElement;
      const start = target.selectionStart;
      const end = target.selectionEnd;
      const currentText = isEditing && editingText !== undefined ? editingText : sendText;
      const setter = isEditing && setEditingText ? setEditingText : setSendText;
      const newValue = currentText.substring(0, start) + '\n' + currentText.substring(end);
      setter(newValue);
      
      // Restore cursor position after newline insertion
      setTimeout(() => {
        target.selectionStart = target.selectionEnd = start + 1;
      }, 0);
    } else if (e.key === 'Enter' && !e.shiftKey && !e.ctrlKey && !e.altKey && !isMobile) {
      // Submit form when only Enter is pressed without modifiers on non-mobile devices
      e.preventDefault();
      if (isEditing && saveEditedMessage) {
        saveEditedMessage();
      } else {
        handleSend(e);
      }
    }
  }, [sendText, setSendText, handleSend, saveEditedMessage, isEditing, isMobileDevice, editingText, setEditingText]);

  return {
    handleKeyDown,
    isMobileDevice
  };
};