// A published file that collapses in one run is a provider outage, not a real
// change, and the daily job commits unreviewed. The override exists for the
// rare deliberate purge.
const MAX_SHRINK_RATIO = 0.3

interface ShrinkGuard {
  /** Published file name, used in the messages. */
  file: string
  /** What is being counted, e.g. `tokens` or `flagged mints`. */
  unit: string
  previousCount: number
  nextCount: number
  /** Environment variable that downgrades the refusal to a warning. */
  override: string
}

export function assertNoMassiveShrink({ file, unit, previousCount, nextCount, override }: ShrinkGuard): void {
  if (previousCount === 0) return

  const shrinkRatio = 1 - nextCount / previousCount
  if (shrinkRatio <= MAX_SHRINK_RATIO) return

  const percentage = Math.round(shrinkRatio * 100)
  if (process.env[override]) {
    console.warn(`${file} shrank by ${percentage}% — writing anyway because ${override} is set`)
    return
  }

  throw new Error(
    `Refusing to write ${file}: ${unit} dropped from ${previousCount} to ${nextCount} (-${percentage}%). ` +
      `Check whether the source changed under us, then re-run with ${override}=1 if the drop is expected.`,
  )
}
