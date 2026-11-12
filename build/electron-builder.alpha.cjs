// Local signed alpha: production security policy, no notarisation or publication.
const production = require('../package.json').build
module.exports = { ...production, extends: null, mac: { ...production.mac, notarize: false }, publish: null }
