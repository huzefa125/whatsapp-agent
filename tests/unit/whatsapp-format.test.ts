import { describe, it, expect } from 'vitest';
import { toWhatsAppFormat } from '../../src/utils/whatsapp-format';

describe('toWhatsAppFormat', () => {
  it('converts markdown bold to WhatsApp bold', () => {
    expect(toWhatsAppFormat('at **12:31 PM** now')).toBe('at *12:31 PM* now');
  });

  it('converts headings, bullets, strike and links', () => {
    const out = toWhatsAppFormat('## Plan\n- one\n* two\n~~old~~ [site](https://a.com)');
    expect(out).toBe('*Plan*\n• one\n• two\n~old~ site (https://a.com)');
  });

  it('leaves fenced code untouched', () => {
    expect(toWhatsAppFormat('```\n**x**\n```')).toBe('```\n**x**\n```');
  });

  it('leaves single-asterisk WhatsApp bold alone', () => {
    expect(toWhatsAppFormat('*hi* there')).toBe('*hi* there');
  });
});
