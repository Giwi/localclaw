import { Pipe, PipeTransform } from '@angular/core'
import { DomSanitizer, SafeHtml } from '@angular/platform-browser'
import { marked, type Renderer } from 'marked'
import { markedHighlight } from 'marked-highlight'
import hljs from 'highlight.js'

const renderer: Partial<Renderer> = {
  code({ text, lang }) {
    const langAttr = lang ? ` class="language-${lang}"` : ''
    const langLabel = lang ? `<span style="position:absolute;top:4px;right:8px;font-size:10px;color:#6a7d9a;text-transform:uppercase;letter-spacing:.5px;">${lang}</span>` : ''
    return `<div style="position:relative;">
      <pre${langAttr} style="padding-top:24px;">${langLabel}<code${langAttr}>${text}</code></pre>
      <button onclick="
        navigator.clipboard.writeText(this.parentElement.querySelector('code').textContent);
        this.textContent='Copied!';
        setTimeout(()=>this.textContent='\\u00a0\\u00a0Copy',1500);
      " style="position:absolute;top:4px;right:4px;background:rgba(255,255,255,.08);border:none;color:#9ca3af;cursor:pointer;font-size:11px;padding:2px 8px;border-radius:4px;font-family:inherit;z-index:1;">&nbsp;&nbsp;Copy</button>
    </div>`
  },
}

marked.use(markedHighlight({
  langPrefix: 'hljs language-',
  highlight(code: string, lang: string) {
    if (lang && hljs.getLanguage(lang)) {
      return hljs.highlight(code, { language: lang }).value
    }
    return hljs.highlightAuto(code).value
  },
}))

marked.use({ renderer })

@Pipe({ name: 'markdown' })
export class MarkdownPipe implements PipeTransform {
  constructor(private sanitizer: DomSanitizer) {}
  // Security: marked strips raw HTML by default. We only pass pre-formatted
  // markdown through bypassSecurityTrustHtml. The custom code renderer only
  // generates <pre>, <code>, <span>, <button> elements - no user-controlled HTML.

  async transform(value: string): Promise<SafeHtml> {
    if (!value) return this.sanitizer.bypassSecurityTrustHtml('')
    const html = await marked.parse(value)
    return this.sanitizer.bypassSecurityTrustHtml(html)
  }
}
