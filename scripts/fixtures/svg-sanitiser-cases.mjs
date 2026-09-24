export const CLEAN_SVG =
  '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 10"><rect width="10" height="10" fill="#eee"/></svg>'

// The seven historical bypasses from the O-A adversarial review. Keep this one fixture shared by
// the source and compiler-copy gates so a vendored sanitiser cannot quietly drift to a weaker verdict.
export const HISTORICAL_SVG_BYPASSES = [
  {
    name: 'missing whitespace before onload',
    source: '<svg xmlns="x"onload="alert(1)"></svg>'
  },
  {
    name: 'missing whitespace before javascript href',
    source: '<svg xmlns="a"><a title="x"href="javascript:alert(1)">y</a></svg>'
  },
  {
    name: 'missing whitespace before remote image src',
    source: '<svg xmlns="a"><image width="1"src="https://evil/x.png"/></svg>'
  },
  {
    name: 'data image href',
    source: '<svg xmlns="a"><image id="i"href="data:image/svg+xml;base64,AAAA"/></svg>'
  },
  {
    name: 'second iframe root with srcdoc',
    source: '<svg xmlns="a"/><iframe srcdoc="&lt;script&gt;alert(1)&lt;/script&gt;"></iframe>'
  },
  {
    name: 'multiple svg roots',
    source: '<svg><rect/></svg><svg><rect/></svg>'
  },
  {
    name: 'namespaced set mutation',
    source: '<svg xmlns="a"><svg:set attributeName="onload" to="alert(1)"/></svg>'
  }
]
