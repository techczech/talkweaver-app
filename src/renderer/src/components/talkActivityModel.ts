// The time column of the Inspector's Activity list (LOCKED-conflict frame 5): "09:14" today,
// "yesterday 18:40", else "12 Sep 18:40" (with the year outside the current year).

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']

export function activityTime(at: string, now: Date = new Date()): string {
  const d = new Date(at)
  if (Number.isNaN(d.getTime())) return ''
  const hm = `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`
  const day = (x: Date): number => new Date(x.getFullYear(), x.getMonth(), x.getDate()).getTime()
  const days = Math.round((day(now) - day(d)) / 86_400_000)
  if (days === 0) return hm
  if (days === 1) return `yesterday ${hm}`
  const date = `${d.getDate()} ${MONTHS[d.getMonth()]}${d.getFullYear() === now.getFullYear() ? '' : ' ' + d.getFullYear()}`
  return `${date} ${hm}`
}
