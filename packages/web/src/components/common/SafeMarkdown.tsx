import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import remarkMath from 'remark-math';
import rehypeKatex from 'rehype-katex';
import { AlertTriangle } from 'lucide-react';
import 'katex/dist/katex.min.css';

interface SafeMarkdownProps {
  children: string;
  className?: string;
}

function normalizeMathDelimiters(markdown: string): string {
  return markdown
    .split(/(```[\s\S]*?```)/g)
    .map((part, index) => {
      if (index % 2 === 1) return part;
      return part
        .replace(/\\\[([\s\S]*?)\\\]/g, (_match, formula: string) => `\n$$\n${formula.trim()}\n$$\n`)
        .replace(/\\\(([\s\S]*?)\\\)/g, (_match, formula: string) => `$${formula.trim()}$`);
    })
    .join('');
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
      <div className={`markdown-content overflow-hidden ${className || ''}`}>
        <ReactMarkdown
          remarkPlugins={[remarkGfm, remarkMath]}
          rehypePlugins={[[rehypeKatex, { strict: false, trust: false }]]}
          disallowedElements={['script', 'iframe', 'object', 'embed']}
          unwrapDisallowed
          components={{
            a: ({ children: c, ...props }) => (
              <a {...props} target="_blank" rel="noopener noreferrer">{c}</a>
            ),
            img: ({ alt, ...props }) => (
              <img {...props} alt={alt || ''} loading="lazy" />
            ),
            pre: ({ children: c, ...props }) => (
              <pre className="overflow-x-auto" {...props}>{c}</pre>
            ),
            code: ({ children: c, ...props }) => (
              <code className="break-words" {...props}>{c}</code>
            ),
          }}
        >
          {normalizeMathDelimiters(children)}
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
