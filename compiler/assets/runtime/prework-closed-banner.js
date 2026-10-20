// The closed handout (feedback-boards ticket 10, drawing round-2 W12): a banner over the slide list.
// Self-contained like every runtime function the page embeds by `.toString()` (see work-page.js).
import { preworkIcons, preworkWhen } from './prework-form-model.js'

/**
 * The closed handout (W12): a banner above the slide list saying so, with how many people took part.
 * `mounts` are the elements the banner is written into (one above the list on a laptop, one at the top of
 * the phone list); each gets its own copy. Text only.
 * `options.phase` 'post' names post-work; `options.after` replaces the last sentence (the participant work page,
 * which has no slide list below, says where the handout is).
 * @param {any} document @param {any[]} mounts @param {{ state: string, closesAt: number, people?: number }} status @param {string} [timeZone]
 * @param {{ phase?: 'pre'|'post', after?: string }} [options]
 */
export function showPreworkClosed(document, mounts, status, timeZone, options) {
  const opts = options || {}
  const when = preworkWhen(status.closesAt, timeZone).replace(/ (\d\d:\d\d)$/, ' at $1')
  const people = Number.isSafeInteger(status.people) ? status.people : null
  for (const mount of mounts) {
    if (!mount) continue
    mount.textContent = ''
    const box = document.createElement('div')
    box.className = 'pw-closed'
    box.setAttribute('role', 'status')
    const ico = document.createElement('span')
    ico.className = 'pw-ico'
    ico.innerHTML = '<svg class="lucide" xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' + preworkIcons().lock + '</svg>'
    const text = document.createElement('div')
    const head = document.createElement('p')
    head.className = 'pw-closed-head'
    head.textContent = (opts.phase === 'post' ? 'Post-work' : 'Pre-work') + ' closed'
    const line = document.createElement('p')
    line.className = 'pw-closed-line'
    line.textContent = 'It closed on ' + when + '.' + (people === null ? '' : ' ' + people + (people === 1 ? ' person' : ' people') + ' took part.') + ' ' + (typeof opts.after === 'string' ? opts.after : 'The session\u2019s slides are below.')
    text.appendChild(head)
    text.appendChild(line)
    box.appendChild(ico)
    box.appendChild(text)
    mount.appendChild(box)
    mount.hidden = false
  }
}

export function preworkClosedBannerSource() {
  return showPreworkClosed.toString()
}
