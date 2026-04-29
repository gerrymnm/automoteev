/// <reference types="vite/client" />

interface Window {
  Plaid?: {
    create: (config: {
      token: string;
      onSuccess: (publicToken: string) => void;
      onExit?: (error: unknown) => void;
    }) => { open: () => void };
  };
}
