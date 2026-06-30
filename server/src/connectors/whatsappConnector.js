import { parseWhatsappUpload } from '../whatsappParser.js';

export function syncWhatsappUpload(file) {
  const parsed = parseWhatsappUpload(file);
  if (!parsed.ok) {
    return {
      ok: false,
      status: 'failed',
      source: 'WhatsApp export parser',
      parserVersion: '0.2.33',
      capturedAt: new Date().toISOString(),
      errors: parsed.errors || [parsed.error || 'WhatsApp upload could not be parsed.'],
      warnings: parsed.warnings || [],
      diagnostics: parsed.diagnostics || {},
      parsed
    };
  }

  return {
    ok: true,
    status: 'success',
    source: 'WhatsApp export parser',
    parserVersion: '0.2.33',
    capturedAt: new Date().toISOString(),
    summary: parsed,
    actions: parsed.actions || [],
    warnings: parsed.warnings || [],
    diagnostics: parsed.diagnostics || {},
    notes: 'V33 parser supports iPhone/Android .txt exports, .zip exports with nested folders, UTF-8/UTF-16 text, multi-line messages, media placeholders, stock, sell-out, leftover and ops signals.'
  };
}

export function whatsappDiagnostics() {
  return {
    source: 'WhatsApp export parser',
    status: 'available',
    parserVersion: '0.2.33',
    normalWorkflow: 'Upload WhatsApp export .txt/.zip. V33 extracts the chat text even when it is nested inside the ZIP and returns explicit diagnostics if the ZIP contains only media.',
    acceptedUploads: ['.txt', '.zip containing _chat.txt or another WhatsApp .txt export'],
    parsedSignals: [
      'sell-out time',
      'leftover / waste notes',
      'stock usage and stock requests',
      'product hints and quantities',
      'store names',
      'photo/media placeholders',
      'urgent manager actions'
    ],
    notes: [
      'Photo OCR is still not enabled; V33 records photo/media references as actions for manager follow-up.',
      'If no .txt file is present in the ZIP, the parser returns the ZIP entry list in diagnostics instead of failing silently.'
    ]
  };
}
