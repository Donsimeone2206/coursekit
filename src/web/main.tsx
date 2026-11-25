import './styles.css';
import { QueryCache, QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { RouterProvider } from 'react-router';
import { Toaster } from 'sonner';
import { ConfirmProvider } from './components/ui/confirm';
import { TooltipProvider } from './components/ui/menu';
import { ApiError } from './lib/api';
import { BrandColor, sessionKey } from './lib/session';
import { ThemeProvider, useTheme } from './lib/theme';
import { router } from './router';

const queryClient: QueryClient = new QueryClient({
  defaultOptions: {
    queries: {
      staleTime: 20_000,
      refetchOnWindowFocus: false,
      retry: (count, err) => !(err instanceof ApiError && err.status < 500) && count < 2,
    },
  },
  queryCache: new QueryCache({
    onError: (err, query) => {
      // A 401 from any request means the session ended: refresh it so the app redirects to sign-in.
      if (err instanceof ApiError && err.status === 401 && query.queryKey[0] !== sessionKey[0]) {
        void queryClient.invalidateQueries({ queryKey: sessionKey });
      }
    },
  }),
});

function ThemedToaster() {
  const { resolved } = useTheme();
  return <Toaster theme={resolved} position="bottom-right" richColors closeButton />;
}

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <QueryClientProvider client={queryClient}>
      <ThemeProvider>
        <TooltipProvider>
          <ConfirmProvider>
            <BrandColor />
            <RouterProvider router={router} />
            <ThemedToaster />
          </ConfirmProvider>
        </TooltipProvider>
      </ThemeProvider>
    </QueryClientProvider>
  </StrictMode>,
);
