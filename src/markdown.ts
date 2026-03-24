/**
 * Markdown conversion utilities for per-channel formatting.
 *
 * - toTelegramHtml: standard markdown → Telegram-safe HTML subset
 * - toEmailHtml:    standard markdown → full HTML for email clients
 */
import { marked, Renderer, Tokens } from 'marked';

// ---------------------------------------------------------------------------
// Telegram HTML converter
// ---------------------------------------------------------------------------

/**
 * Custom renderer that maps standard markdown to the HTML subset Telegram
 * supports: <b>, <i>, <u>, <s>, <code>, <pre>, <a href="">, <blockquote>.
 * Unsupported constructs (headings, images, tables, HR) degrade gracefully.
 */
class TelegramRenderer extends Renderer {
  // Block elements

  heading({ tokens, depth }: Tokens.Heading): string {
    const text = this.parser.parseInline(tokens);
    // Telegram has no heading tags — bold + extra newline for h1
    return depth === 1 ? `<b>${text}</b>\n\n` : `<b>${text}</b>\n`;
  }

  paragraph({ tokens }: Tokens.Paragraph): string {
    return `${this.parser.parseInline(tokens)}\n\n`;
  }

  blockquote({ tokens }: Tokens.Blockquote): string {
    const body = this.parser.parse(tokens);
    return `<blockquote>${body.trimEnd()}</blockquote>\n\n`;
  }

  code({ text, lang }: Tokens.Code): string {
    const escaped = escapeHtml(text);
    return lang
      ? `<pre><code class="language-${lang}">${escaped}</code></pre>\n`
      : `<pre><code>${escaped}</code></pre>\n`;
  }

  list(token: Tokens.List): string {
    return (
      token.items
        .map((item, i) => {
          const marker = token.ordered
            ? `${((token.start as number) || 1) + i}.`
            : '•';
          // Separate inline content from nested lists
          const nestedLists = item.tokens.filter(
            (t) => t.type === 'list',
          ) as Tokens.List[];
          const inlineTokens = item.tokens.filter((t) => t.type !== 'list');
          const text = this.parser.parseInline(inlineTokens);
          const nested = nestedLists.map((n) => this.list(n)).join('');
          if (item.task) {
            return `${item.checked ? '☑' : '☐'} ${text}\n${nested}`;
          }
          return `${marker} ${text}\n${nested}`;
        })
        .join('') + '\n'
    );
  }

  hr(_: Tokens.Hr): string {
    return '\n';
  }

  table(token: Tokens.Table): string {
    // Telegram can't render tables — show as bold header + plain rows
    const headerText = token.header
      .map((cell) => this.parser.parseInline(cell.tokens))
      .join(' | ');
    const rowsText = token.rows
      .map((row) =>
        row.map((cell) => this.parser.parseInline(cell.tokens)).join(' | '),
      )
      .join('\n');
    return `<b>${headerText}</b>\n${rowsText}\n\n`;
  }

  html(_: Tokens.HTML | Tokens.Tag): string {
    // Strip raw HTML pass-through for safety
    return '';
  }

  // Inline elements

  strong({ tokens }: Tokens.Strong): string {
    return `<b>${this.parser.parseInline(tokens)}</b>`;
  }

  em({ tokens }: Tokens.Em): string {
    return `<i>${this.parser.parseInline(tokens)}</i>`;
  }

  del({ tokens }: Tokens.Del): string {
    return `<s>${this.parser.parseInline(tokens)}</s>`;
  }

  codespan({ text }: Tokens.Codespan): string {
    return `<code>${escapeHtml(text)}</code>`;
  }

  link({ href, title, tokens }: Tokens.Link): string {
    const text = this.parser.parseInline(tokens);
    const safeHref = escapeHtmlAttr(href ?? '');
    const titleAttr = title ? ` title="${escapeHtmlAttr(title)}"` : '';
    return `<a href="${safeHref}"${titleAttr}>${text}</a>`;
  }

  image({ title, text }: Tokens.Image): string {
    // Telegram messages don't support inline images — show alt text
    return escapeHtml(text || title || '');
  }

  br(_: Tokens.Br): string {
    return '\n';
  }
}

const telegramRenderer = new TelegramRenderer();

/**
 * Convert standard markdown to Telegram HTML.
 * Telegram HTML mode supports: <b>, <i>, <s>, <code>, <pre>, <a>, <blockquote>.
 */
export function toTelegramHtml(markdown: string): string {
  return (
    marked.parse(markdown, { renderer: telegramRenderer }) as string
  ).trim();
}

// ---------------------------------------------------------------------------
// Email HTML converter
// ---------------------------------------------------------------------------

/**
 * Convert standard markdown to full HTML suitable for email clients.
 * Wraps marked output in a minimal HTML skeleton with basic styling.
 */
export function toEmailHtml(markdown: string): string {
  const body = marked.parse(markdown) as string;
  return `<!DOCTYPE html>
<html>
<head><meta charset="utf-8"></head>
<body style="font-family:sans-serif;line-height:1.6;max-width:680px;margin:0 auto;padding:16px;color:#222">
${body}
</body>
</html>`;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

function escapeHtmlAttr(text: string): string {
  return escapeHtml(text).replace(/"/g, '&quot;');
}
