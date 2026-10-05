/** Money is always an integer number of centavos. PHP 999.00 = 99900. */
export type Centavos = number;

const PESO_PATTERN = /^(-)?(\d+)(?:\.(\d{1,2}))?$/;

export function assertCentavos(
  value: number,
  label = "amount",
): asserts value is Centavos {
  if (!Number.isSafeInteger(value)) {
    throw new RangeError(
      `${label} must be a safe integer number of centavos, got ${value}`,
    );
  }
}

/** Parse "999", "999.5", "1,000.50" or "₱999.00" into centavos. No floats involved. */
export function parsePesos(input: string): Centavos {
  const cleaned = input.trim().replace(/^₱/, "").replace(/,/g, "");
  const match = PESO_PATTERN.exec(cleaned);
  if (!match) {
    throw new RangeError(`Invalid peso amount: "${input}"`);
  }
  const sign = match[1] === "-" ? -1 : 1;
  const whole = match[2] ?? "0";
  const fraction = (match[3] ?? "").padEnd(2, "0");

  const centavos = Number(whole) * 100 + Number(fraction);
  assertCentavos(centavos, "amount");
  return centavos === 0 ? 0 : sign * centavos;
}

export function addCentavos(a: Centavos, b: Centavos): Centavos {
  assertCentavos(a);
  assertCentavos(b);
  const result = a + b;
  assertCentavos(result, "sum");
  return result;
}

export function subtractCentavos(a: Centavos, b: Centavos): Centavos {
  assertCentavos(a);
  assertCentavos(b);
  const result = a - b;
  assertCentavos(result, "difference");
  return result;
}

/** Format centavos for display: 123456789 -> "₱1,234,567.89". */
export function formatPesos(value: Centavos): string {
  assertCentavos(value);
  const negative = value < 0;
  const abs = Math.abs(value);
  const whole = Math.trunc(abs / 100);
  const fraction = String(abs % 100).padStart(2, "0");
  const grouped = whole.toString().replace(/\B(?=(\d{3})+(?!\d))/g, ",");
  return `${negative ? "-" : ""}₱${grouped}.${fraction}`;
}