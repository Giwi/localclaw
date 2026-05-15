import { Pipe, PipeTransform } from '@angular/core'
import { DomSanitizer, SafeHtml } from '@angular/platform-browser'
import { marked } from 'marked'

@Pipe({ name: 'markdown' })
export class MarkdownPipe implements PipeTransform {
  constructor(private sanitizer: DomSanitizer) {}

  async transform(value: string): Promise<SafeHtml> {
    if (!value) return this.sanitizer.bypassSecurityTrustHtml('')
    const html = await marked.parse(value)
    return this.sanitizer.bypassSecurityTrustHtml(html)
  }
}
