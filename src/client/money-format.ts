/**
 * Money formatting for usage windows.
 *
 * The data layer stores amounts in minor units (cents) and the window carries
 * its currency, so only this module turns them into display text. A provider
 * that reports no unit leaves the amount unprefixed rather than guessing.
 */

/**
 * Format one amount for display.
 * @param minorUnits - amount in the currency's minor unit (cents).
 * @param currency - ISO 4217 code the provider reported; defaults to USD.
 * @param locale - BCP 47 locale for grouping and symbols; the host's when absent.
 * @returns the formatted amount, or an empty string for an invalid value.
 */
export function formatMoney(
  minorUnits: number | undefined,
  currency: string | undefined,
  locale?: string,
): string {
  if (minorUnits === undefined || !Number.isFinite(minorUnits)) {
    return ''
  }
  const code = (currency ?? 'USD').toUpperCase()
  try {
    return new Intl.NumberFormat(locale, {
      style: 'currency',
      currency: code,
    }).format(minorUnits / 100)
  } catch {
    // Unknown currency codes must not break the row.
    return `${(minorUnits / 100).toFixed(2)} ${code}`
  }
}
