// src/services/mailer.js
import nodemailer from 'nodemailer'

const {
  SMTP_HOST, SMTP_PORT, SMTP_SECURE,
  SMTP_USER, SMTP_PASS, SMTP_FROM
} = process.env

export const mailer = nodemailer.createTransport({
  host: SMTP_HOST,
  port: Number(SMTP_PORT || 587),
  secure: String(SMTP_SECURE || 'false') === 'true',
  auth: SMTP_USER && SMTP_PASS ? { user: SMTP_USER, pass: SMTP_PASS } : undefined
})

export async function sendDenunciaEmail({ to, cc, subject, text, html }) {
  if (!to) throw new Error('Destino "to" vacío')
  const from = SMTP_FROM || SMTP_USER
  return await mailer.sendMail({ from, to, cc, subject, text, html })
}
