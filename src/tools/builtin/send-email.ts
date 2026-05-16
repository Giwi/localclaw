import type { ToolModule } from '../types.js'
import { log } from '../../log.js'

const MAILGUN_API_KEY = process.env.LOCALCLAW_MAILGUN_API_KEY
const MAILGUN_DOMAIN = process.env.LOCALCLAW_MAILGUN_DOMAIN
const MAILGUN_FROM = process.env.LOCALCLAW_MAILGUN_FROM || `localclaw <mailgun@${MAILGUN_DOMAIN}>`

export const sendEmailTool: ToolModule = {
  definition: {
    name: 'send_email',
    description: 'Send an email using Mailgun. Use this to deliver content like news summaries, reports, or notifications to an email address.',
    parameters: {
      type: 'object',
      properties: {
        to: { type: 'string', description: 'Recipient email address' },
        subject: { type: 'string', description: 'Email subject line' },
        body: { type: 'string', description: 'Email body text (plain text, supports simple formatting)' },
        html: { type: 'string', description: 'Optional HTML version of the email body' },
      },
      required: ['to', 'subject', 'body'],
    },
  },
  execute: async (args, onChunk) => {
    if (!MAILGUN_API_KEY) {
      return 'Mailgun API key not configured. Set LOCALCLAW_MAILGUN_API_KEY in .env'
    }
    if (!MAILGUN_DOMAIN) {
      return 'Mailgun domain not configured. Set LOCALCLAW_MAILGUN_DOMAIN in .env'
    }

    const to = (args.to || '').trim()
    const subject = (args.subject || '').trim()
    const body = (args.body || '').trim()
    const html = (args.html || '').trim()

    if (!to) return 'Please provide a "to" email address.'
    if (!subject) return 'Please provide a "subject" for the email.'
    if (!body) return 'Please provide a "body" for the email.'

    onChunk?.(`Sending email to ${to}...`)

    const form = new URLSearchParams()
    form.append('from', MAILGUN_FROM)
    form.append('to', to)
    form.append('subject', subject)
    form.append('text', body)
    if (html) form.append('html', html)

    try {
      const res = await fetch(`https://api.mailgun.net/v3/${MAILGUN_DOMAIN}/messages`, {
        method: 'POST',
        headers: {
          Authorization: `Basic ${Buffer.from(`api:${MAILGUN_API_KEY}`).toString('base64')}`,
          'Content-Type': 'application/x-www-form-urlencoded',
        },
        body: form.toString(),
      })

      const data = await res.json().catch(() => ({ message: res.statusText }))

      if (res.ok) {
        onChunk?.('Email sent successfully!')
        log.agent(`Email sent to ${to}: "${subject}" (id: ${data.id?.slice(0, 20) || 'unknown'})`)
        return `Email sent successfully to ${to} with subject "${subject}". Mailgun message ID: ${data.id || 'unknown'}`
      } else {
        log.agent(`Email sending failed: ${data.message || res.statusText}`)
        return `Failed to send email: ${data.message || res.statusText}. Note: sandbox domains require authorized recipients — add ${to} in Mailgun dashboard > Sending > Authorized Recipients.`
      }
    } catch (err: any) {
      log.agent(`Email sending error: ${err.message}`)
      return `Email sending error: ${err.message}`
    }
  },
}
