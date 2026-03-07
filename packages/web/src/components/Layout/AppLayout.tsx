import { ReactNode } from 'react';
import { Link, useLocation } from 'react-router-dom';
import { Home, Settings, Wifi, WifiOff } from 'lucide-react';
import { useWebSocket } from '../../contexts/WebSocketContext';

interface AppLayoutProps {
  children: ReactNode;
}

export default function AppLayout({ children }: AppLayoutProps) {
  const location = useLocation();
  const { isConnected } = useWebSocket();
  const isHome = location.pathname === '/';

  return (
    <div className="min-h-screen bg-dark-900 flex flex-col">
      <header className="sticky top-0 z-50 bg-dark-900 border-b border-dark-800 pt-[env(safe-area-inset-top)]">
        <div className="max-w-7xl mx-auto px-4 h-14 flex items-center justify-between">
          <div className="flex items-center gap-4">
            {!isHome && (
              <Link
                to="/"
                className="p-2 -ml-2 text-dark-400 hover:text-dark-100 transition-colors"
              >
                <Home size={20} />
              </Link>
            )}
            <Link to="/" className="font-semibold text-lg text-dark-100">
              CCManager
            </Link>
          </div>

          <div className="flex items-center gap-3">
            <div
              className={`flex items-center gap-1.5 text-sm ${
                isConnected ? 'text-green-500' : 'text-dark-500'
              }`}
              title={isConnected ? 'Connected' : 'Disconnected'}
            >
              {isConnected ? <Wifi size={16} /> : <WifiOff size={16} />}
            </div>
            <Link
              to="/settings"
              className="p-2 text-dark-400 hover:text-dark-100 transition-colors"
            >
              <Settings size={20} />
            </Link>
          </div>
        </div>
      </header>

      <main className="flex-1">{children}</main>
    </div>
  );
}
