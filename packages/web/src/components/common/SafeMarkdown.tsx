import ReactMarkdown from 'react-markdown';
import { AlertTriangle } from 'lucide-react';

interface SafeMarkdownProps {
  children: string;
  className?: string;
}

export default function SafeMarkdown({ children, className }: SafeMarkdownProps) {
  // Validate input
  if (typeof children !== 'string') {
    return (
      <div className="text-red-400 text-sm flex items-center gap-1">
        <AlertTriangle size={14} />
        Invalid content
      </div>
    );
  }

  try {
    return (
      <div className={`overflow-hidden ${className || ''}`}>
        <ReactMarkdown
          disallowedElements={['script', 'iframe', 'object', 'embed']}
          unwrapDisallowed
          components={{
            pre: ({ children: c, ...props }) => (
              <pre className="whitespace-pre-wrap break-words overflow-x-auto" {...props}>{c}</pre>
            ),
            code: ({ children: c, ...props }) => (
              <code className="break-words" {...props}>{c}</code>
            ),
          }}
        >
          {children}
        </ReactMarkdown>
      </div>
    );
  } catch (error) {
    console.error('SafeMarkdown render error:', error);
    return (
      <div className="text-dark-400 text-sm">
        <pre className="whitespace-pre-wrap break-words">{children}</pre>
      </div>
    );
  }
}
