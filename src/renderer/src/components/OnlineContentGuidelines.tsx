import { ONLINE_CONTENT_GUIDELINES_HTML } from '../../../../compiler/scripts/lib/online-content-guidelines.mjs'

/** Bundled, trusted public Markdown only. Reports use the existing fixed-link
 * route, without passing any talk, credentials, logs or other attachments. */
export default function OnlineContentGuidelines() {
  return <div className="guide-card guide-online-content"
    onClick={(event) => {
      if ((event.target as Element).closest('a[data-online-content-report]')) {
        event.preventDefault()
        void window.tw.guide.openLink('online-content-report')
      }
    }}
    dangerouslySetInnerHTML={{ __html: ONLINE_CONTENT_GUIDELINES_HTML }} />
}
