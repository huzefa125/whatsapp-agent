/**
 * Country calling code -> IANA timezone, ONLY for countries that have a single timezone for practical purposes.
 * Multi-timezone codes (+1 US/Canada, +7 Russia/Kazakhstan, +55 Brazil, +61 Australia, +52 Mexico, +62 Indonesia, ...)
 * are deliberately absent: a wrong guess would silently fire reminders at the wrong time.
 */
const SINGLE_ZONE: Record<string, string> = {
  '91': 'Asia/Kolkata', '44': 'Europe/London', '971': 'Asia/Dubai', '966': 'Asia/Riyadh', '92': 'Asia/Karachi',
  '880': 'Asia/Dhaka', '94': 'Asia/Colombo', '977': 'Asia/Kathmandu', '65': 'Asia/Singapore', '60': 'Asia/Kuala_Lumpur',
  '66': 'Asia/Bangkok', '84': 'Asia/Ho_Chi_Minh', '63': 'Asia/Manila', '81': 'Asia/Tokyo', '82': 'Asia/Seoul',
  '86': 'Asia/Shanghai', '852': 'Asia/Hong_Kong', '886': 'Asia/Taipei', '33': 'Europe/Paris', '49': 'Europe/Berlin',
  '39': 'Europe/Rome', '31': 'Europe/Amsterdam', '41': 'Europe/Zurich', '46': 'Europe/Stockholm', '353': 'Europe/Dublin',
  '90': 'Europe/Istanbul', '20': 'Africa/Cairo', '27': 'Africa/Johannesburg', '234': 'Africa/Lagos', '254': 'Africa/Nairobi',
  '972': 'Asia/Jerusalem', '974': 'Asia/Qatar', '968': 'Asia/Muscat', '965': 'Asia/Kuwait', '973': 'Asia/Bahrain',
  '64': 'Pacific/Auckland', '54': 'America/Argentina/Buenos_Aires', '57': 'America/Bogota', '51': 'America/Lima',
  '56': 'America/Santiago',
};

/** A SUGGESTION from an E.164 number (e.g. "+919876543210"), or null when the country spans several timezones. */
export function suggestTimezoneFromPhone(e164: string): string | null {
  const digits = e164.replace(/\D/g, '');
  for (const len of [3, 2]) {
    const zone = SINGLE_ZONE[digits.slice(0, len)];
    if (zone) return zone;
  }
  return null;
}
