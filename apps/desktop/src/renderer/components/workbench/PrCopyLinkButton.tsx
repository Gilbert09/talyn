import { useState } from 'react';
import { Check, Copy, Link } from 'lucide-react';
import { Button } from '../ui/button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '../ui/dropdown-menu';
import { copyRich, prMarkdownLink } from '../../lib/prClipboard';
import { toast } from '../../stores/toast';

/**
 * The session header's PR copy menu: the plain link, or a Markdown link with
 * the PR title (rich HTML too, so a paste into Slack or a doc is a link).
 */
export function PrCopyLinkButton({ number, title, url }: { number: number; title: string; url: string }) {
  const [copied, setCopied] = useState(false);

  const copy = async (write: () => Promise<void>) => {
    try {
      await write();
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1500);
    } catch {
      toast.error('Could not copy to clipboard');
    }
  };

  const copyLink = () => void copy(() => navigator.clipboard.writeText(url));
  const copyMarkdown = () => {
    const { markdown, html } = prMarkdownLink(title, url);
    void copy(() => copyRich(html, markdown));
  };

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button
          variant="ghost"
          className="h-7 w-7 shrink-0 p-0"
          title={copied ? 'Copied!' : `Copy the link to #${number}`}
          aria-label={`Copy the link to #${number}`}
          data-attr="workbench-copy-pr-link"
        >
          {copied ? <Check className="h-3.5 w-3.5 text-success" /> : <Copy className="h-3.5 w-3.5" />}
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end">
        <DropdownMenuItem onSelect={copyLink} data-attr="workbench-copy-pr-url">
          <Link className="mr-2 h-3.5 w-3.5" />
          Copy link
        </DropdownMenuItem>
        <DropdownMenuItem onSelect={copyMarkdown} data-attr="workbench-copy-pr-markdown">
          <Copy className="mr-2 h-3.5 w-3.5" />
          Copy as Markdown link
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
