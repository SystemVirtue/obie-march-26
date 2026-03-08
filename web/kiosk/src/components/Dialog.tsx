import React from 'react';

interface DialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  children: React.ReactNode;
}

interface DialogContentProps {
  className?: string;
  children: React.ReactNode;
}

export const Dialog: React.FC<DialogProps> = ({ open, onOpenChange, children }) => {
  if (!open) return null;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50" onClick={() => onOpenChange(false)}>
      <div className="max-h-[100vh] max-w-[100vw]" onClick={(e) => e.stopPropagation()}>
        {children}
      </div>
    </div>
  );
};

export const DialogContent: React.FC<DialogContentProps> = ({ className, children }) => {
  return (
    <div className={`bg-slate-800 border border-slate-600 rounded-lg shadow-lg ${className}`}>
      {children}
    </div>
  );
};