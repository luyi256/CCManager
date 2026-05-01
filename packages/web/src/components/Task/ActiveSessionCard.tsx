import { motion } from 'framer-motion';
import { Clock, Terminal } from 'lucide-react';
import type { SessionListItem } from '../../services/api';

interface ActiveSessionCardProps {
  session: SessionListItem;
  onClick: () => void;
}

function formatRelativeTime(dateStr: string): string {
  const diff = Date.now() - new Date(dateStr).getTime();
  const mins = Math.floor(diff / 60000);
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.floor(hours / 24)}d ago`;
}

export default function ActiveSessionCard({ session, onClick }: ActiveSessionCardProps) {
  return (
    <motion.div
      layout
      initial={{ opacity: 0, scale: 0.95 }}
      animate={{ opacity: 1, scale: 1 }}
      exit={{ opacity: 0, scale: 0.95 }}
      whileHover={{ scale: 1.02 }}
      whileTap={{ scale: 0.98 }}
      className="card p-3 cursor-pointer transition-all border-green-500/40 border-dashed"
      onClick={onClick}
    >
      <div className="flex items-start justify-between gap-2 mb-2">
        <span className="flex items-center gap-1 text-xs text-dark-500">
          <Terminal size={12} />
          CLI Session
        </span>
        <span className="relative flex h-2.5 w-2.5 shrink-0 mt-0.5">
          <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-green-400 opacity-75" />
          <span className="relative inline-flex rounded-full h-2.5 w-2.5 bg-green-500" />
        </span>
      </div>

      <p className="text-sm text-dark-200 line-clamp-2 mb-2">{session.firstPrompt}</p>

      <div className="flex items-center gap-3 text-xs text-dark-500">
        <span className="flex items-center gap-1">
          <Clock size={12} />
          {formatRelativeTime(session.lastModified)}
        </span>
      </div>
    </motion.div>
  );
}
