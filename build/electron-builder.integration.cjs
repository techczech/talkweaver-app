// Local production-flavour qualification: production fuses and signing, no publication/notarisation.
const production = require('../package.json').build
module.exports = { ...production, extends: null, mac: { ...production.mac, notarize: false }, directories: { ...production.directories, output: 'release-integration' }, publish: null }
